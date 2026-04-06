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
    downloaded = False

    # Try Supabase Storage first (mobile app uploads clips here)
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not downloaded and supabase_url and supabase_key:
        try:
            import requests
            # List files in clips/{job_id}/ bucket
            list_resp = requests.post(
                f"{supabase_url}/storage/v1/object/list/clips",
                headers={
                    "apikey": supabase_key,
                    "Authorization": f"Bearer {supabase_key}",
                    "Content-Type": "application/json",
                },
                json={"prefix": f"{job_id}/", "limit": 100},
            )
            if list_resp.status_code == 200:
                files = [f for f in list_resp.json() if f.get("name", "").endswith((".mp4", ".mov", ".MP4", ".MOV"))]
                if files:
                    total_files = len(files)
                    print(f"[Pipeline] Downloading {total_files} clip(s) from Supabase Storage")
                    db.update_job(job_id, status="downloading", progress=5,
                                  stage_detail=f"Downloading clip 1 of {total_files}")
                    for idx, f in enumerate(files):
                        file_key = f"{job_id}/{f['name']}"
                        db.update_job(job_id, progress=5 + int((idx / total_files) * 15),
                                      stage_detail=f"Downloading clip {idx + 1} of {total_files}")
                        dl_resp = requests.get(
                            f"{supabase_url}/storage/v1/object/clips/{file_key}",
                            headers={
                                "apikey": supabase_key,
                                "Authorization": f"Bearer {supabase_key}",
                            },
                        )
                        if dl_resp.status_code == 200:
                            local_path = inputs_dir / f["name"]
                            with open(local_path, "wb") as out:
                                out.write(dl_resp.content)
                            print(f"  Downloaded {f['name']} ({len(dl_resp.content) // 1024}KB)")
                    downloaded = True
        except Exception as e:
            print(f"[Pipeline] Supabase Storage download error: {e}")

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

    # Count input files
    input_files = list(inputs_dir.glob("*.mov")) + list(inputs_dir.glob("*.MOV")) + \
                  list(inputs_dir.glob("*.mp4")) + list(inputs_dir.glob("*.MP4"))
    total_inputs = len(input_files)

    # ── 2. Shot detection via Modal GPU ──
    # Send clips to Modal (T4 GPU) for YOLO-based swing detection,
    # then trim locally with FFmpeg using the detected timestamps.
    import subprocess as _sp
    import requests as _req

    MODAL_BATCH_URL = os.environ.get(
        "MODAL_DETECT_URL",
        "https://hendacow--clippar-shot-detector-detect-shots-batch.modal.run"
    )
    PRE_ROLL = 2.0
    POST_ROLL = 3.0
    MIN_CLIP_DURATION = 3.0

    print(f"[Pipeline] Running GPU shot detection on {total_inputs} clip(s) via Modal...")
    db.update_job(job_id, status="detecting", progress=20,
                  stage_detail=f"Analysing {total_inputs} clips on GPU...")

    # Build signed URLs for Modal to download clips from Supabase
    clips_payload = []
    for clip_path in input_files:
        storage_key = f"{job_id}/{clip_path.name}"
        clips_payload.append({
            "video_url": storage_key,
            "filename": clip_path.name,
        })

    # Call Modal batch endpoint
    detect_results = []
    try:
        resp = _req.post(MODAL_BATCH_URL, json={
            "clips": clips_payload,
            "supabase_url": supabase_url,
            "supabase_key": supabase_key,
        }, timeout=300)
        if resp.status_code == 200:
            data = resp.json()
            detect_results = data.get("results", [])
            print(f"[Pipeline] Modal returned {len(detect_results)} results")
        else:
            print(f"[Pipeline] Modal request failed: {resp.status_code} {resp.text[:200]}")
    except Exception as e:
        print(f"[Pipeline] Modal request error: {e}")

    # Build a lookup: filename → trim points
    trim_map = {}
    for r in detect_results:
        fname = r.get("filename", "")
        if r.get("found"):
            trim_map[fname] = (r["trim_start_sec"], r["trim_end_sec"])
        elif r.get("trim_start_sec") is not None:
            # Fallback trim (center) from Modal
            trim_map[fname] = (r["trim_start_sec"], r["trim_end_sec"])

    db.update_job(job_id, progress=35,
                  stage_detail=f"Detected shots — trimming {total_inputs} clips...")

    # Trim each clip using FFmpeg with detected timestamps
    for idx, clip_path in enumerate(input_files):
        db.update_job(job_id, progress=35 + int(((idx + 1) / total_inputs) * 10),
                      stage_detail=f"Trimming clip {idx + 1} of {total_inputs}...")

        # Get duration
        try:
            probe = _sp.run(
                ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
                 "-of", "csv=p=0", str(clip_path)],
                capture_output=True, text=True, timeout=30
            )
            duration = float(probe.stdout.strip())
        except Exception:
            duration = 15.0

        if duration < MIN_CLIP_DURATION:
            print(f"  Skipping {clip_path.name} — too short ({duration:.1f}s)")
            continue

        # Use Modal detection results if available, else center trim
        if clip_path.name in trim_map:
            start, end = trim_map[clip_path.name]
            trim_dur = end - start
            print(f"  {clip_path.name}: swing detected at {start:.1f}s-{end:.1f}s")
        else:
            start = max(0, (duration - 5.0) / 2.0)
            trim_dur = min(5.0, duration)
            print(f"  {clip_path.name}: no detection — center trim {start:.1f}s-{start + trim_dur:.1f}s")

        out_path = outputs_clips / f"clip{idx + 1:03d}_{clip_path.stem}.mp4"
        try:
            _sp.run(
                ["ffmpeg", "-y", "-ss", f"{start:.2f}", "-i", str(clip_path),
                 "-t", f"{trim_dur:.2f}", "-c:v", "libx264", "-preset", "ultrafast",
                 "-c:a", "aac", "-b:a", "128k", str(out_path)],
                capture_output=True, text=True, timeout=120
            )
            if out_path.exists() and out_path.stat().st_size > 0:
                print(f"  Trimmed → {out_path.name}")
        except Exception as e:
            print(f"  Error trimming {clip_path.name}: {e}")

    clip_files = list(outputs_clips.glob("*.mp4"))
    clip_count = len(clip_files)
    db.update_job(job_id, clip_count=clip_count, progress=45,
                  stage_detail=f"Trimmed {clip_count} clips")

    if clip_count == 0:
        # Fallback: copy originals
        print("[Pipeline] No trimmed clips — using originals")
        import shutil
        for clip_path in input_files:
            shutil.copy2(str(clip_path), str(outputs_clips / clip_path.name))
        clip_files = list(outputs_clips.glob("*.mp4")) + list(outputs_clips.glob("*.mov"))
        clip_count = len(clip_files)
        if clip_count == 0:
            db.update_job(job_id, status="processing_failed", error_message="No clips to process")
            sys.exit(1)

    # ── 3. Merge clips ──
    print("[Pipeline] Merging clips...")
    db.update_job(job_id, status="merging", progress=50,
                  stage_detail=f"Stitching {clip_count} shots together...")
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

    # ── 4. Post-process: scorecard overlay + background music ──
    print("[Pipeline] Post-processing (scorecard + music)...")
    db.update_job(job_id, status="post_processing", progress=65,
                  stage_detail="Adding scorecard overlay & music...")
    from post_process import post_process as _post_process

    # Fetch round info from Supabase for scorecard
    course_name = "Golf Course"
    date_str = ""
    total_score = None
    score_to_par = None
    holes_played = 18

    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if supabase_url and supabase_key:
        try:
            import requests
            headers = {
                "apikey": supabase_key,
                "Authorization": f"Bearer {supabase_key}",
            }
            resp = requests.get(
                f"{supabase_url}/rest/v1/rounds?id=eq.{job_id}&select=*",
                headers=headers,
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
                    print(f"[Pipeline] Round info: {course_name}, score={total_score}, holes={holes_played}")
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

    # Use processed output if it exists, otherwise fall back to merged
    final_mov = processed_output if processed_output.exists() else merged_output

    # ── 5. Transcode to mp4 for browser/mobile preview ──
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

    # ── 6. Upload results to R2 and/or Supabase Storage ──
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

        # Upload individual clips too (for potential future use)
        for clip in clip_files:
            key = f"jobs/{job_id}/outputs/clips/{clip.name}"
            storage.upload_file(str(clip), key)

        # Clean up temp directory
        import shutil
        shutil.rmtree(str(job_dir), ignore_errors=True)
        print(f"[Pipeline] Cleaned up temp dir {job_dir}")

    # Upload to Supabase Storage if configured (mobile app flow)
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
                # Get public URL
                reel_url = f"{supabase_url}/storage/v1/object/public/clips/{reel_storage_path}"
                # Update round with reel URL
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
                print(f"[Pipeline] Uploaded reel to Supabase Storage: {reel_url}")
            else:
                print(f"[Pipeline] Supabase Storage upload failed: {upload_resp.status_code}")
        except Exception as e:
            print(f"[Pipeline] Supabase Storage upload error: {e}")

    db.update_job(job_id, status="ready_for_review", progress=100,
                  stage_detail="Highlight reel ready!")
    print(f"[Pipeline] Job {job_id} ready for review — {clip_count} clip(s)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python run_pipeline.py <job_id>")
        sys.exit(1)
    run(sys.argv[1])
