"""
modal_detector.py — GPU-accelerated shot detection on Modal.

Deployed as a web endpoint that the Render pipeline calls instead of running
YOLO locally. Each call processes one video clip and returns the detected
shot timestamps (trim start/end in seconds).

Usage:
  modal deploy modal_detector.py          # deploy once
  modal serve modal_detector.py           # dev mode with hot-reload

The Render pipeline POSTs a video file → gets back JSON with trim points.
"""

import modal
import os

# ---------------------------------------------------------------------------
# Modal app + container image
# ---------------------------------------------------------------------------

app = modal.App("clippar-shot-detector")

# Build an image with all dependencies + model weights baked in
detector_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0", "libsm6", "libxext6",
                 "libxrender1", "libsndfile1")
    .pip_install(
        "torch", "torchvision",
        "ultralytics",
        "opencv-python-headless",
        "numpy",
        "requests",
        "fastapi",
        "psycopg2-binary",
    )
    .add_local_dir("models", remote_path="/app/models")
)


# ---------------------------------------------------------------------------
# Shot detection logic (simplified for single-clip mobile processing)
# ---------------------------------------------------------------------------

@app.function(
    image=detector_image,
    gpu="T4",
    timeout=300,

)
def detect_shot_in_clip(video_bytes: bytes, filename: str = "clip.mp4") -> dict:
    """Process a single video clip and return the shot trim points.

    Returns:
        {
            "found": bool,
            "impact_time_sec": float,       # time of detected swing impact
            "trim_start_sec": float,         # suggested trim start (2s pre-roll)
            "trim_end_sec": float,            # suggested trim end (3s post-roll)
            "duration_sec": float,            # original clip duration
            "confidence": float,              # 0-1 detection confidence
        }
    """
    import tempfile
    import cv2
    import numpy as np
    import torch
    from pathlib import Path
    from ultralytics import YOLO

    # Write video to temp file
    tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    tmp.write(video_bytes)
    tmp.close()
    video_path = tmp.name

    try:
        # Load models
        pose_model = YOLO("/app/models/yolov8n-pose.pt")
        ball_model = YOLO("/app/models/golfballyolov8n.pt")

        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"[ModalDetector] Device: {device}")

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return {"found": False, "error": "Cannot open video"}

        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duration = total_frames / fps

        PRE_ROLL = 2.0
        POST_ROLL = 3.0
        STRIDE = 2  # process every 2nd frame (GPU is fast enough)

        # Track wrist positions for swing detection
        prev_wrists = None
        max_wrist_speed = 0
        max_wrist_frame = 0
        wrist_speeds = []

        frame_idx = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            frame_idx += 1

            if frame_idx % STRIDE != 1:
                continue

            # Pose detection
            pose_res = pose_model.predict(
                source=frame, conf=0.4, verbose=False,
                device=device, imgsz=640
            )

            # Extract wrist keypoints (indices 9=left_wrist, 10=right_wrist)
            kp = None
            if (pose_res[0].keypoints is not None
                    and len(pose_res[0].keypoints) > 0):
                kp = pose_res[0].keypoints[0].xy[0].cpu().numpy()

            if kp is not None and len(kp) > 10:
                left_wrist = kp[9]
                right_wrist = kp[10]
                avg_wrist = (left_wrist + right_wrist) / 2.0

                if prev_wrists is not None:
                    speed = np.linalg.norm(avg_wrist - prev_wrists)
                    wrist_speeds.append((frame_idx, speed))
                    if speed > max_wrist_speed:
                        max_wrist_speed = speed
                        max_wrist_frame = frame_idx

                prev_wrists = avg_wrist

        cap.release()

        # Find the swing: the frame with maximum wrist speed
        if max_wrist_speed < 15.0 or not wrist_speeds:
            # No clear swing detected — return center trim as fallback
            center = duration / 2.0
            return {
                "found": False,
                "impact_time_sec": center,
                "trim_start_sec": max(0, center - PRE_ROLL),
                "trim_end_sec": min(duration, center + POST_ROLL),
                "duration_sec": duration,
                "confidence": 0.0,
            }

        impact_time = max_wrist_frame / fps

        # Confidence based on how much the peak stands out
        speeds_arr = np.array([s for _, s in wrist_speeds])
        median_speed = np.median(speeds_arr)
        confidence = min(1.0, (max_wrist_speed / max(median_speed, 1.0)) / 10.0)

        return {
            "found": True,
            "impact_time_sec": round(impact_time, 2),
            "trim_start_sec": round(max(0, impact_time - PRE_ROLL), 2),
            "trim_end_sec": round(min(duration, impact_time + POST_ROLL), 2),
            "duration_sec": round(duration, 2),
            "confidence": round(confidence, 2),
        }

    finally:
        os.unlink(video_path)


