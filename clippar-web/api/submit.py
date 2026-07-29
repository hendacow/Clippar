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


# Rate limits for this endpoint. It is public, unauthenticated, has no CAPTCHA,
# and the honeypot below only catches bots that fill every field — a script that
# simply omits "website" walks past it. Without a counter, one loop
#   for i in $(seq 20000); do curl -X POST .../api/submit \
#     -d "{\"name\":\"a\",\"email\":\"victim+$i@gmail.com\"}" & done
# defeats the ON CONFLICT dedupe (every address is unique), opens one Neon
# connection per concurrent invocation, and creates 20,000 Sender.net
# subscribers from arbitrary addresses — blowing the free-tier subscriber quota
# and, if the group has a welcome automation, turning this into an email-bomb
# relay against strangers from Clippar's sending domain.
PER_IP_LIMIT = 5
PER_IP_WINDOW_SECONDS = 3600
# Project-wide ceiling. The per-IP counter bounds one source; IPs are cheap, so
# this is the one that bounds the Sender.net bill and the junk in the table.
# A pre-launch waitlist does not legitimately take 200 signups in a day.
GLOBAL_LIMIT = 200
GLOBAL_WINDOW_SECONDS = 86400
GLOBAL_SUBJECT = "__global__"

# Reused across warm invocations. `psycopg2.connect()` per request meant an
# autoscaling Vercel function opened one Neon connection per concurrent
# invocation with no pooling — the spec's "autoscaling functions must not each
# open uncontrolled database connections". DATABASE_URL should point at Neon's
# POOLED endpoint (the `-pooler` host); that is a dashboard change (owner:
# henry) and this reuse is the half we can fix in code.
_conn = None
_schema_ready = False


def _get_db_conn():
    """Return a live connection, reusing the one from a previous invocation."""
    global _conn
    if _conn is not None:
        try:
            if _conn.closed == 0:
                # Cheap liveness probe; a connection idle since the last
                # invocation may have been dropped by the pooler.
                with _conn.cursor() as cur:
                    cur.execute("SELECT 1")
                return _conn
        except Exception:
            pass
        try:
            _conn.close()
        except Exception:
            pass
        _conn = None

    _conn = psycopg2.connect(os.environ["DATABASE_URL"])
    return _conn


def _ensure_schema(conn):
    """Create the rate-limit counter table once per cold start."""
    global _schema_ready
    if _schema_ready:
        return
    with conn.cursor() as cur:
        cur.execute(
            """CREATE TABLE IF NOT EXISTS waitlist_rate_limit (
                   subject      TEXT PRIMARY KEY,
                   window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
                   count        INTEGER NOT NULL DEFAULT 0
               )"""
        )
    conn.commit()
    _schema_ready = True


def _consume_rate_limit(conn, subject, limit, window_seconds):
    """
    Increment and read `subject`'s counter in ONE statement, returning
    (allowed, retry_after_seconds).

    INSERT ... ON CONFLICT DO UPDATE ... RETURNING takes a row lock for its
    duration, so concurrent invocations serialise on the key and each observes a
    distinct count. A SELECT-then-UPDATE would not: fire 200 requests at once and
    every one reads the same pre-increment value and every one passes, which is
    exactly the abuse pattern this endpoint has to survive.
    """
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO waitlist_rate_limit (subject, window_start, count)
               VALUES (%(s)s, now(), 1)
               ON CONFLICT (subject) DO UPDATE SET
                 count = CASE
                   WHEN waitlist_rate_limit.window_start
                        < now() - make_interval(secs => %(w)s) THEN 1
                   ELSE waitlist_rate_limit.count + 1 END,
                 window_start = CASE
                   WHEN waitlist_rate_limit.window_start
                        < now() - make_interval(secs => %(w)s) THEN now()
                   ELSE waitlist_rate_limit.window_start END
               RETURNING count,
                         EXTRACT(EPOCH FROM (window_start
                           + make_interval(secs => %(w)s) - now()))::int""",
            {"s": subject, "w": window_seconds},
        )
        count, retry_after = cur.fetchone()
    conn.commit()
    return count <= limit, max(1, retry_after or window_seconds)


def _client_ip(headers):
    """
    The caller's IP, for a limit with no authenticated subject.

    Vercel sets x-real-ip to the observed peer address, so prefer it. In
    x-forwarded-for the CLIENT controls the leftmost entry and proxies append to
    the right, so taking [0] — the obvious reading — hands an attacker a fresh
    bucket per request, i.e. no limit at all. Take the last.
    """
    real = (headers.get("x-real-ip") or "").strip()
    if real:
        return real
    xff = headers.get("x-forwarded-for") or ""
    parts = [p.strip() for p in xff.split(",") if p.strip()]
    return parts[-1] if parts else "unknown"


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
            _ensure_schema(conn)
        except Exception:
            self._send_json(500, {"ok": False, "error": "Database connection failed"})
            return

        # Meter BEFORE the insert and before Sender.net, so a flood costs one
        # cheap upsert per request instead of a row, a subscriber and an
        # outbound email. Fails CLOSED: if the counter is unavailable we refuse,
        # because letting an unmetered flood through here spends third-party
        # quota and someone else's inbox.
        try:
            ip_ok, ip_retry = _consume_rate_limit(
                conn, "ip:" + _client_ip(self.headers), PER_IP_LIMIT, PER_IP_WINDOW_SECONDS
            )
            if not ip_ok:
                self._send_json(
                    429,
                    {"ok": False, "error": "Too many requests. Please try again later."},
                    retry_after=ip_retry,
                )
                return

            global_ok, global_retry = _consume_rate_limit(
                conn, GLOBAL_SUBJECT, GLOBAL_LIMIT, GLOBAL_WINDOW_SECONDS
            )
            if not global_ok:
                self._send_json(
                    429,
                    {"ok": False, "error": "Too many requests. Please try again later."},
                    retry_after=global_retry,
                )
                return
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            self._send_json(503, {"ok": False, "error": "Temporarily unavailable"})
            return

        try:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO waitlist (name, email, frequency)
                       VALUES (%s, %s, %s)
                       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, frequency = EXCLUDED.frequency""",
                    (name, email, frequency),
                )
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            self._send_json(500, {"ok": False, "error": "Database error"})
            return

        _add_to_sender(email, name, frequency)
        self._send_json(200, {"ok": True})

    def _send_json(self, status, data, retry_after=None):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        # Spec 7.5 asks for 429 WITH Retry-After — without it a client backs off
        # by guessing and well-behaved clients retry in lockstep.
        if retry_after is not None:
            self.send_header("Retry-After", str(int(retry_after)))
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))
