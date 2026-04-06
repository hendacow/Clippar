"""
storage.py — Cloudflare R2 file storage (S3-compatible)
"""

import os
from pathlib import Path

import boto3
from botocore.config import Config as BotoConfig

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=os.environ["R2_ENDPOINT"],
            aws_access_key_id=os.environ["R2_ACCESS_KEY"],
            aws_secret_access_key=os.environ["R2_SECRET_KEY"],
            config=BotoConfig(signature_version="s3v4"),
            region_name="auto",
        )
    return _client


def _bucket():
    return os.environ.get("R2_BUCKET", "clippar")


def upload_file(local_path, key):
    """Upload a local file to R2 at the given key."""
    _get_client().upload_file(str(local_path), _bucket(), key)
    return key


def download_file(key, local_path):
    """Download a file from R2 to the local path."""
    Path(local_path).parent.mkdir(parents=True, exist_ok=True)
    _get_client().download_file(_bucket(), key, str(local_path))
    return local_path


def list_files(prefix):
    """List all keys under a prefix."""
    resp = _get_client().list_objects_v2(Bucket=_bucket(), Prefix=prefix)
    return [obj["Key"] for obj in resp.get("Contents", [])]


def get_presigned_url(key, expires_in=3600):
    """Get a presigned download URL for a key."""
    return _get_client().generate_presigned_url(
        "get_object",
        Params={"Bucket": _bucket(), "Key": key},
        ExpiresIn=expires_in,
    )


def get_presigned_upload_url(key, expires_in=3600, content_type="video/mp4"):
    """Get a presigned upload URL for a key (used by mobile app)."""
    return _get_client().generate_presigned_url(
        "put_object",
        Params={"Bucket": _bucket(), "Key": key, "ContentType": content_type},
        ExpiresIn=expires_in,
    )


def delete_prefix(prefix):
    """Delete all objects under a prefix (for cleanup)."""
    keys = list_files(prefix)
    if not keys:
        return
    _get_client().delete_objects(
        Bucket=_bucket(),
        Delete={"Objects": [{"Key": k} for k in keys]},
    )