# ---------------------------------------------------------------------------
# Web endpoint — the Render pipeline calls this via HTTP
# ---------------------------------------------------------------------------

@app.function(
    image=detector_image,
    gpu="T4",
    timeout=300,

)
@modal.fastapi_endpoint(method="POST")
def detect_shot_endpoint(request: dict) -> dict:
    """HTTP endpoint for shot detection.

    Accepts JSON with:
      - video_url: URL to download the video from (e.g. Supabase signed URL)
      - filename: optional filename

    Returns JSON with trim points.
    """
    import requests as req

    video_url = request.get("video_url")
    filename = request.get("filename", "clip.mp4")

    if not video_url:
        return {"error": "video_url required"}

    # Download the video
    print(f"[ModalDetector] Downloading {filename} from Supabase...")
    resp = req.get(video_url, timeout=120)
    if resp.status_code != 200:
        return {"error": f"Download failed: {resp.status_code}"}

    video_bytes = resp.content
    print(f"[ModalDetector] Downloaded {len(video_bytes) // 1024}KB — running detection...")

    # Run detection
    result = detect_shot_in_clip.local(video_bytes, filename)
    print(f"[ModalDetector] Result: {result}")
    return result


# ---------------------------------------------------------------------------
# Batch endpoint — process multiple clips in one call
# ---------------------------------------------------------------------------

@app.function(
    image=detector_image,
    gpu="T4",
    timeout=600,

)
@modal.fastapi_endpoint(method="POST")
def detect_shots_batch(request: dict) -> dict:
    """Process multiple clips in a single GPU session.

    Accepts JSON with:
      - clips: list of {video_url, filename}
      - supabase_url: base Supabase URL
      - supabase_key: service key for downloading

    Returns JSON with results per clip.
    """
    import requests as req

    clips = request.get("clips", [])
    supabase_url = request.get("supabase_url", "")
    supabase_key = request.get("supabase_key", "")

    if not clips:
        return {"error": "No clips provided"}

    results = []
    for i, clip_info in enumerate(clips):
        video_url = clip_info.get("video_url", "")
        filename = clip_info.get("filename", f"clip_{i}.mp4")

        # If video_url is a storage path, build the full download URL
        if not video_url.startswith("http") and supabase_url and supabase_key:
            video_url = f"{supabase_url}/storage/v1/object/clips/{video_url}"

        headers = {}
        if supabase_key:
            headers = {
                "apikey": supabase_key,
                "Authorization": f"Bearer {supabase_key}",
            }

        try:
            print(f"[ModalDetector] [{i+1}/{len(clips)}] Downloading {filename}...")
            resp = req.get(video_url, headers=headers, timeout=120)
            if resp.status_code != 200:
                results.append({"filename": filename, "found": False,
                                "error": f"Download failed: {resp.status_code}"})
                continue

            video_bytes = resp.content
            if len(video_bytes) < 1000:
                results.append({"filename": filename, "found": False,
                                "error": f"File too small ({len(video_bytes)} bytes)"})
                continue

            print(f"[ModalDetector] [{i+1}/{len(clips)}] Detecting in {filename} ({len(video_bytes)//1024}KB)...")
            result = detect_shot_in_clip.local(video_bytes, filename)
            result["filename"] = filename
            results.append(result)

        except Exception as e:
            results.append({"filename": filename, "found": False, "error": str(e)})

    return {"ok": True, "results": results}


