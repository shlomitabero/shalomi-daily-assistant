"""MODULE 4.1 - account health: warm-up cadence, posting windows, API budgets.

What actually gets AI-creator accounts restricted is not "detection" - it is unlabelled
synthetic media, bursty/bot-like behaviour, engagement automation (auto-follow, auto-like,
mass DMs) and unofficial APIs. So the guard below only ever publishes through official APIs,
at a human cadence, and never automates engagement on other people's content.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .config import settings

TZ = ZoneInfo("Asia/Jerusalem")

# Posts allowed per platform per day, by account age in weeks.
WARMUP = [
    (1, {"instagram": 1, "tiktok": 1}),   # week 1: profile complete, 3-4 posts total, no ads
    (2, {"instagram": 1, "tiktok": 1}),
    (4, {"instagram": 1, "tiktok": 2}),
    (10_000, {"instagram": 2, "tiktok": 3}),
]
MIN_GAP = timedelta(hours=3)
# Quiet hours: no publishing 01:00-08:00 local.
QUIET_START, QUIET_END = 1, 8


@dataclass
class Decision:
    allowed: bool
    reason: str = ""


class PublishGuard:
    def __init__(self, account_created: date, ledger: Path | None = None):
        self.account_created = account_created
        self.ledger = ledger or settings().data_dir / "publish_ledger.json"

    def _load(self) -> list[dict]:
        if self.ledger.exists():
            return json.loads(self.ledger.read_text(encoding="utf-8"))
        return []

    def daily_cap(self, platform: str, today: date) -> int:
        weeks = (today - self.account_created).days // 7 + 1
        for max_week, caps in WARMUP:
            if weeks <= max_week:
                return caps[platform]
        return WARMUP[-1][1][platform]

    def check(self, platform: str, when: datetime) -> Decision:
        when = when.astimezone(TZ)
        if QUIET_START <= when.hour < QUIET_END:
            return Decision(False, "quiet hours")
        entries = [e for e in self._load() if e["platform"] == platform]
        stamps = [datetime.fromisoformat(e["at"]).astimezone(TZ) for e in entries]
        same_day = [s for s in stamps if s.date() == when.date()]
        if len(same_day) >= self.daily_cap(platform, when.date()):
            return Decision(False, f"daily cap {self.daily_cap(platform, when.date())} reached")
        if stamps and when - max(stamps) < MIN_GAP:
            return Decision(False, "less than 3h since last post")
        return Decision(True)

    def record(self, platform: str, when: datetime, post_id: str) -> None:
        entries = self._load()
        entries.append({"platform": platform, "at": when.astimezone(TZ).isoformat(), "id": post_id})
        self.ledger.parent.mkdir(parents=True, exist_ok=True)
        self.ledger.write_text(json.dumps(entries, indent=2), encoding="utf-8")
