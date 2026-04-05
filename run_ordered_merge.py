"""
run_ordered_merge.py — Download pre-ordered clips from Drive, merge, upload, email.
Skips shot detection since clips are already ordered.
"""

import os
import sys
import shutil
import tempfile
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()


def download_folder_via_api(folder_id, dest_dir):
    """Download all files from a Drive folder using the API (no 50-file limit)."""
    from drive_utils import _get_oauth_creds
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseDownload
    import io

    creds = _get_oauth_creds()
    service = build("drive", "v3", credentials=creds)

    # List all files in the folder
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

    # Filter to video files and sort by name
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
    work_dir = Path(tempfile.mkdtemp(prefix="ordered_merge_"))
    inputs_dir = work_dir / "inputs"
    inputs_dir.mkdir()

    folder_id = _extract_folder_id(drive_url)
    print(f"[OrderedMerge] Downloading from Drive (folder: {folder_id})...")
    download_folder_via_api(folder_id, str(inputs_dir))

    # Collect video files
    exts = (".mp4", ".mov", ".MP4", ".MOV")
    videos = sorted(
        [f for f in inputs_dir.iterdir() if f.suffix in exts],
        key=lambda p: p.name.lower()
    )
    print(f"[OrderedMerge] Found {len(videos)} video(s)")
    for v in videos:
        print(f"  {v.name}")

    if not videos:
        print("[OrderedMerge] No videos found — aborting.")
        sys.exit(1)

    # ── 2. Merge in filename order ──
    from merge_clips import load_config, merge
    cfg = load_config()
    cfg["shots_dir"] = str(inputs_dir)
    merged_output = work_dir / "merged" / "highlight_reel.mov"
    merged_output.parent.mkdir(parents=True, exist_ok=True)
    cfg["merged_output"] = str(merged_output)
    cfg["include_no_detection"] = True  # include everything

    print(f"[OrderedMerge] Merging {len(videos)} clips...")
    merge(cfg)

    if not merged_output.exists():
        print("[OrderedMerge] Merge produced no output — aborting.")
        sys.exit(1)

    # Also transcode to mp4
    import subprocess
    mp4_output = merged_output.with_suffix(".mp4")
    print("[OrderedMerge] Transcoding to mp4...")
    tc = subprocess.run([
        "ffmpeg", "-y", "-i", str(merged_output),
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-movflags", "+faststart",
        str(mp4_output),
    ], capture_output=True, text=True)
    if tc.returncode != 0:
        print(f"[OrderedMerge] mp4 transcode warning: {tc.stderr[-300:]}")

    # Use mp4 if available, otherwise mov
    upload_file = mp4_output if mp4_output.exists() else merged_output

    # ── 3. Upload to Drive ──
    print("[OrderedMerge] Uploading merged video to Drive...")
    share_link = upload_to_drive(str(upload_file), upload_file.name)
    print(f"[OrderedMerge] Share link: {share_link}")

    # ── 4. Send email ──
    if not customer_name:
        customer_name = recipient_email.split("@")[0]
    print(f"[OrderedMerge] Sending email to {recipient_email}...")
    send_result_email(customer_name, recipient_email, share_link)
    print(f"[OrderedMerge] Done! Email sent to {recipient_email}")

    # Clean up
    shutil.rmtree(str(work_dir), ignore_errors=True)
    return share_link


if __name__ == "__main__":
    drive_url = "https://drive.google.com/drive/folders/1uJI-uG6J60Dd8S5b5BRhF1IQe74IZir6"
    recipient = "henryjohncoward@gmail.com"
    run(drive_url, recipient, customer_name="Henry")
