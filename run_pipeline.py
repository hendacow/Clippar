"""
run_pipeline.py — Per-job pipeline: download → detect → merge → post-process → upload
Called as a subprocess by worker.py:  python run_pipeline.py <job_id>

The primary path dispatches to Modal GPU which runs the FULL shot_detector.py
logic (4-state machine, PuttVeto, audio, ball tracking, etc.) with parallel
downloads + NVENC encoding.

Fallback: if Modal is unavailable, runs locally with the same logic.
"""

import os
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import db


def _use_r2():
    return bool(os.environ.get("R2_ENDPOINT"))


def _download_from_supabase(job_id, inputs_dir, supabase_url, supabase_key):
    """Download clips from Supabase Storage in parallel. Returns count."""
    import requests

    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
    }

    list_resp = requests.post(
        f"{supabase_url}/storage/v1/object/list/clips",
        headers={**headers, "Content-Type": "application/json"},
        json={"prefix": f"{job_id}/", "limit": 100},
    )
    if list_resp.status_code != 200:
        return 0

    files = [
        f for f in list_resp.json()
        if f.get("name", "").endswith((".mp4", ".mov", ".MP4", ".MOV"))
    ]
    if not files:
        return 0

    total_files = len(files)
    print(f"[Pipeline] Downloading {total_files} clip(s) from Supabase Storage (parallel)")
    db.update_job(job_id, status="downloading", progress=5,
                  stage_detail=f"Downloading {total_files} clips...")

    def _dl(idx_f):
        idx, f = idx_f
        file_key = f"{job_id}/{f['name']}"
        dl_resp = requests.get(
            f"{supabase_url}/storage/v1/object/clips/{file_key}",
            headers=headers, timeout=120,
        )
        if dl_resp.status_code == 200:
            local_path = inputs_dir / f["name"]
            with open(local_path, "wb") as out:
                out.write(dl_resp.content)
            return f["name"], len(dl_resp.content)
        return f["name"], 0

    count = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_dl, (i, f)): f for i, f in enumerate(files)}
        for fut in as_completed(futures):
            fname, size = fut.result()
            if size > 0:
                count += 1
                print(f"  Downloaded {fname} ({size // 1024}KB)")

    return count


