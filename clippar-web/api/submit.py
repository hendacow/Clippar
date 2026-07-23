"""
Vercel serverless function — handles waitlist signups.
Stores in Neon Postgres and syncs to Sender.net.
"""

import json
import os
import re

from http.server import BaseHTTPRequestHandler
import psycopg2
import requests

# Basic server-side validation limits. The endpoint is public and
# unauthenticated, so it must not trust the client to have validated anything.
MAX_BODY_BYTES = 4096
MAX_NAME_LEN = 120
MAX_EMAIL_LEN = 254
ALLOWED_FREQUENCIES = {"", "weekly", "fortnightly", "monthly", "occasional"}
# Pragmatic RFC-5321-ish email shape check: one @, no spaces, a dotted domain.
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _get_db_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def _add_to_sender(email, name, frequency):
    """Add subscriber to Sender.net group. Fails silently."""
    api_token = os.environ.get("SENDER_API_TOKEN")
    group_id = os.environ.get("SENDER_GROUP_ID")
    if not api_token or not group_id:
        return

    try:
        requests.post(
            "https://api.sender.net/v2/subscribers",
            headers={
                "Authorization": f"Bearer {api_token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json={
                "email": email,
                "firstname": name,
                "groups": [group_id],
                "fields": {"frequency": frequency},
            },
            timeout=5,
        )
    except Exception:
        pass  # Postgres is source of truth; Sender sync is best-effort


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            content_length = 0

        # Cap the body before reading it so an oversized payload can't be used
        # to exhaust memory on this public endpoint.
        if content_length > MAX_BODY_BYTES:
            self._send_json(413, {"ok": False, "error": "Payload too large"})
            return

        body_bytes = self.rfile.read(content_length)

        try:
            body = json.loads(body_bytes.decode("utf-8"))
        except (json.JSONDecodeError, TypeError, UnicodeDecodeError):
            self._send_json(400, {"ok": False, "error": "Invalid JSON"})
            return
        if not isinstance(body, dict):
            self._send_json(400, {"ok": False, "error": "Invalid JSON"})
            return

        # Honeypot: a hidden form field real users never fill. Bots that blindly
        # populate every input trip it. Ack with 200 so the bot sees success,
        # but write nothing and never touch Sender.net.
        if (body.get("website") or "").strip():
            self._send_json(200, {"ok": True})
            return

        name = (body.get("name") or "").strip()
        email = (body.get("email") or "").strip()
        frequency = (body.get("frequency") or "").strip()

        if not name or not email:
            self._send_json(400, {"ok": False, "error": "Name and email are required."})
            return

        # Server-side format/length validation. Without this the endpoint
        # accepts arbitrary victim addresses and unbounded strings.
        if len(name) > MAX_NAME_LEN or len(email) > MAX_EMAIL_LEN:
            self._send_json(400, {"ok": False, "error": "Name or email too long."})
            return
        if not EMAIL_RE.match(email):
            self._send_json(400, {"ok": False, "error": "Please enter a valid email address."})
            return
        if frequency not in ALLOWED_FREQUENCIES:
            self._send_json(400, {"ok": False, "error": "Invalid frequency."})
            return

        try:
            conn = _get_db_conn()
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """INSERT INTO waitlist (name, email, frequency)
                           VALUES (%s, %s, %s)
                           ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, frequency = EXCLUDED.frequency""",
                        (name, email, frequency),
                    )
                conn.commit()
            except Exception as e:
                conn.rollback()
                self._send_json(500, {"ok": False, "error": "Database error"})
                return
            finally:
                conn.close()
        except Exception as e:
            self._send_json(500, {"ok": False, "error": "Database connection failed"})
            return

        _add_to_sender(email, name, frequency)
        self._send_json(200, {"ok": True})

    def _send_json(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))