# ---------------------------------------------------------------------------
# Full pipeline endpoint — download, detect, trim, merge, upload reel
# Runs entirely on Modal so Render doesn't need to do heavy work.
# ---------------------------------------------------------------------------

@app.function(
    image=detector_image,
    gpu="T4",
    timeout=600,

)
@modal.fastapi_endpoint(method="POST")
def run_full_pipeline(request: dict) -> dict:
    """Full pipeline: download clips → detect swings → trim → merge → upload reel.

    Accepts JSON with:
      - job_id: round UUID
      - supabase_url: Supabase URL
      - supabase_key: service role key
      - neon_database_url: Neon Postgres connection string for job status updates

    Returns JSON with reel_url on success.
    """
    import requests as req
    import tempfile
    import subprocess as sp
    import cv2
    import numpy as np
    import torch
    from pathlib import Path
    from ultralytics import YOLO

    job_id = request.get("job_id")
    supabase_url = request.get("supabase_url", "")
    supabase_key = request.get("supabase_key", "")
    neon_url = request.get("neon_database_url", "")

    if not job_id or not supabase_url or not supabase_key:
        return {"error": "job_id, supabase_url, supabase_key required"}

    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
    }

    def update_job(status=None, progress=None, stage_detail=None, **extra):
        """Update job in Neon DB if available."""
        if not neon_url:
            return
        try:
            import psycopg2
            conn = psycopg2.connect(neon_url)
            sets = []
            vals = []
            if status:
                sets.append("status = %s")
                vals.append(status)
            if progress is not None:
                sets.append("progress = %s")
                vals.append(progress)
            if stage_detail:
                sets.append("stage_detail = %s")
                vals.append(stage_detail)
            for k, v in extra.items():
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

    try:
        # ── 1. Download clips from Supabase Storage ──
        update_job(status="downloading", progress=5, stage_detail="Downloading clips...")

        list_resp = req.post(
            f"{supabase_url}/storage/v1/object/list/clips",
            headers={**headers, "Content-Type": "application/json"},
            json={"prefix": f"{job_id}/", "limit": 100},
        )
        if list_resp.status_code != 200:
            update_job(status="processing_failed", stage_detail=f"Failed to list clips: {list_resp.status_code}")
            return {"error": f"Failed to list clips: {list_resp.status_code}"}

        files = [f for f in list_resp.json()
                 if f.get("name", "").endswith((".mp4", ".mov", ".MP4", ".MOV"))]
        if not files:
            update_job(status="processing_failed", stage_detail="No clips found in storage")
            return {"error": "No clips found"}

        work_dir = Path(tempfile.mkdtemp(prefix=f"clippar_{job_id}_"))
        inputs_dir = work_dir / "inputs"
        clips_dir = work_dir / "clips"
        inputs_dir.mkdir()
        clips_dir.mkdir()

        total = len(files)
        print(f"[Pipeline] Downloading {total} clips...")
        for idx, f in enumerate(files):
            fname = f["name"]
            update_job(progress=5 + int((idx / total) * 15),
                       stage_detail=f"Downloading clip {idx+1} of {total}")
            dl = req.get(f"{supabase_url}/storage/v1/object/clips/{job_id}/{fname}", headers=headers)
            if dl.status_code == 200 and len(dl.content) > 1000:
                (inputs_dir / fname).write_bytes(dl.content)
                print(f"  Downloaded {fname} ({len(dl.content)//1024}KB)")

        input_files = sorted(inputs_dir.glob("*"))
        if not input_files:
            update_job(status="processing_failed", stage_detail="All downloads failed")
            return {"error": "No clips downloaded"}

        # ── 2. Detect swings with YOLO on GPU ──
        update_job(status="detecting", progress=20,
                   stage_detail=f"Detecting swings in {len(input_files)} clips...")

        pose_model = YOLO("/app/models/yolov8n-pose.pt")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"[Pipeline] Detection device: {device}")

        trim_map = {}
        PRE_ROLL, POST_ROLL = 2.0, 3.0

        for idx, clip_path in enumerate(input_files):
            update_job(progress=20 + int(((idx+1) / len(input_files)) * 15),
                       stage_detail=f"Analysing clip {idx+1} of {len(input_files)}...")

            video_bytes = clip_path.read_bytes()
            result = detect_shot_in_clip.local(video_bytes, clip_path.name)

            if result.get("trim_start_sec") is not None:
                trim_map[clip_path.name] = (result["trim_start_sec"], result["trim_end_sec"])
                print(f"  {clip_path.name}: {'swing' if result['found'] else 'center'} "
                      f"{result['trim_start_sec']:.1f}s-{result['trim_end_sec']:.1f}s")

        # ── 3. Trim clips with FFmpeg ──
        update_job(status="merging", progress=40, stage_detail="Trimming clips...")

        for idx, clip_path in enumerate(input_files):
            if clip_path.name in trim_map:
                start, end = trim_map[clip_path.name]
                trim_dur = end - start
            else:
                # Probe duration
                try:
                    probe = sp.run(["ffprobe", "-v", "quiet", "-show_entries",
                                    "format=duration", "-of", "csv=p=0", str(clip_path)],
                                   capture_output=True, text=True, timeout=30)
                    dur = float(probe.stdout.strip())
                except Exception:
                    dur = 15.0
                start = max(0, (dur - 5.0) / 2.0)
                trim_dur = min(5.0, dur)

            out = clips_dir / f"clip{idx+1:03d}_{clip_path.stem}.mp4"
            sp.run(["ffmpeg", "-y", "-ss", f"{start:.2f}", "-i", str(clip_path),
                    "-t", f"{trim_dur:.2f}", "-c:v", "libx264", "-preset", "ultrafast",
                    "-c:a", "aac", "-b:a", "128k", str(out)],
                   capture_output=True, text=True, timeout=120)

        trimmed = sorted(clips_dir.glob("*.mp4"))
        if not trimmed:
            # Fallback: use originals
            import shutil
            for f in input_files:
                shutil.copy2(str(f), str(clips_dir / f.name))
            trimmed = sorted(clips_dir.glob("*"))

        update_job(clip_count=len(trimmed), progress=50,
                   stage_detail=f"Merging {len(trimmed)} clips...")

        # ── 4. Merge clips using FFmpeg concat ──
        merged_path = work_dir / "highlight_reel.mp4"
        concat_file = work_dir / "concat.txt"
        with open(concat_file, "w") as cf:
            for t in trimmed:
                cf.write(f"file '{t}'\n")

        merge_result = sp.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file),
             "-c:v", "libx264", "-preset", "fast", "-crf", "23",
             "-c:a", "aac", "-movflags", "+faststart", str(merged_path)],
            capture_output=True, text=True, timeout=300
        )

        if merge_result.returncode != 0 or not merged_path.exists():
            err = merge_result.stderr[-300:] if merge_result.stderr else "Unknown error"
            update_job(status="processing_failed", stage_detail=f"Merge failed: {err[:100]}")
            return {"error": f"Merge failed: {err}"}

        print(f"[Pipeline] Merged reel: {merged_path.stat().st_size // 1024}KB")

        # ── 5. Upload reel to Supabase Storage ──
        update_job(status="uploading_reel", progress=85,
                   stage_detail="Uploading highlight reel...")

        reel_storage_path = f"reels/{job_id}/highlight.mp4"
        with open(merged_path, "rb") as f:
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

        # ── 6. Update round in Supabase ──
        req.patch(
            f"{supabase_url}/rest/v1/rounds?id=eq.{job_id}",
            json={"reel_url": reel_url, "status": "ready"},
            headers={**headers, "Content-Type": "application/json", "Prefer": "return=minimal"},
        )

        update_job(status="ready_for_review", progress=100,
                   stage_detail="Highlight reel ready!")

        # Clean up
        import shutil
        shutil.rmtree(str(work_dir), ignore_errors=True)

        return {"ok": True, "reel_url": reel_url, "clips_processed": len(trimmed)}

    except Exception as e:
        update_job(status="processing_failed", stage_detail=str(e)[:200])
        return {"error": str(e)}
