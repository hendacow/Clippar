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
