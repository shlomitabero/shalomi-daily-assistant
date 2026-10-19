"""MODULE 4.2 - Instagram Graph API content publishing (Business/Creator account only).

Flow: create media container -> wait until FINISHED -> media_publish.
Docs: developers.facebook.com/docs/instagram-platform/content-publishing
"""
from __future__ import annotations

import time

import requests

from .config import settings


class InstagramPublisher:
    def __init__(self) -> None:
        s = settings()
        self.base = s.graph_base
        self.user = s.ig_user_id or "me"
        self.token = s.ig_access_token

    def _post(self, path: str, **params) -> dict:
        r = requests.post(f"{self.base}/{path}", data={**params, "access_token": self.token}, timeout=60)
        r.raise_for_status()
        return r.json()

    def _get(self, path: str, **params) -> dict:
        r = requests.get(f"{self.base}/{path}", params={**params, "access_token": self.token}, timeout=60)
        r.raise_for_status()
        return r.json()

    def quota_left(self) -> int:
        """API-published posts are capped (100 / rolling 24h). Check before publishing."""
        data = self._get(f"{self.user}/content_publishing_limit", fields="quota_usage,config")["data"][0]
        return data["config"]["quota_total"] - data["quota_usage"]

    def _wait(self, container_id: str, timeout_s: int = 600) -> None:
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            status = self._get(container_id, fields="status_code,status")
            if status["status_code"] == "FINISHED":
                return
            if status["status_code"] in {"ERROR", "EXPIRED"}:
                raise RuntimeError(f"IG container {container_id}: {status}")
            time.sleep(10)
        raise TimeoutError(container_id)

    def publish_reel(self, video_url: str, caption: str, cover_url: str | None = None) -> str:
        params = {"media_type": "REELS", "video_url": video_url, "caption": caption, "share_to_feed": "true"}
        if cover_url:
            params["cover_url"] = cover_url
        container = self._post(f"{self.user}/media", **params)["id"]
        self._wait(container)
        return self._post(f"{self.user}/media_publish", creation_id=container)["id"]

    def publish_carousel(self, image_urls: list[str], caption: str) -> str:
        if not 2 <= len(image_urls) <= 10:
            raise ValueError("carousel needs 2-10 images")
        children = [self._post(f"{self.user}/media", image_url=u, is_carousel_item="true")["id"]
                    for u in image_urls]
        for c in children:
            self._wait(c)
        container = self._post(f"{self.user}/media", media_type="CAROUSEL",
                               children=",".join(children), caption=caption)["id"]
        self._wait(container)
        return self._post(f"{self.user}/media_publish", creation_id=container)["id"]


def connect(token: str) -> dict:
    """Verify a pasted Instagram-Login token, store it with the account id (panel /setup)."""
    from .config import save_runtime

    token = token.strip()
    s = settings()
    host = "graph.instagram.com" if token.startswith("IG") else "graph.facebook.com"
    r = requests.get(f"https://{host}/{s.graph_version}/me",
                     params={"fields": "user_id,username", "access_token": token}, timeout=30)
    if r.status_code != 200:
        raise ValueError(f"Instagram rejected the token: {r.text[:300]}")
    me = r.json()
    save_runtime(ig_access_token=token, ig_user_id=str(me.get("user_id") or me.get("id")),
                 ig_username=me.get("username", ""), ig_token_refreshed=time.strftime("%Y-%m-%d"))
    return me


def refresh_token() -> str:
    """Long-lived Instagram-Login tokens last 60 days; refresh weekly so publishing never stops."""
    from datetime import date, timedelta

    from .config import runtime, save_runtime

    rt = runtime()
    token = rt.get("ig_access_token", "")
    last = rt.get("ig_token_refreshed", "2000-01-01")
    if not token.startswith("IG") or date.fromisoformat(last) > date.today() - timedelta(days=7):
        return "no refresh needed"
    r = requests.get("https://graph.instagram.com/refresh_access_token",
                     params={"grant_type": "ig_refresh_token", "access_token": token}, timeout=30)
    r.raise_for_status()
    save_runtime(ig_access_token=r.json()["access_token"], ig_token_refreshed=date.today().isoformat())
    return "token refreshed"
