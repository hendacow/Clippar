"""
run_full_pipeline.py — Download → Shot Detection → Merge → Upload → Email
Full CV pipeline: detects golf shots, extracts clips, merges, delivers.
"""

import sys
import shutil
import subprocess
import tempfile
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()


def download_folder_via_api(folder_id, dest_dir):
    """Download all files from a Drive folder using the API (no 50-file limit)."""
    from drive_utils import _get_oauth_creds
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseDownload

    creds = _get_oauth_creds()
    service = build("drive", "v3", credentials=creds)

    files = []
    page_token = None
    while True:
        resp = service.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            fields="nextPageToken, files(id, name, mimeType)",
            pageSize=100,
            pageToken=page_token,
        ).execute()
        files.extend(resp.get("files", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    video_exts = (".mp4", ".mov")
    video_files = [
        f for f in files
        if any(f["name"].lower().endswith(e) for e in video_exts)
    ]
    video_files.sort(key=lambda f: f["name"].lower())

    print(f"[Download] Found {len(video_files)} video(s) in folder")
    dest = Path(dest_dir)
    for i, f in enumerate(video_files, 1):
        out_path = dest / f["name"]
        print(f"  [{i}/{len(video_files)}] {f['name']}...", end=" ", flush=True)
        request = service.files().get_media(fileId=f["id"])
        with open(out_path, "wb") as fh:
            downloader = MediaIoBaseDownload(fh, request)
            done = False
            while not done:
                status, done = downloader.next_chunk()
        size_mb = out_path.stat().st_size / 1_048_576
        print(f"{size_mb:.1f} MB")

    return len(video_files)


def run(drive_url, recipient_email, customer_name=""):
    from drive_utils import _extract_folder_id, upload_to_drive
    from email_utils import send_result_email

    # ── 1. Download from Drive ──
    work_dir = Path(tempfile.mkdtemp(prefix="full_pipeline_"))
    inputs_dir = work_dir / "inputs"
    outputs_clips = work_dir / "outputs" / "clips"
    merged_output = work_dir / "outputs" / "merged" / "highlight_reel.mov"

    inputs_dir.mkdir(parents=True)
    outputs_clips.mkdir(parents=True)
    merged_output.parent.mkdir(parents=True)

    folder_id = _extract_folder_id(drive_url)
    print(f"[Pipeline] Downloading from Drive (folder: {folder_id})...")
    count = download_folder_via_api(folder_id, str(inputs_dir))
    print(f"[Pipeline] Downloaded {count} video(s)")

    if count == 0:
        print("[Pipeline] No videos found — aborting.")
        sys.exit(1)

    # ── 2. Run shot detection (CV) ──
    print("\n[Pipeline] Running shot detection...")
    from shot_detector import load_config, detect_shots
    cfg = load_config()
    cfg["clips_dir"] = str(inputs_dir)
    cfg["output_dir"] = str(outputs_clips)
    cfg["fast_mode"] = True
    cfg["display"] = False
    cfg["save_annotated"] = False
    cfg["verbose"] = False

    detect_shots(cfg)

    # Count detected clips
    clip_files = list(outputs_clips.glob("*.mov")) + list(outputs_clips.glob("*.mp4")) + \
                 list(outputs_clips.glob("*.MOV")) + list(outputs_clips.glob("*.MP4"))
    clip_count = len(clip_files)
    print(f"\n[Pipeline] Shot detection produced {clip_count} clip(s)")

    if clip_count == 0:
        print("[Pipeline] No shots detected — aborting.")
        sys.exit(1)

    # ── 3. Merge detected clips ──
    print("\n[Pipeline] Merging clips...")
    from merge_clips import load_config as merge_load_config, merge
    merge_cfg = merge_load_config()
    merge_cfg["shots_dir"] = str(outputs_clips)
    merge_cfg["merged_output"] = str(merged_output)
    merge_cfg["include_no_detection"] = True

    merge(merge_cfg)

    if not merged_output.exists():
        print("[Pipeline] Merge produced no output — aborting.")
        sys.exit(1)

    # ── 4. Transcode to mp4 ──
    mp4_output = merged_output.with_suffix(".mp4")
    print("\n[Pipeline] Transcoding to mp4...")
    tc = subprocess.run([
        "ffmpeg", "-y", "-i", str(merged_output),
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-movflags", "+faststart",
        str(mp4_output),
    ], capture_output=True, text=True)
    if tc.returncode != 0:
        print(f"[Pipeline] mp4 transcode warning: {tc.stderr[-300:]}")

    upload_file = mp4_output if mp4_output.exists() else merged_output

    # ── 5. Upload to Drive ──
    print("\n[Pipeline] Uploading merged video to Drive...")
    share_link = upload_to_drive(str(upload_file), upload_file.name)
    print(f"[Pipeline] Share link: {share_link}")

    # ── 6. Send email ──
    if not customer_name:
        customer_name = recipient_email.split("@")[0]
    print(f"[Pipeline] Sending email to {recipient_email}...")
    send_result_email(customer_name, recipient_email, share_link)
    print(f"[Pipeline] Done! Email sent to {recipient_email}")

    # Clean up
    shutil.rmtree(str(work_dir), ignore_errors=True)
    return share_link


if __name__ == "__main__":
    drive_url = "https://drive.google.com/drive/folders/1uJI-uG6J60Dd8S5b5BRhF1IQe74IZir6"
    recipient = "henryjohncoward@gmail.com"
    run(drive_url, recipient, customer_name="Henry")
