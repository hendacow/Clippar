"""
run_pipeline.py — Per-job pipeline: download → detect → merge
Called as a subprocess by worker.py:  python run_pipeline.py <job_id>
"""

import os
import sys
import tempfile
from pathlib import Path

import db


def _use_r2():
    return bool(os.environ.get("R2_ENDPOINT"))


def run(job_id):
    job = db.get_job(job_id)
    if not job:
        print(f"[Pipeline] Job {job_id} not found")
        sys.exit(1)

    # Use temp directory for processing (works on both local and Railway)
    if _use_r2():
        job_dir = Path(tempfile.mkdtemp(prefix=f"clippar_{job_id}_"))
    else:
        job_dir = Path("jobs") / job_id

    inputs_dir = job_dir / "inputs"
    outputs_clips = job_dir / "outputs" / "clips"
    merged_output = job_dir / "outputs" / "merged" / "highlight_reel.mov"

    inputs_dir.mkdir(parents=True, exist_ok=True)
    outputs_clips.mkdir(parents=True, exist_ok=True)
    merged_output.parent.mkdir(parents=True, exist_ok=True)

    # ── 1. Get input files ──
    if _use_r2():
        import storage
        # Download inputs from R2
        r2_files = storage.list_files(f"jobs/{job_id}/inputs/")
        if r2_files:
            print(f"[Pipeline] Downloading {len(r2_files)} file(s) from R2")
            for key in r2_files:
                filename = key.split("/")[-1]
                storage.download_file(key, str(inputs_dir / filename))
        elif job.get("drive_link"):
            print(f"[Pipeline] Downloading from Drive: {job['drive_link']}")
            db.update_job(job_id, status="downloading")
            from drive_utils import download_from_drive
            try:
                download_from_drive(job["drive_link"], str(inputs_dir))
            except Exception as e:
                db.update_job(job_id, status="download_failed", error_message=str(e))
                sys.exit(1)
        else:
            db.update_job(job_id, status="download_failed", error_message="No files in R2 and no Drive link")
            sys.exit(1)
    else:
        existing_inputs = list(inputs_dir.glob("*.MOV")) + list(inputs_dir.glob("*.mov")) + \
                          list(inputs_dir.glob("*.mp4")) + list(inputs_dir.glob("*.MP4"))
        if existing_inputs:
            print(f"[Pipeline] Found {len(existing_inputs)} uploaded file(s), skipping download")
        elif job.get("drive_link"):
            print(f"[Pipeline] Downloading from Drive: {job['drive_link']}")
            db.update_job(job_id, status="downloading")
            from drive_utils import download_from_drive
            try:
                download_from_drive(job["drive_link"], str(inputs_dir))
            except Exception as e:
                db.update_job(job_id, status="download_failed", error_message=str(e))
                sys.exit(1)
        else:
            db.update_job(job_id, status="download_failed", error_message="No files uploaded and no Drive link")
            sys.exit(1)

    # ── 2. Run shot detection ──
    print("[Pipeline] Running shot detection...")
    db.update_job(job_id, status="processing")

    from shot_detector import load_config
    cfg = load_config()

    # Override paths for this job
    cfg["clips_dir"] = str(inputs_dir)
    cfg["output_dir"] = str(outputs_clips)
    cfg["fast_mode"] = True
    cfg["display"] = False
    cfg["save_annotated"] = False
    cfg["verbose"] = False

    from shot_detector import detect_shots
    try:
        detect_shots(cfg)
    except SystemExit:
        db.update_job(job_id, status="processing_failed", error_message="detect_shots exited")
        sys.exit(1)

    # Count clips produced
    clip_files = list(outputs_clips.glob("*.mov")) + list(outputs_clips.glob("*.mp4"))
    clip_count = len(clip_files)
    db.update_job(job_id, clip_count=clip_count)

    if clip_count == 0:
        db.update_job(job_id, status="processing_failed", error_message="No shots detected")
        sys.exit(1)

    # ── 3. Merge clips ──
    print("[Pipeline] Merging clips...")
    import subprocess as _sp
    merge_result = _sp.run(
        [sys.executable, "-c",
         f"""
import sys
from merge_clips import load_config, merge
cfg = load_config()
cfg["shots_dir"] = "{outputs_clips}"
cfg["merged_output"] = "{merged_output}"
cfg["include_no_detection"] = True
merge(cfg)
"""],
        capture_output=True, text=True,
    )
    print(merge_result.stdout)
    if merge_result.returncode != 0:
        err = (merge_result.stderr or merge_result.stdout or "Unknown merge error")[-500:]
        print(f"[Pipeline] Merge failed:\n{err}")
        db.update_job(job_id, status="processing_failed", error_message=f"merge failed: {err}")
        sys.exit(1)

    if not merged_output.exists():
        db.update_job(job_id, status="processing_failed", error_message="merge produced no output file")
        sys.exit(1)

    # ── 4. Transcode to mp4 for browser preview ──
    mp4_output = merged_output.with_suffix(".mp4")
    print("[Pipeline] Transcoding to mp4 for browser preview...")
    tc = _sp.run([
        "ffmpeg", "-y", "-i", str(merged_output),
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-movflags", "+faststart",
        str(mp4_output),
    ], capture_output=True, text=True)
    if tc.returncode != 0:
        print(f"[Pipeline] mp4 transcode warning: {tc.stderr[-300:]}")

    # ── 5. Upload results to R2 if configured ──
    if _use_r2():
        import storage
        print("[Pipeline] Uploading results to R2...")
        for output_file in [merged_output, mp4_output]:
            if output_file.exists():
                key = f"jobs/{job_id}/outputs/merged/{output_file.name}"
                storage.upload_file(str(output_file), key)
                print(f"[Pipeline] Uploaded {key}")

        # Upload individual clips too (for potential future use)
        for clip in clip_files:
            key = f"jobs/{job_id}/outputs/clips/{clip.name}"
            storage.upload_file(str(clip), key)

        # Clean up temp directory
        import shutil
        shutil.rmtree(str(job_dir), ignore_errors=True)
        print(f"[Pipeline] Cleaned up temp dir {job_dir}")

    db.update_job(job_id, status="ready_for_review")
    print(f"[Pipeline] Job {job_id} ready for review — {clip_count} clip(s)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python run_pipeline.py <job_id>")
        sys.exit(1)
    run(sys.argv[1])
