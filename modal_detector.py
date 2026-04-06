"""
modal_detector.py — GPU-accelerated full pipeline on Modal.

Runs the COMPLETE shot_detector.py logic (4-state machine, PuttVeto, audio
confirmation, ball tracking, etc.) on a T4/A10G GPU with parallel clip
processing + NVENC encoding.

Usage:
  modal deploy modal_detector.py          # deploy once
  modal serve modal_detector.py           # dev mode with hot-reload

Endpoints:
  POST /detect_shots_batch   — detect shots in multiple clips (returns trim points)
  POST /run_full_pipeline    — full end-to-end: download → detect → trim → merge → post-process → upload
"""

import modal
import os

# ---------------------------------------------------------------------------
# Modal app + container image
# ---------------------------------------------------------------------------

app = modal.App("clippar-shot-detector")

# Build image with ALL dependencies + pipeline code + models baked in
detector_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "ffmpeg", "libgl1", "libglib2.0-0", "libsm6", "libxext6",
        "libxrender1", "libsndfile1",
    )
    .pip_install(
        "torch", "torchvision",
        "ultralytics",
        "opencv-python-headless",
        "numpy",
        "librosa",
        "scipy",
        "pyyaml",
        "requests",
        "fastapi",
        "psycopg2-binary",
    )
    # Bundle the full pipeline code + models
    .add_local_file("shot_detector.py", remote_path="/app/shot_detector.py")
    .add_local_file("merge_clips.py", remote_path="/app/merge_clips.py")
    .add_local_file("post_process.py", remote_path="/app/post_process.py")
    .add_local_file("config.yaml", remote_path="/app/config.yaml")
    .add_local_dir("models", remote_path="/app/models")
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _update_neon_job(neon_url, job_id, **kwargs):
    """Update job status in Neon Postgres."""
    if not neon_url:
        return
    try:
        import psycopg2
        conn = psycopg2.connect(neon_url)
        sets, vals = [], []
        for k, v in kwargs.items():
            sets.append(f"{k} = %s")
            vals.append(v)
        if sets:
            vals.append(job_id)
            conn.cursor().execute(
                f"UPDATE jobs SET {', '.join(sets)} WHERE id = %s", vals
            )
            conn.commit()
        conn.close()
    except Exception as e:
        print(f"[Pipeline] DB update error: {e}")


def _download_clips_parallel(supabase_url, supabase_key, job_id, inputs_dir):
    """Download all clips from Supabase Storage in parallel."""
    import requests
    from concurrent.futures import ThreadPoolExecutor, as_completed
    from pathlib import Path

    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
    }

    # List files
    list_resp = requests.post(
        f"{supabase_url}/storage/v1/object/list/clips",
        headers={**headers, "Content-Type": "application/json"},
        json={"prefix": f"{job_id}/", "limit": 100},
    )
    if list_resp.status_code != 200:
        return []

    files = [
        f for f in list_resp.json()
        if f.get("name", "").endswith((".mp4", ".mov", ".MP4", ".MOV"))
    ]
    if not files:
        return []

    def _download_one(f):
        fname = f["name"]
        dl = requests.get(
            f"{supabase_url}/storage/v1/object/clips/{job_id}/{fname}",
            headers=headers, timeout=120,
        )
        if dl.status_code == 200 and len(dl.content) > 1000:
            out_path = Path(inputs_dir) / fname
            out_path.write_bytes(dl.content)
            return fname, len(dl.content)
        return fname, 0

    results = []
    # Download up to 8 clips concurrently
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_download_one, f): f for f in files}
        for fut in as_completed(futures):
            fname, size = fut.result()
            if size > 0:
                results.append(fname)
                print(f"  Downloaded {fname} ({size // 1024}KB)")
            else:
                print(f"  FAILED {fname}")

    return results


