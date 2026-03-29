"""
db.py — PostgreSQL database for Clippar (Neon Postgres)
"""

import os
import uuid
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras
import psycopg2.pool
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).parent / ".env", override=True)

_pool = None


def _get_pool():
    global _pool
    if _pool is None:
        database_url = os.environ.get("DATABASE_URL")
        if not database_url:
            raise RuntimeError("DATABASE_URL environment variable is not set")
        _pool = psycopg2.pool.SimpleConnectionPool(1, 5, database_url)
    return _pool


def _connect():
    conn = _get_pool().getconn()
    return conn


def _release(conn):
    _get_pool().putconn(conn)


SCHEMA = """
CREATE TABLE IF NOT EXISTS waitlist (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL UNIQUE,
    frequency   TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    email           TEXT NOT NULL,
    frequency       TEXT,
    drive_link      TEXT,
    status          TEXT DEFAULT 'pending',
    error_message   TEXT,
    admin_note      TEXT,
    result_drive_link TEXT,
    clip_count      INTEGER,
    created_at      TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ
);
"""


def init_db():
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(SCHEMA)
        conn.commit()
    finally:
        _release(conn)


def _now():
    return datetime.now(timezone.utc)


def create_job(name, email, frequency=None, drive_link=None):
    job_id = uuid.uuid4().hex[:12]
    now = _now()
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO jobs (id, name, email, frequency, drive_link, status, created_at, updated_at)
                   VALUES (%s, %s, %s, %s, %s, 'pending', %s, %s)""",
                (job_id, name, email, frequency, drive_link, now, now),
            )
        conn.commit()
    finally:
        _release(conn)
    return job_id


def get_job(job_id):
    conn = _connect()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM jobs WHERE id = %s", (job_id,))
            row = cur.fetchone()
    finally:
        _release(conn)
    return dict(row) if row else None


def list_jobs(status=None):
    conn = _connect()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if status:
                cur.execute(
                    "SELECT * FROM jobs WHERE status = %s ORDER BY created_at DESC", (status,)
                )
            else:
                cur.execute("SELECT * FROM jobs ORDER BY created_at DESC")
            rows = cur.fetchall()
    finally:
        _release(conn)
    return [dict(r) for r in rows]


def update_job(job_id, **fields):
    if not fields:
        return
    fields["updated_at"] = _now()
    set_clause = ", ".join(f"{k} = %s" for k in fields)
    values = list(fields.values()) + [job_id]
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE jobs SET {set_clause} WHERE id = %s", values)
        conn.commit()
    finally:
        _release(conn)


def get_next_pending():
    conn = _connect()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM jobs WHERE status = 'pending' "
                "ORDER BY created_at ASC LIMIT 1"
            )
            row = cur.fetchone()
    finally:
        _release(conn)
    if not row:
        return None
    job = dict(row)
    # Check for uploaded files in R2 or a drive link
    has_link = bool(job.get("drive_link") and job["drive_link"].strip())
    # For R2-based storage, we check if there are files via storage module
    has_files = False
    try:
        import storage
        files = storage.list_files(f"jobs/{job['id']}/inputs/")
        has_files = len(files) > 0
    except Exception:
        # Fallback: check local filesystem (for local dev)
        local_inputs = Path(__file__).parent / "jobs" / job["id"] / "inputs"
        has_files = local_inputs.exists() and any(local_inputs.iterdir())

    if has_files or has_link:
        return job
    return None


# Initialize on import
init_db()