def run(job_id):
    job = db.get_job(job_id)
    if not job:
        print(f"[Pipeline] Job {job_id} not found")
        sys.exit(1)

    # ── Try Modal full pipeline first (GPU, full detection logic) ──
    MODAL_PIPELINE_URL = os.environ.get(
        "MODAL_PIPELINE_URL",
        "https://hendacow--clippar-shot-detector-run-full-pipeline.modal.run"
    )

    supabase_url = os.environ.get("SUPABASE_URL", "")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    neon_url = os.environ.get("DATABASE_URL", "")

    # For Supabase-sourced clips, dispatch entirely to Modal
    if supabase_url and supabase_key and not job.get("drive_link"):
        print(f"[Pipeline] Dispatching job {job_id} to Modal GPU (full pipeline)...")
        db.update_job(job_id, status="downloading", progress=2,
                      stage_detail="Starting GPU pipeline...")

        try:
            import requests
            resp = requests.post(MODAL_PIPELINE_URL, json={
                "job_id": job_id,
                "supabase_url": supabase_url,
                "supabase_key": supabase_key,
                "neon_database_url": neon_url,
            }, timeout=840)  # 14 min timeout

            if resp.status_code == 200:
                data = resp.json()
                if data.get("ok"):
                    detect_t = data.get("detection_time_sec", "?")
                    merge_t = data.get("merge_time_sec", "?")
                    print(f"[Pipeline] Job {job_id} completed via Modal GPU")
                    print(f"  Detection: {detect_t}s, Merge: {merge_t}s")
                    print(f"  Reel: {data.get('reel_url', 'N/A')}")
                    return
                else:
                    error = data.get("error", "Unknown")
                    print(f"[Pipeline] Modal returned error: {error}")
                    # Fall through to local processing
            else:
                print(f"[Pipeline] Modal HTTP error: {resp.status_code}")
                # Fall through to local processing
        except Exception as e:
            print(f"[Pipeline] Modal dispatch failed: {e}")
            # Fall through to local processing

        print("[Pipeline] Falling back to local processing...")

    # ── Local fallback pipeline ──
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
    downloaded = False

    # Try Supabase Storage first (parallel downloads)
    if not downloaded and supabase_url and supabase_key:
        count = _download_from_supabase(job_id, inputs_dir, supabase_url, supabase_key)
        if count > 0:
            downloaded = True

    # Try R2 storage
    if not downloaded and _use_r2():
        import storage
        r2_files = storage.list_files(f"jobs/{job_id}/inputs/")
        if r2_files:
            print(f"[Pipeline] Downloading {len(r2_files)} file(s) from R2")
            for key in r2_files:
                filename = key.split("/")[-1]
                storage.download_file(key, str(inputs_dir / filename))
            downloaded = True

    # Try Google Drive
    if not downloaded and job.get("drive_link"):
        print(f"[Pipeline] Downloading from Drive: {job['drive_link']}")
        db.update_job(job_id, status="downloading")
        from drive_utils import download_from_drive
        try:
            download_from_drive(job["drive_link"], str(inputs_dir))
            downloaded = True
        except Exception as e:
            db.update_job(job_id, status="download_failed", error_message=str(e))
            sys.exit(1)

    # Check local files
    if not downloaded:
        existing_inputs = list(inputs_dir.glob("*.MOV")) + list(inputs_dir.glob("*.mov")) + \
                          list(inputs_dir.glob("*.mp4")) + list(inputs_dir.glob("*.MP4"))
        if existing_inputs:
            print(f"[Pipeline] Found {len(existing_inputs)} local file(s)")
            downloaded = True

    if not downloaded:
        db.update_job(job_id, status="download_failed", error_message="No input files found")
        sys.exit(1)

    input_files = sorted(
        list(inputs_dir.glob("*.mov")) + list(inputs_dir.glob("*.MOV")) +
        list(inputs_dir.glob("*.mp4")) + list(inputs_dir.glob("*.MP4"))
    )
    total_inputs = len(input_files)

    # ── 2. Full shot detection using shot_detector.py ──
    print(f"[Pipeline] Running FULL shot detection on {total_inputs} clip(s)...")
    db.update_job(job_id, status="detecting", progress=20,
                  stage_detail=f"Analysing {total_inputs} clips...")

    from shot_detector import load_config, detect_shots

    cfg = load_config("config.yaml")
    cfg["clips_dir"] = str(inputs_dir)
    cfg["output_dir"] = str(outputs_clips)
    cfg["fast_mode"] = True
    cfg["save_annotated"] = False
    cfg["display"] = False
    cfg["save_putts"] = True

    def on_clip_done(clip_idx, total_clips, shots):
        pct = 20 + int((clip_idx / total_clips) * 25)
        db.update_job(job_id, progress=pct,
                      stage_detail=f"Analysed clip {clip_idx} of {total_clips}")

    detect_shots(cfg, on_clip_done=on_clip_done)

    clip_files = sorted(
        [f for f in outputs_clips.glob("*")
         if f.suffix.lower() in (".mp4", ".mov") and "_annotated" not in f.name]
    )
    clip_count = len(clip_files)
    db.update_job(job_id, clip_count=clip_count, progress=45,
                  stage_detail=f"Detected {clip_count} clips")

    if clip_count == 0:
        # Fallback: copy originals
        print("[Pipeline] No detected clips — using originals")
        import shutil
        for clip_path in input_files:
            shutil.copy2(str(clip_path), str(outputs_clips / clip_path.name))
        clip_files = sorted(outputs_clips.glob("*"))
        clip_count = len(clip_files)
        if clip_count == 0:
            db.update_job(job_id, status="processing_failed",
                          error_message="No clips to process")
            sys.exit(1)

    # ── 3. Merge clips ──
    print(f"[Pipeline] Merging {clip_count} clips...")
    db.update_job(job_id, status="merging", progress=50,
                  stage_detail=f"Stitching {clip_count} shots together...")

    from merge_clips import load_config as load_merge_config, merge
    merge_cfg = load_merge_config()
    merge_cfg["shots_dir"] = str(outputs_clips)
    merge_cfg["merged_output"] = str(merged_output)
    merge_cfg["include_no_detection"] = True
    merge(merge_cfg)

    if not merged_output.exists():
        db.update_job(job_id, status="processing_failed",
                      error_message="Merge produced no output file")
        sys.exit(1)

    # ── 4. Post-process: scorecard overlay + background music ──
    print("[Pipeline] Post-processing (scorecard + music)...")
    db.update_job(job_id, status="post_processing", progress=65,
                  stage_detail="Adding scorecard overlay & music...")
    from post_process import post_process as _post_process

    # Fetch round info from Supabase for scorecard
    course_name, date_str = "Golf Course", ""
    total_score, score_to_par, holes_played = None, None, 18

    if supabase_url and supabase_key:
        try:
            import requests
            resp = requests.get(
                f"{supabase_url}/rest/v1/rounds?id=eq.{job_id}&select=*",
                headers={
                    "apikey": supabase_key,
                    "Authorization": f"Bearer {supabase_key}",
                },
            )
            if resp.status_code == 200:
                rounds = resp.json()
                if rounds:
                    r = rounds[0]
                    course_name = r.get("course_name", course_name)
                    date_str = r.get("date", "")[:10]
                    total_score = r.get("total_score")
                    score_to_par = r.get("score_to_par")
                    holes_played = r.get("holes_played", 18)
                    print(f"[Pipeline] Round: {course_name}, score={total_score}")
        except Exception as e:
            print(f"[Pipeline] Could not fetch round info: {e}")

    processed_output = merged_output.parent / "highlight_reel_processed.mov"
    _post_process(
        str(merged_output),
        str(processed_output),
        course_name=course_name,
        date_str=date_str,
        total_score=total_score,
        score_to_par=score_to_par,
        holes_played=holes_played,
    )

    final_mov = processed_output if processed_output.exists() else merged_output

    # ── 5. Transcode to mp4 ──
    import subprocess as _sp
    mp4_output = merged_output.parent / "highlight_reel.mp4"
    print("[Pipeline] Transcoding to mp4...")
    db.update_job(job_id, status="transcoding", progress=78,
                  stage_detail="Transcoding to mobile format...")
    tc = _sp.run([
        "ffmpeg", "-y", "-i", str(final_mov),
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-movflags", "+faststart",
        str(mp4_output),
    ], capture_output=True, text=True)
    if tc.returncode != 0:
        print(f"[Pipeline] mp4 transcode warning: {tc.stderr[-300:]}")

    # ── 6. Upload results ──
    db.update_job(job_id, status="uploading_reel", progress=85,
                  stage_detail="Uploading your highlight reel...")

    if _use_r2():
        import storage
        print("[Pipeline] Uploading results to R2...")
        for output_file in [final_mov, mp4_output]:
            if output_file.exists():
                key = f"jobs/{job_id}/outputs/merged/{output_file.name}"
                storage.upload_file(str(output_file), key)
                print(f"[Pipeline] Uploaded {key}")

        for clip in clip_files:
            key = f"jobs/{job_id}/outputs/clips/{clip.name}"
            storage.upload_file(str(clip), key)

        import shutil
        shutil.rmtree(str(job_dir), ignore_errors=True)

    # Upload to Supabase Storage
    if supabase_url and supabase_key and mp4_output.exists():
        try:
            import requests
            reel_storage_path = f"reels/{job_id}/highlight.mp4"
            with open(mp4_output, "rb") as f:
                upload_resp = requests.post(
                    f"{supabase_url}/storage/v1/object/clips/{reel_storage_path}",
                    headers={
                        "apikey": supabase_key,
                        "Authorization": f"Bearer {supabase_key}",
                        "Content-Type": "video/mp4",
                        "x-upsert": "true",
                    },
                    data=f,
                )
            if upload_resp.status_code < 300:
                reel_url = f"{supabase_url}/storage/v1/object/public/clips/{reel_storage_path}"
                requests.patch(
                    f"{supabase_url}/rest/v1/rounds?id=eq.{job_id}",
                    json={"reel_url": reel_url, "status": "ready"},
                    headers={
                        "apikey": supabase_key,
                        "Authorization": f"Bearer {supabase_key}",
                        "Content-Type": "application/json",
                        "Prefer": "return=minimal",
                    },
                )
                print(f"[Pipeline] Uploaded reel to Supabase: {reel_url}")
            else:
                print(f"[Pipeline] Supabase upload failed: {upload_resp.status_code}")
        except Exception as e:
            print(f"[Pipeline] Supabase upload error: {e}")

    db.update_job(job_id, status="ready_for_review", progress=100,
                  stage_detail="Highlight reel ready!")
    print(f"[Pipeline] Job {job_id} ready — {clip_count} clip(s)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python run_pipeline.py <job_id>")
        sys.exit(1)
    run(sys.argv[1])
