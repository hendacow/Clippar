"""
Vercel serverless function — handles waitlist signups.
Stores in Neon Postgres and syncs to Mailchimp.
"""

import json
import os

import psycopg2
import requests


def _get_db_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def _add_to_mailchimp(email, name, frequency):
    """Add subscriber to Mailchimp audience. Fails silently."""
    api_key = os.environ.get("MAILCHIMP_API_KEY")
    list_id = os.environ.get("MAILCHIMP_LIST_ID")
    if not api_key or not list_id:
        return

    dc = api_key.split("-")[-1]
    try:
        requests.post(
            f"https://{dc}.api.mailchimp.com/3.0/lists/{list_id}/members",
            auth=("anystring", api_key),
            json={
                "email_address": email,
                "status": "subscribed",
                "merge_fields": {"FNAME": name, "FREQUENCY": frequency},
            },
            timeout=5,
        )
    except Exception:
        pass  # Postgres is source of truth; Mailchimp sync is best-effort


def handler(request):
    if request.method == "OPTIONS":
        return {
            "statusCode": 200,
            "headers": {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
            },
        }

    if request.method != "POST":
        return {"statusCode": 405, "body": json.dumps({"ok": False, "error": "Method not allowed"})}

    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, TypeError):
        return {"statusCode": 400, "body": json.dumps({"ok": False, "error": "Invalid JSON"})}

    name = (body.get("name") or "").strip()
    email = (body.get("email") or "").strip()
    frequency = (body.get("frequency") or "").strip()

    if not name or not email:
        return {"statusCode": 400, "body": json.dumps({"ok": False, "error": "Name and email are required."})}

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
        return {"statusCode": 500, "body": json.dumps({"ok": False, "error": "Database error"})}
    finally:
        conn.close()

    _add_to_mailchimp(email, name, frequency)

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({"ok": True}),
    }
