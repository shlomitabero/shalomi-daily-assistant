"""MODULE 5.1 - performance loop: pull metrics, score posts, feed lessons back to the Brain."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import requests

from .config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS posts (
  post_id TEXT PRIMARY KEY, platform TEXT, day TEXT, post_time TEXT, pillar TEXT,
  dish_id TEXT, hook TEXT, format TEXT, published_at TEXT
);
CREATE TABLE IF NOT EXISTS metrics (
  post_id TEXT, fetched_at TEXT, views INTEGER, reach INTEGER, likes INTEGER,
  comments INTEGER, shares INTEGER, saves INTEGER
);
"""


def db(path: Path | None = None) -> sqlite3.Connection:
    path = path or settings().data_dir / "lilo.sqlite"
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def record_post(conn: sqlite3.Connection, *, post_id: str, platform: str, day: str, post_time: str,
                pillar: str, dish_id: str, hook: str, fmt: str) -> None:
    conn.execute("INSERT OR REPLACE INTO posts VALUES (?,?,?,?,?,?,?,?,?)",
                 (post_id, platform, day, post_time, pillar, dish_id, hook, fmt,
                  datetime.now(timezone.utc).isoformat()))
    conn.commit()


def score(views: int, likes: int, comments: int, shares: int, saves: int) -> float:
    """Weighted engagement per view. Shares and saves are what both algorithms reward most."""
    if not views:
        return 0.0
    return (likes + 2 * comments + 4 * shares + 3 * saves) / views


def fetch_instagram(media_id: str) -> dict:
    s = settings()
    r = requests.get(f"{s.graph_base}/{media_id}/insights",
                     params={"metric": "views,reach,likes,comments,shares,saved",
                             "access_token": s.ig_access_token}, timeout=60)
    r.raise_for_status()
    vals = {m["name"]: m["values"][0]["value"] for m in r.json()["data"]}
    return {"views": vals.get("views", 0), "reach": vals.get("reach", 0), "likes": vals.get("likes", 0),
            "comments": vals.get("comments", 0), "shares": vals.get("shares", 0), "saves": vals.get("saved", 0)}


def fetch_tiktok(video_ids: list[str]) -> dict[str, dict]:
    r = requests.post("https://open.tiktokapis.com/v2/video/query/",
                      params={"fields": "id,view_count,like_count,comment_count,share_count"},
                      headers={"Authorization": f"Bearer {settings().tiktok_access_token}"},
                      json={"filters": {"video_ids": video_ids[:20]}}, timeout=60)
    r.raise_for_status()
    return {v["id"]: {"views": v["view_count"], "reach": v["view_count"], "likes": v["like_count"],
                      "comments": v["comment_count"], "shares": v["share_count"], "saves": 0}
            for v in r.json()["data"]["videos"]}


def refresh(conn: sqlite3.Connection) -> int:
    now = datetime.now(timezone.utc).isoformat()
    rows = conn.execute("SELECT post_id, platform FROM posts").fetchall()
    fetched: dict[str, dict] = {}
    for r in rows:
        if r["platform"] == "instagram":
            fetched[r["post_id"]] = fetch_instagram(r["post_id"])
    tt = [r["post_id"] for r in rows if r["platform"] == "tiktok"]
    for i in range(0, len(tt), 20):
        fetched.update(fetch_tiktok(tt[i:i + 20]))
    for pid, m in fetched.items():
        conn.execute("INSERT INTO metrics VALUES (?,?,?,?,?,?,?,?)",
                     (pid, now, m["views"], m["reach"], m["likes"], m["comments"], m["shares"], m["saves"]))
    conn.commit()
    return len(fetched)


LATEST = """
SELECT p.*, m.views, m.likes, m.comments, m.shares, m.saves FROM posts p
JOIN metrics m ON m.post_id = p.post_id
WHERE m.fetched_at = (SELECT MAX(fetched_at) FROM metrics WHERE post_id = p.post_id)
"""


def weekly_insights(conn: sqlite3.Connection | None = None, top_n: int = 3) -> str:
    """Plain-text brief for the Brain: best/worst posts, pillar averages, best hours."""
    conn = conn or db()
    rows = [dict(r) | {"score": score(r["views"], r["likes"], r["comments"], r["shares"], r["saves"])}
            for r in conn.execute(LATEST).fetchall()]
    if not rows:
        return ""
    rows.sort(key=lambda r: r["score"], reverse=True)

    def line(r: dict) -> str:
        return (f"- [{r['platform']}] {r['day']} {r['post_time']} {r['pillar']}/{r['dish_id']} "
                f"hook=\"{r['hook']}\" views={r['views']} score={r['score']:.3f}")

    by_pillar: dict[str, list[float]] = {}
    by_hour: dict[str, list[float]] = {}
    for r in rows:
        by_pillar.setdefault(r["pillar"], []).append(r["score"])
        by_hour.setdefault(r["post_time"][:2] + ":00", []).append(r["score"])
    avg = lambda d: sorted(((k, sum(v) / len(v)) for k, v in d.items()), key=lambda kv: -kv[1])

    out = ["TOP POSTS:", *map(line, rows[:top_n]), "WEAKEST POSTS:", *map(line, rows[-top_n:]),
           "PILLAR AVG SCORE: " + ", ".join(f"{k}={v:.3f}" for k, v in avg(by_pillar)),
           "BEST HOURS: " + ", ".join(f"{k}={v:.3f}" for k, v in avg(by_hour)[:3])]
    return "\n".join(out)
