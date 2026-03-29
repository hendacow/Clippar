"""
email_utils.py — Gmail SMTP sender for customer delivery
"""

import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

GMAIL_USER = os.getenv("GMAIL_USER")
GMAIL_APP_PASSWORD = os.getenv("GMAIL_APP_PASSWORD")

EMAIL_TEMPLATE = Path(__file__).parent / "templates" / "email_result.html"


def send_result_email(customer_name, customer_email, drive_link):
    """Send the highlight reel link to the customer."""
    if not GMAIL_USER or not GMAIL_APP_PASSWORD:
        raise RuntimeError("GMAIL_USER and GMAIL_APP_PASSWORD must be set in .env")

    html = EMAIL_TEMPLATE.read_text()
    html = html.replace("{{name}}", customer_name)
    html = html.replace("{{drive_link}}", drive_link)

    msg = MIMEMultipart("alternative")
    msg["Subject"] = "Your Clippar highlight reel is ready"
    msg["From"] = f"Clippar <{GMAIL_USER}>"
    msg["To"] = customer_email
    msg.attach(MIMEText(html, "html"))

    with smtplib.SMTP("smtp.gmail.com", 587) as server:
        server.starttls()
        server.login(GMAIL_USER, GMAIL_APP_PASSWORD)
        server.send_message(msg)

    print(f"[Email] Sent to {customer_email}")
