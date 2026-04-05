"""
drive_utils.py — Google Drive download (gdown) and upload (OAuth2 user account)
"""

import os
import re
import socket
import time
from pathlib import Path

import gdown
from dotenv import dotenv_values, load_dotenv

ENV_PATH = Path(__file__).parent / ".env"
TOKEN_PATH = Path(__file__).parent / "drive_token.json"
load_dotenv(ENV_PATH, override=True)

SCOPES = ["https://www.googleapis.com/auth/drive"]
UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024  # 8 MB chunks are more reliable on large uploads.
UPLOAD_TIMEOUT_SECS = 600
UPLOAD_MAX_RETRIES = 8


def _extract_folder_id(url):
    """Extract Google Drive folder ID from various URL formats."""
    # Strip /u/0/, /u/1/ etc. user-switching prefix
    url = re.sub(r"/u/\d+/", "/", url)
    # https://drive.google.com/drive/folders/FOLDER_ID?usp=sharing
    m = re.search(r"folders/([a-zA-Z0-9_-]+)", url)
    if m:
        return m.group(1)
    # https://drive.google.com/file/d/FILE_ID/view
    m = re.search(r"/d/([a-zA-Z0-9_-]+)", url)
    if m:
        return m.group(1)
    # Bare ID
    if re.fullmatch(r"[a-zA-Z0-9_-]{10,}", url):
        return url
    raise ValueError(f"Cannot extract folder ID from: {url}")


def download_from_drive(url, dest):
    """Download a shared Google Drive folder to `dest` using gdown."""
    folder_id = _extract_folder_id(url)
    gdown.download_folder(id=folder_id, output=dest, quiet=False)


def _get_folder_id():
    env_file = dotenv_values(ENV_PATH) if ENV_PATH.exists() else {}
    folder_id = (
        env_file.get("DRIVE_OUTPUT_FOLDER_ID")
        or os.getenv("DRIVE_OUTPUT_FOLDER_ID")
        or ""
    ).strip()
    if not folder_id or folder_id == "your-drive-folder-id":
        raise RuntimeError("DRIVE_OUTPUT_FOLDER_ID not set in .env")
    return folder_id


def _get_oauth_creds():
    """Load or refresh OAuth2 user credentials from stored token or env var."""
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    creds = None

    # Try loading from file first
    if TOKEN_PATH.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    # Fall back to env var (for Railway/production)
    elif os.environ.get("DRIVE_TOKEN_JSON"):
        import json
        token_data = json.loads(os.environ["DRIVE_TOKEN_JSON"])
        creds = Credentials.from_authorized_user_info(token_data, SCOPES)

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        # Persist refreshed token to file if possible
        try:
            TOKEN_PATH.write_text(creds.to_json())
        except OSError:
            pass  # Read-only filesystem in production is fine
        return creds

    if creds and creds.valid:
        return creds

    raise RuntimeError(
        "Google Drive OAuth not set up. Run: python drive_utils.py --auth\n"
        "Or set DRIVE_TOKEN_JSON environment variable with the token JSON."
    )


def _run_oauth_flow():
    """One-time interactive OAuth2 consent flow. Opens browser."""
    from google_auth_oauthlib.flow import InstalledAppFlow

    client_secrets = Path(__file__).parent / "oauth_credentials.json"
    if not client_secrets.exists():
        print(
            "\n=== Google Drive OAuth Setup ===\n"
            "1. Go to https://console.cloud.google.com\n"
            "2. Select your project (clippar-491303)\n"
            "3. APIs & Services → Credentials → Create Credentials → OAuth client ID\n"
            "4. Application type: Desktop app, Name: Clippar\n"
            "5. Download JSON → save as oauth_credentials.json in this folder\n"
            "6. APIs & Services → OAuth consent screen → add your email as a test user\n"
            "7. Re-run: python drive_utils.py --auth\n"
        )
        raise SystemExit(1)

    flow = InstalledAppFlow.from_client_secrets_file(str(client_secrets), SCOPES)
    creds = flow.run_local_server(port=0)
    TOKEN_PATH.write_text(creds.to_json())
    print(f"✓ Token saved to {TOKEN_PATH}")
    return creds


def _build_drive_service(creds, timeout=UPLOAD_TIMEOUT_SECS):
    """Build a Drive client and raise its underlying HTTP timeout."""
    from googleapiclient.discovery import build

    service = build("drive", "v3", credentials=creds, cache_discovery=False)
    transport = getattr(service, "_http", None)
    raw_http = getattr(transport, "http", transport)
    if raw_http is not None and hasattr(raw_http, "timeout"):
        raw_http.timeout = timeout
    return service


def upload_to_drive(local_path, filename):
    """Upload a file to the admin's Google Drive folder via OAuth2, return share link."""
    from googleapiclient.errors import HttpError
    from googleapiclient.http import MediaFileUpload

    folder_id = _get_folder_id()
    creds = _get_oauth_creds()
    service = _build_drive_service(creds)

    # Verify folder exists
    try:
        service.files().get(fileId=folder_id, fields="id").execute(num_retries=5)
    except HttpError as exc:
        raise RuntimeError(
            f"Drive output folder '{folder_id}' not accessible. Check DRIVE_OUTPUT_FOLDER_ID."
        ) from exc

    file_metadata = {"name": filename, "parents": [folder_id]}
    media = MediaFileUpload(
        local_path,
        resumable=True,
        chunksize=UPLOAD_CHUNK_SIZE,
    )
    request = service.files().create(
        body=file_metadata,
        media_body=media,
        fields="id",
    )

    uploaded = None
    attempt = 0
    last_reported_pct = -1
    while uploaded is None:
        try:
            status, uploaded = request.next_chunk(num_retries=5)
            attempt = 0
            if status:
                pct = int(status.progress() * 100)
                if pct >= last_reported_pct + 10:
                    last_reported_pct = pct
                    print(f"[Drive] Upload progress: {pct}%")
        except HttpError as exc:
            status_code = getattr(exc.resp, "status", None)
            if status_code not in {500, 502, 503, 504} or attempt >= UPLOAD_MAX_RETRIES:
                raise
            attempt += 1
            wait_secs = min(2 ** attempt, 60)
            print(f"[Drive] Transient upload error ({status_code}); retrying in {wait_secs}s...")
            time.sleep(wait_secs)
        except (TimeoutError, socket.timeout, OSError) as exc:
            if attempt >= UPLOAD_MAX_RETRIES:
                raise RuntimeError("Drive upload timed out repeatedly") from exc
            attempt += 1
            wait_secs = min(2 ** attempt, 60)
            print(f"[Drive] Upload interrupted ({exc}); retrying in {wait_secs}s...")
            time.sleep(wait_secs)

    file_id = uploaded["id"]

    # Make shareable via link
    service.permissions().create(
        fileId=file_id,
        body={"type": "anyone", "role": "reader"},
    ).execute(num_retries=5)

    share_url = f"https://drive.google.com/file/d/{file_id}/view?usp=sharing"
    return share_url


if __name__ == "__main__":
    import sys
    if "--auth" in sys.argv:
        _run_oauth_flow()
    else:
        print("Usage: python drive_utils.py --auth")
