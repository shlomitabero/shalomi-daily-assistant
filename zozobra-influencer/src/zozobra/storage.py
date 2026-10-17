"""Public URLs for media. IG and TikTok both *pull* the file, so it must be reachable over HTTPS
(TikTok PULL_FROM_URL additionally requires the domain to be verified in the developer portal)."""
from __future__ import annotations

import mimetypes
from pathlib import Path

from .config import settings


def publish_file(path: Path, key: str | None = None) -> str:
    import boto3

    s = settings()
    key = key or f"lilo/{path.name}"
    s3 = boto3.client("s3", endpoint_url=s.s3_endpoint_url or None)
    s3.upload_file(str(path), s.media_bucket, key, ExtraArgs={
        "ContentType": mimetypes.guess_type(path.name)[0] or "application/octet-stream"})
    return f"{s.media_public_base_url.rstrip('/')}/{key}"