def _trim_clips_parallel(input_files, trim_map, clips_dir, use_nvenc=False):
    """Trim clips in parallel using ThreadPoolExecutor."""
    import subprocess as sp
    from concurrent.futures import ThreadPoolExecutor, as_completed
    from pathlib import Path

    PRE_ROLL, POST_ROLL = 2.0, 3.0
    MIN_CLIP_DURATION = 3.0

    encoder = "h264_nvenc" if use_nvenc else "libx264"
    preset = "fast" if use_nvenc else "ultrafast"

    def _trim_one(idx_clip):
        idx, clip_path = idx_clip
        clip_path = Path(clip_path)

        # Get duration
        try:
            probe = sp.run(
                ["ffprobe", "-v", "quiet", "-show_entries",
                 "format=duration", "-of", "csv=p=0", str(clip_path)],
                capture_output=True, text=True, timeout=30
            )
            duration = float(probe.stdout.strip())
        except Exception:
            duration = 15.0

        if duration < MIN_CLIP_DURATION:
            return None

        # Use detection results or center trim
        if clip_path.name in trim_map:
            start, end = trim_map[clip_path.name]
            trim_dur = end - start
        else:
            start = max(0, (duration - 5.0) / 2.0)
            trim_dur = min(5.0, duration)

        out_path = Path(clips_dir) / f"clip{idx:03d}_{clip_path.stem}.mp4"
        try:
            sp.run(
                ["ffmpeg", "-y", "-ss", f"{start:.2f}", "-i", str(clip_path),
                 "-t", f"{trim_dur:.2f}", "-c:v", encoder, "-preset", preset,
                 "-c:a", "aac", "-b:a", "128k", str(out_path)],
                capture_output=True, text=True, timeout=120
            )
            if out_path.exists() and out_path.stat().st_size > 0:
                return out_path
        except Exception as e:
            print(f"  Error trimming {clip_path.name}: {e}")
        return None

    trimmed = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {
            pool.submit(_trim_one, (idx, cp)): idx
            for idx, cp in enumerate(input_files, 1)
        }
        for fut in as_completed(futures):
            result = fut.result()
            if result:
                trimmed.append(result)

    return sorted(trimmed)


def _check_nvenc():
    """Check if NVIDIA NVENC is available."""
    import subprocess as sp
    try:
        result = sp.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=10
        )
        return "h264_nvenc" in result.stdout
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Batch detection endpoint (returns trim points only — no merge)
# ---------------------------------------------------------------------------

