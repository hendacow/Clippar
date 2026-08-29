#!/usr/bin/env python3
"""Export the Neon waitlist into Sender- and Shopify-shaped CSVs.

Re-run before importing: rows may have been added since the last export, and the
Vercel endpoint keeps accepting signups until the domain moves.

    ../.venv/bin/python export_waitlist.py

Reads DATABASE_URL from ../.env. Test rows are excluded by default; pass --all to
keep them.
"""

import csv
import os
import sys

import psycopg2

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(HERE, os.pardir, ".env")

# Two rows in the table are seeded test signups, not real people.
TEST_DOMAINS = {"test.com", "clippar.com"}


def load_env(path):
    """Minimal .env reader. Values are unquoted but not shell-expanded, which
    matters because DATABASE_URL contains an unescaped `&` that breaks `source`."""
    env = {}
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def split_name(raw):
    name = (raw or "").strip()
    if not name:
        return "", ""
    # split(" ", 1) alone leaves a leading space on the surname when the source
    # row has a double space, which at least one of these does.
    parts = name.split(" ", 1)
    return parts[0].strip(), parts[1].strip() if len(parts) > 1 else ""


def main():
    keep_tests = "--all" in sys.argv
    env = load_env(ENV_PATH)

    conn = psycopg2.connect(env["DATABASE_URL"])
    cur = conn.cursor()
    cur.execute(
        "select name, email, frequency, created_at from waitlist order by created_at asc"
    )
    rows = cur.fetchall()
    conn.close()

    if not keep_tests:
        kept = []
        for row in rows:
            email = (row[1] or "").strip().lower()
            if email.split("@")[-1] in TEST_DOMAINS:
                continue
            kept.append(row)
        skipped = len(rows) - len(kept)
        rows = kept
    else:
        skipped = 0

    sender_path = os.path.join(HERE, "waitlist_sender.csv")
    with open(sender_path, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["email", "firstname", "lastname", "frequency", "signup_date"])
        for name, email, frequency, created in rows:
            first, last = split_name(name)
            writer.writerow([
                (email or "").strip().lower(),
                first,
                last,
                frequency or "",
                created.isoformat() if created else "",
            ])

    # Column names match Shopify's customer import template.
    shopify_path = os.path.join(HERE, "waitlist_shopify.csv")
    with open(shopify_path, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(
            ["First Name", "Last Name", "Email", "Accepts Email Marketing", "Tags", "Note"]
        )
        for name, email, frequency, created in rows:
            first, last = split_name(name)
            tags = "waitlist"
            if frequency:
                tags += ", plays-%s" % frequency
            writer.writerow([
                first,
                last,
                (email or "").strip().lower(),
                "yes",
                tags,
                "Waitlist signup %s" % (created.date() if created else "unknown"),
            ])

    print("exported %d rows (%d test rows skipped)" % (len(rows), skipped))
    print("  %s" % sender_path)
    print("  %s" % shopify_path)


if __name__ == "__main__":
    main()
