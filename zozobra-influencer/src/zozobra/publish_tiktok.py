"""MODULE 4.3 - TikTok Content Posting API (Direct Post).

Requires an app with the `video.publish` scope. Until TikTok audits the app, every post is
forced to SELF_ONLY visibility - fine for a staging run, not for launch.
Docs: developers.tiktok.com/doc/content-posting-api-reference-direct-post
"""
from __future__ import annotations

import time

import requests

from .config import settings

API = "https://open.tiktokapis.com/v2/post/publish"


class TikTokPublisher:
    def __init__(self) -> None:
        self.h = {"Authorization": f"Bearer {settings().tiktok_access_token}",
                  "Content-Type": "application/json; charset=UTF-8"}

    def _post(self, path: str, body: dict) -> dict:
        r = requests.post(f"{API}/{path}", headers=self.h, json=body, timeout=60)
        r.raise_for_status()
        payload = r.json()
        if payload.get("error", {}).get("code") not in (None, "ok"):
            raise RuntimeError(payload["error"])
        return payload["data"]

    def creator_info(self) -> dict:
        """Mandatory before each post: allowed privacy levels, max duration, interaction toggles."""
        return self._post("creator_info/query/", {})

    def publish_video(self, video_url: str, caption: str, *, privacy: str = "PUBLIC_TO_EVERYONE") -> str:
        info = self.creator_info()
        if privacy not in info["privacy_level_options"]:
            privacy = info["privacy_level_options"][0]   # unaudited apps -> SELF_ONLY
        data = self._post("video/init/", {
            "post_info": {
                "title": caption[:2200],
                "privacy_level": privacy,
                "disable_comment": False,
                "disable_duet": False,
                "disable_stitch": False,
                "video_cover_timestamp_ms": 1000,
                "brand_content_toggle": True,     # paid partnership -> "Paid partnership" label
                "brand_organic_toggle": False,
                "is_aigc": True,                  # "AI-generated" label on the post
            },
            "source_info": {"source": "PULL_FROM_URL", "video_url": video_url},
        })
        publish_id = data["publish_id"]
        deadline = time.time() + 900
        while time.time() < deadline:
            status = self._post("status/fetch/", {"publish_id": publish_id})
            if status["status"] == "PUBLISH_COMPLETE":
                ids = status.get("publicaly_available_post_id") or status.get("publicly_available_post_id") or []
                return str(ids[0]) if ids else publish_id
            if status["status"] == "FAILED":
                raise RuntimeError(status)
            time.sleep(10)
        raise TimeoutError(publish_id)