@app.function(
    image=detector_image,
    gpu="T4",
    timeout=600,
)
@modal.fastapi_endpoint(method="POST")
def detect_shots_batch(request: dict) -> dict:
    """Process multiple clips using the FULL shot_detector.py logic.

    Runs all clips in parallel using ThreadPoolExecutor with shared GPU.

    Accepts JSON with:
      - clips: list of {video_url, filename}
      - supabase_url: base Supabase URL
      - supabase_key: service key for downloading

    Returns JSON with per-clip trim points + shot info.
    """
    import sys
    import tempfile
    import time
    from pathlib import Path

    sys.path.insert(0, "/app")
    from shot_detector import load_config, detect_shots

    clips = request.get("clips", [])
    supabase_url = request.get("supabase_url", "")
    supabase_key = request.get("supabase_key", "")

    if not clips:
        return {"error": "No clips provided"}

    work_dir = Path(tempfile.mkdtemp(prefix="clippar_batch_"))
    inputs_dir = work_dir / "inputs"
    outputs_dir = work_dir / "outputs"
    inputs_dir.mkdir()
    outputs_dir.mkdir()

    # Download clips in parallel
    import requests as req
    from concurrent.futures import ThreadPoolExecutor, as_completed

    headers = {}
    if supabase_key:
        headers = {
            "apikey": supabase_key,
            "Authorization": f"Bearer {supabase_key}",
        }

    def _download(clip_info):
        video_url = clip_info.get("video_url", "")
        filename = clip_info.get("filename", "clip.mp4")
        if not video_url.startswith("http") and supabase_url and supabase_key:
            video_url = f"{supabase_url}/storage/v1/object/clips/{video_url}"
        try:
            resp = req.get(video_url, headers=headers, timeout=120)
            if resp.status_code == 200 and len(resp.content) > 1000:
                (inputs_dir / filename).write_bytes(resp.content)
                return filename, True
        except Exception as e:
            print(f"Download error for {filename}: {e}")
        return filename, False

    print(f"[Pipeline] Downloading {len(clips)} clips in parallel...")
    with ThreadPoolExecutor(max_workers=8) as pool:
        for fname, ok in pool.map(_download, clips):
            print(f"  {'OK' if ok else 'FAIL'}: {fname}")

    # Run full shot detection with parallel_workers on GPU
    cfg = load_config("/app/config.yaml")
    cfg["clips_dir"] = str(inputs_dir)
    cfg["output_dir"] = str(outputs_dir)
    cfg["fast_mode"] = True
    cfg["save_annotated"] = False
    cfg["display"] = False
    cfg["verbose"] = False
    cfg["device"] = "cuda"
    cfg["inference_imgsz"] = 640
    cfg["parallel_workers"] = 0  # sequential on GPU (shared CUDA context)
    cfg["save_putts"] = True

    start_t = time.time()
    detect_shots(cfg)
    detect_time = time.time() - start_t
    print(f"[Pipeline] Detection completed in {detect_time:.1f}s")

    # Parse output files to build trim results
    results = []
    for clip_info in clips:
        filename = clip_info.get("filename", "")
        stem = Path(filename).stem

        # Look for output files matching this clip
        matching = list(outputs_dir.glob(f"*_{stem}_*"))
        matching += list(outputs_dir.glob(f"*_{stem}.*"))

        if matching:
            # Get the trim info from the output filename
            out = matching[0]
            # Probe the output to get duration
            import subprocess as sp
            try:
                probe = sp.run(
                    ["ffprobe", "-v", "quiet", "-show_entries",
                     "format=duration", "-of", "csv=p=0", str(out)],
                    capture_output=True, text=True, timeout=10
                )
                out_dur = float(probe.stdout.strip())
            except Exception:
                out_dur = 5.0

            is_putt = "putt" in out.name.lower()
            is_no_detect = "no_detection" in out.name.lower()

            results.append({
                "filename": filename,
                "found": not is_no_detect,
                "is_putt": is_putt,
                "output_file": out.name,
                "output_duration": round(out_dur, 2),
                "trim_start_sec": 0.0 if is_putt or is_no_detect else None,
                "trim_end_sec": out_dur if is_putt or is_no_detect else None,
            })
        else:
            results.append({
                "filename": filename,
                "found": False,
                "error": "No output produced",
            })

    # Cleanup
    import shutil
    shutil.rmtree(str(work_dir), ignore_errors=True)

    return {
        "ok": True,
        "results": results,
        "detection_time_sec": round(detect_time, 1),
    }


# ---------------------------------------------------------------------------
# Full pipeline endpoint — download → detect → trim → merge → post-process → upload
# ---------------------------------------------------------------------------

