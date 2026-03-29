"""
app.py — Flask app for Clippar concierge MVP (production-ready)
"""

import os
import functools
import tempfile
from pathlib import Path

from flask import (
    Flask, request, jsonify, render_template, redirect,
    url_for, session, send_file, Response,
)
from dotenv import load_dotenv

import db

load_dotenv(Path(__file__).parent / ".env", override=True)

app = Flask(
    __name__,
    static_folder="static",
    template_folder="templates",
)
app.secret_key = os.getenv("SECRET_KEY", "dev-fallback-key")
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024 * 1024  # 2GB max upload
app.config["SESSION_COOKIE_SECURE"] = os.getenv("FLASK_ENV") != "development"
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "clippar2024")


def _use_r2():
    """Check if R2 storage is configured."""
    return bool(os.environ.get("R2_ENDPOINT"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def admin_required(f):
    @functools.wraps(f)
    def wrapped(*args, **kwargs):
        if not session.get("admin"):
            return redirect(url_for("admin_login_page"))
        return f(*args, **kwargs)
    return wrapped

# ---------------------------------------------------------------------------
# Public routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_file("static/landing.html")


@app.route("/api/submit", methods=["POST"])
def api_submit():
    # Handle both JSON and multipart form data
    if request.content_type and "multipart" in request.content_type:
        name = (request.form.get("name") or "").strip()
        email = (request.form.get("email") or "").strip()
        frequency = (request.form.get("frequency") or "").strip()
        drive_link = (request.form.get("driveLink") or "").strip()
        files = request.files.getlist("videos")
    else:
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        email = (data.get("email") or "").strip()
        frequency = (data.get("frequency") or "").strip()
        drive_link = (data.get("driveLink") or "").strip()
        files = []

    if not name or not email:
        return jsonify(ok=False, error="Name and email are required."), 400

    if not files and not drive_link:
        return jsonify(ok=False, error="Please upload videos or provide a Google Drive link."), 400

    job_id = db.create_job(name, email, frequency=frequency, drive_link=drive_link)

    # Save uploaded files
    if files:
        if _use_r2():
            import storage
            saved = 0
            for f in files:
                if f.filename:
                    safe_name = Path(f.filename).name
                    # Save to temp file, then upload to R2
                    with tempfile.NamedTemporaryFile(delete=False, suffix=Path(safe_name).suffix) as tmp:
                        f.save(tmp.name)
                        storage.upload_file(tmp.name, f"jobs/{job_id}/inputs/{safe_name}")
                        os.unlink(tmp.name)
                    saved += 1
        else:
            inputs_dir = Path("jobs") / job_id / "inputs"
            inputs_dir.mkdir(parents=True, exist_ok=True)
            saved = 0
            for f in files:
                if f.filename:
                    safe_name = Path(f.filename).name
                    f.save(str(inputs_dir / safe_name))
                    saved += 1

        if saved > 0:
            db.update_job(job_id, clip_count=saved)

    return jsonify(ok=True, job_id=job_id)

# ---------------------------------------------------------------------------
# Admin routes
# ---------------------------------------------------------------------------

@app.route("/admin/login", methods=["GET"])
def admin_login_page():
    return render_template("admin_login.html")


@app.route("/admin/login", methods=["POST"])
def admin_login():
    password = request.form.get("password", "")
    if password == ADMIN_PASSWORD:
        session["admin"] = True
        return redirect(url_for("admin_dashboard"))
    return render_template("admin_login.html", error="Wrong password.")


@app.route("/admin/logout")
def admin_logout():
    session.pop("admin", None)
    return redirect(url_for("admin_login_page"))


@app.route("/admin")
@admin_required
def admin_dashboard():
    status_filter = request.args.get("status")
    jobs = db.list_jobs(status=status_filter)
    return render_template("admin.html", jobs=jobs, status_filter=status_filter)


@app.route("/admin/approve/<job_id>", methods=["POST"])
@admin_required
def admin_approve(job_id):
    job = db.get_job(job_id)
    if not job:
        return "Job not found", 404

    admin_note = request.form.get("admin_note", "").strip()
    if admin_note:
        db.update_job(job_id, admin_note=admin_note)

    # Upload to Drive and email customer
    from drive_utils import upload_to_drive
    from email_utils import send_result_email

    # Find merged video (R2 or local)
    merged_path = _get_merged_video_path(job_id)
    if not merged_path:
        return "Merged video not found", 404

    ext = Path(merged_path).suffix
    db.update_job(job_id, status="uploading")
    try:
        share_url = upload_to_drive(str(merged_path), f"clippar_{job_id}_highlight{ext}")
        db.update_job(
            job_id,
            status="approved",
            result_drive_link=share_url,
            error_message=None,
        )
    except Exception as e:
        db.update_job(job_id, status="upload_failed", error_message=str(e))
        return redirect(url_for("admin_dashboard"))

    try:
        send_result_email(job["name"], job["email"], share_url)
        db.update_job(job_id, status="delivered", error_message=None)
    except Exception as e:
        db.update_job(job_id, status="approved", error_message=f"Email failed: {e}")

    # Clean up temp file if downloaded from R2
    if _use_r2() and merged_path.startswith(tempfile.gettempdir()):
        os.unlink(merged_path)

    return redirect(url_for("admin_dashboard"))


@app.route("/admin/reject/<job_id>", methods=["POST"])
@admin_required
def admin_reject(job_id):
    admin_note = request.form.get("admin_note", "").strip()
    db.update_job(job_id, status="rejected", admin_note=admin_note)
    return redirect(url_for("admin_dashboard"))


@app.route("/admin/preview/<job_id>")
@admin_required
def admin_preview(job_id):
    if _use_r2():
        import storage
        # Try to get presigned URL for streaming
        for ext in [".mp4", ".mov"]:
            key = f"jobs/{job_id}/outputs/merged/highlight_reel{ext}"
            try:
                url = storage.get_presigned_url(key)
                return redirect(url)
            except Exception:
                continue
        return "No merged video yet", 404
    else:
        base = Path(__file__).parent / "jobs" / job_id / "outputs" / "merged"
        mp4_path = base / "highlight_reel.mp4"
        mov_path = base / "highlight_reel.mov"
        video_path = mp4_path if mp4_path.exists() else mov_path
        if not video_path.exists():
            return "No merged video yet", 404
        return send_file(
            str(video_path.resolve()),
            mimetype="video/mp4",
            conditional=True,
        )


def _get_merged_video_path(job_id):
    """Get path to merged video, downloading from R2 if needed."""
    if _use_r2():
        import storage
        for ext in [".mp4", ".mov"]:
            key = f"jobs/{job_id}/outputs/merged/highlight_reel{ext}"
            try:
                tmp_path = os.path.join(tempfile.gettempdir(), f"clippar_{job_id}_merged{ext}")
                storage.download_file(key, tmp_path)
                return tmp_path
            except Exception:
                continue
        return None
    else:
        base = Path("jobs") / job_id / "outputs" / "merged"
        mp4_path = base / "highlight_reel.mp4"
        mov_path = base / "highlight_reel.mov"
        merged_path = mp4_path if mp4_path.exists() else mov_path
        return str(merged_path) if merged_path.exists() else None


# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------

# Start worker on module load (works with both gunicorn and direct run)
from worker import start_worker
start_worker()

if __name__ == "__main__":
    port = int(os.getenv("PORT", 5050))
    app.run(host="0.0.0.0", port=port, debug=False)
