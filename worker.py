"""
worker.py — Background thread that polls for pending jobs and runs the pipeline.
"""

import os
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone

import db


def _use_r2():
    return bool(os.environ.get("R2_ENDPOINT"))


MODAL_PIPELINE_URL = os.environ.get(
    "MODAL_PIPELINE_URL",
    "https://hendacow--clippar-shot-detector-run-full-pipeline.modal.run"
)


def _poll_loop():
    """Poll for the next pending job every 10 seconds and dispatch to Modal."""
    while True:
        job = db.get_next_pending()
        if job:
            job_id = job["id"]
            print(f"[Worker] Picked up job {job_id} — dispatching to Modal GPU pipeline")
            db.update_job(job_id, status="downloading", progress=2,
                          stage_detail="Starting pipeline...")

            supabase_url = os.environ.get("SUPABASE_URL", "")
            supabase_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
            neon_url = os.environ.get("DATABASE_URL", "")

            try:
                import requests
                resp = requests.post(MODAL_PIPELINE_URL, json={
                    "job_id": job_id,
                    "supabase_url": supabase_url,
                    "supabase_key": supabase_key,
                    "neon_database_url": neon_url,
                }, timeout=540)  # 9 min timeout (Modal has 10 min)

                if resp.status_code == 200:
                    data = resp.json()
                    if data.get("ok"):
                        print(f"[Worker] Job {job_id} completed — reel: {data.get('reel_url', 'N/A')}")
                    else:
                        error = data.get("error", "Unknown error")
                        print(f"[Worker] Job {job_id} failed: {error}")
                        current = db.get_job(job_id)
                        if current and current["status"] not in ("processing_failed", "ready_for_review"):
                            db.update_job(job_id, status="processing_failed", error_message=error[:500])
                else:
                    print(f"[Worker] Modal returned {resp.status_code}: {resp.text[:200]}")
                    db.update_job(job_id, status="processing_failed",
                                  error_message=f"Modal error: {resp.status_code}")
            except requests.exceptions.Timeout:
                print(f"[Worker] Modal request timed out for {job_id} — checking status...")
                # Modal might still be running — don't mark as failed
                # The Modal function updates the DB directly
            except Exception as e:
                print(f"[Worker] Error dispatching {job_id}: {e}")
                db.update_job(job_id, status="processing_failed", error_message=str(e)[:500])

        time.sleep(10)


def _update_supabase(job_id, status="ready", reel_url=None):
    """Update Supabase rounds table with processing results."""
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not supabase_url or not supabase_key:
        print(f"[Worker] Supabase not configured, skipping update for {job_id}")
        return

    try:
        import requests
    except ImportError:
        print("[Worker] requests not installed, skipping Supabase update")
        return

    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }

    data = {
        "status": status,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    # Generate reel URL if not provided and status is ready
    if reel_url is None and status == "ready" and _use_r2():
        import storage
        for ext in [".mp4", ".mov"]:
            try:
                reel_url = storage.get_presigned_url(
                    f"jobs/{job_id}/outputs/merged/highlight_reel{ext}",
                    expires_in=86400 * 30,  # 30 days
                )
                break
            except Exception:
                continue

    if reel_url:
        data["reel_url"] = reel_url

    try:
        resp = requests.patch(
            f"{supabase_url}/rest/v1/rounds?id=eq.{job_id}",
            json=data,
            headers=headers,
        )
        if resp.status_code < 300:
            print(f"[Worker] Updated Supabase round {job_id} -> {status}")
        else:
            print(f"[Worker] Supabase update failed: {resp.status_code} {resp.text}")
    except Exception as e:
        print(f"[Worker] Supabase update error: {e}")


def _auto_deliver(job_id):
    """Auto-approve: upload to Drive and email the customer."""
    from pathlib import Path
    from drive_utils import upload_to_drive
    from email_utils import send_result_email

    job = db.get_job(job_id)
    if not job or job["status"] != "ready_for_review":
        return

    # Find merged video
    merged_path = None
    tmp_path = None

    if _use_r2():
        import storage
        for ext in [".mp4", ".mov"]:
            key = f"jobs/{job_id}/outputs/merged/highlight_reel{ext}"
            try:
                tmp_path = os.path.join(tempfile.gettempdir(), f"clippar_{job_id}_deliver{ext}")
                storage.download_file(key, tmp_path)
                merged_path = tmp_path
                break
            except Exception:
                continue
    else:
        base = Path("jobs") / job_id / "outputs" / "merged"
        mp4_path = base / "highlight_reel.mp4"
        mov_path = base / "highlight_reel.mov"
        merged_path = str(mp4_path) if mp4_path.exists() else str(mov_path) if mov_path.exists() else None

    if not merged_path:
        print(f"[Worker] No merged video for {job_id}, skipping auto-deliver")
        return

    ext = Path(merged_path).suffix
    db.update_job(job_id, status="uploading")
    try:
        share_url = upload_to_drive(str(merged_path), f"clippar_{job_id}_highlight{ext}")
        db.update_job(job_id, status="approved", result_drive_link=share_url)
        print(f"[Worker] Uploaded {job_id} → {share_url}")
    except Exception as e:
        db.update_job(job_id, status="upload_failed", error_message=str(e))
        print(f"[Worker] Upload failed for {job_id}: {e}")
        return
    finally:
        # Clean up temp file
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

    try:
        send_result_email(job["name"], job["email"], share_url)
        db.update_job(job_id, status="delivered")
        print(f"[Worker] Emailed {job['email']} for job {job_id}")
    except Exception as e:
        db.update_job(job_id, status="approved", error_message=f"Email failed: {e}")
        print(f"[Worker] Email failed for {job_id}: {e}")


def _sweep_stale():
    """On startup, auto-deliver any jobs stuck in ready_for_review."""
    stale = db.list_jobs(status="ready_for_review")
    for job in stale:
        print(f"[Worker] Found stale ready_for_review job {job['id']} — auto-delivering")
        _auto_deliver(job["id"])


def _reset_stuck_jobs():
    """On startup, reset any in-progress jobs back to pending.
    These were likely killed by a server restart / deploy."""
    stuck_statuses = ["downloading", "detecting", "merging", "post_processing",
                      "transcoding", "uploading_reel"]
    for status in stuck_statuses:
        for job in db.list_jobs(status=status):
            print(f"[Worker] Resetting stuck job {job['id']} (was '{status}') → pending")
            db.update_job(job["id"], status="pending", progress=0,
                          stage_detail="Requeued after server restart")


def start_worker():
    """Launch the polling loop as a daemon thread."""
    _reset_stuck_jobs()
    _sweep_stale()
    t = threading.Thread(target=_poll_loop, daemon=True, name="clippar-worker")
    t.start()
    print("[Worker] Background worker started")