@app.function(
    image=detector_image,
    gpu="T4",
    timeout=900,  # 15 min for large clip sets
    memory=16384,  # 16GB RAM
    secrets=[modal.Secret.from_name("supabase-credentials", required_keys=[])],
)
@modal.fastapi_endpoint(method="POST")
def run_full_pipeline(request: dict) -> dict:
    """Full pipeline using the COMPLETE shot_detector.py logic.

    1. Download clips from Supabase (parallel)
    2. Run full detect_shots() with state machine, PuttVeto, audio, etc.
    3. Merge detected clips (shot_detector already trims + saves clips)
    4. Post-process (scorecard overlay + music)
    5. Transcode to mp4
    6. Upload reel to Supabase Storage

    Accepts JSON with:
      - job_id: round UUID
      - supabase_url: Supabase URL
      - supabase_key: service role key
      - neon_database_url: optional Neon Postgres for job status
    """
    import sys
    import time
    import tempfile
    import subprocess as sp
    import requests as req
    from pathlib import Path

    sys.path.insert(0, "/app")
    from shot_detector import load_config, detect_shots
    from merge_clips import load_config as load_merge_config, merge
    from post_process import post_process as _post_process

    job_id = request.get("job_id")
    supabase_url = request.get("supabase_url", "") or os.environ.get("SUPABASE_URL", "")
    supabase_key = request.get("supabase_key", "") or os.environ.get("SUPABASE_SERVICE_KEY", "")
    neon_url = request.get("neon_database_url", "")

    if not job_id or not supabase_url or not supabase_key:
        return {"error": "job_id, supabase_url, supabase_key required"}

    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
    }

    def update_job(**kwargs):
        _update_neon_job(neon_url, job_id, **kwargs)

    use_nvenc = _check_nvenc()
    print(f"[Pipeline] NVENC available: {use_nvenc}")

    try:
        work_dir = Path(tempfile.mkdtemp(prefix=f"clippar_{job_id}_"))
        inputs_dir = work_dir / "inputs"
        outputs_dir = work_dir / "outputs" / "clips"
        merged_dir = work_dir / "outputs" / "merged"
        inputs_dir.mkdir(parents=True)
        outputs_dir.mkdir(parents=True)
        merged_dir.mkdir(parents=True)

        # ── 1. Download clips from Supabase (parallel) ──
        update_job(status="downloading", progress=5,
                   stage_detail="Downloading clips...")
        t0 = time.time()
        downloaded = _download_clips_parallel(
            supabase_url, supabase_key, job_id, inputs_dir
        )
        print(f"[Pipeline] Downloaded {len(downloaded)} clips in {time.time()-t0:.1f}s")

        if not downloaded:
            update_job(status="processing_failed",
                       stage_detail="No clips found in storage")
            return {"error": "No clips found"}

        input_files = sorted(inputs_dir.glob("*"))
        total = len(input_files)

        # ── 2. Full shot detection with shot_detector.py ──
        update_job(status="detecting", progress=20,
                   stage_detail=f"Analysing {total} clips on GPU...")
        t0 = time.time()

        cfg = load_config("/app/config.yaml")
        cfg["clips_dir"] = str(inputs_dir)
        cfg["output_dir"] = str(outputs_dir)
        cfg["fast_mode"] = True
        cfg["save_annotated"] = False
        cfg["display"] = False
        cfg["verbose"] = False
        cfg["device"] = "cuda"
        cfg["inference_imgsz"] = 640
        cfg["parallel_workers"] = 0  # sequential (shared CUDA context is faster than multiprocess on single GPU)
        cfg["save_putts"] = True

        def on_clip_done(clip_idx, total_clips, shots):
            pct = 20 + int((clip_idx / total_clips) * 25)
            update_job(progress=pct,
                       stage_detail=f"Analysed clip {clip_idx} of {total_clips} ({shots} shots)")

        detect_shots(cfg, on_clip_done=on_clip_done)
        detect_time = time.time() - t0
        print(f"[Pipeline] Detection completed in {detect_time:.1f}s")

        # Count output clips
        output_clips = sorted(
            [f for f in outputs_dir.glob("*")
             if f.suffix.lower() in (".mp4", ".mov") and "_annotated" not in f.name]
        )
        clip_count = len(output_clips)
        print(f"[Pipeline] {clip_count} output clip(s)")

        if clip_count == 0:
            # No shots detected — likely pre-recorded individual clips from the app.
            # Use the original input files directly instead of failing.
            import shutil
            print("[Pipeline] No shots detected — using original clips directly")
            for f in input_files:
                shutil.copy2(str(f), str(outputs_dir / f.name))
            output_clips = sorted(
                [f for f in outputs_dir.glob("*")
                 if f.suffix.lower() in (".mp4", ".mov")]
            )
            clip_count = len(output_clips)
            if clip_count == 0:
                update_job(status="processing_failed",
                           stage_detail="No clips to process")
                return {"error": "No clips to process"}

        update_job(clip_count=clip_count, progress=45,
                   stage_detail=f"Detected {clip_count} shots")

        # ── 3. Merge clips ──
        update_job(status="merging", progress=50,
                   stage_detail=f"Stitching {clip_count} shots together...")
        t0 = time.time()

        merged_output = merged_dir / "highlight_reel.mov"
        merge_cfg = load_merge_config()
        merge_cfg["shots_dir"] = str(outputs_dir)
        merge_cfg["merged_output"] = str(merged_output)
        merge_cfg["include_no_detection"] = True
        merge(merge_cfg)

        if not merged_output.exists():
            update_job(status="processing_failed",
                       stage_detail="Merge produced no output")
            return {"error": "Merge failed"}

        merge_time = time.time() - t0
        print(f"[Pipeline] Merged in {merge_time:.1f}s ({merged_output.stat().st_size // 1024}KB)")

        # ── 4. Post-process (scorecard overlay + music) ──
        update_job(status="post_processing", progress=65,
                   stage_detail="Adding scorecard overlay & music...")

        # Fetch round info from Supabase
        course_name, date_str = "Golf Course", ""
        total_score, score_to_par, holes_played = None, None, 18

        try:
            resp = req.get(
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
                    print(f"[Pipeline] Round: {course_name}, score={total_score}")
        except Exception as e:
            print(f"[Pipeline] Could not fetch round info: {e}")

        processed_output = merged_dir / "highlight_reel_processed.mov"
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
        update_job(status="transcoding", progress=78,
                   stage_detail="Transcoding to mobile format...")
        t0 = time.time()

        mp4_output = merged_dir / "highlight_reel.mp4"
        encoder = "h264_nvenc" if use_nvenc else "libx264"
        preset = "fast" if use_nvenc else "fast"

        tc = sp.run([
            "ffmpeg", "-y", "-i", str(final_mov),
            "-c:v", encoder, "-preset", preset,
            *(["-crf", "23"] if not use_nvenc else ["-rc", "vbr", "-cq", "23"]),
            "-c:a", "aac", "-movflags", "+faststart",
            str(mp4_output),
        ], capture_output=True, text=True, timeout=300)

        if tc.returncode != 0:
            # Fallback to libx264 if NVENC failed
            if use_nvenc:
                print(f"[Pipeline] NVENC failed, falling back to libx264...")
                sp.run([
                    "ffmpeg", "-y", "-i", str(final_mov),
                    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
                    "-c:a", "aac", "-movflags", "+faststart",
                    str(mp4_output),
                ], capture_output=True, text=True, timeout=300)

        transcode_time = time.time() - t0
        print(f"[Pipeline] Transcoded in {transcode_time:.1f}s")

        # ── 6. Upload reel to Supabase Storage ──
        update_job(status="uploading_reel", progress=85,
                   stage_detail="Uploading highlight reel...")

        reel_storage_path = f"reels/{job_id}/highlight.mp4"
        upload_file = mp4_output if mp4_output.exists() else final_mov

        with open(upload_file, "rb") as f:
            upload_resp = req.post(
                f"{supabase_url}/storage/v1/object/clips/{reel_storage_path}",
                headers={
                    **headers,
                    "Content-Type": "video/mp4",
                    "x-upsert": "true",
                },
                data=f,
            )

        if upload_resp.status_code >= 300:
            update_job(status="processing_failed",
                       stage_detail=f"Upload failed: {upload_resp.status_code}")
            return {"error": f"Upload failed: {upload_resp.status_code}"}

        reel_url = f"{supabase_url}/storage/v1/object/public/clips/{reel_storage_path}"
        print(f"[Pipeline] Reel uploaded: {reel_url}")

        # ── 7. Update round in Supabase ──
        req.patch(
            f"{supabase_url}/rest/v1/rounds?id=eq.{job_id}",
            json={"reel_url": reel_url, "status": "ready"},
            headers={
                **headers,
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
        )

        update_job(status="ready_for_review", progress=100,
                   stage_detail="Highlight reel ready!")

        # Cleanup
        import shutil
        shutil.rmtree(str(work_dir), ignore_errors=True)

        return {
            "ok": True,
            "reel_url": reel_url,
            "clips_processed": clip_count,
            "detection_time_sec": round(detect_time, 1),
            "merge_time_sec": round(merge_time, 1),
            "transcode_time_sec": round(transcode_time, 1),
        }

    except Exception as e:
        update_job(status="processing_failed", stage_detail=str(e)[:200])
        import traceback
        traceback.print_exc()
        return {"error": str(e)}
