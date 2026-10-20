"""60-day growth campaign: LILO MOSCOWITZ builds a real local following, then launches ZOZOBRA.

    brand       days 1-14   city nightlife guide, ZOZOBRA never named
    accelerate  days 15-30  double down on what performed, collabs, polls
    reveal      days 31-45  bigger city formats, partner venues, community series
    launch      day 46 ->   peak growth: collabs, giveaways with partner venues
    open        from launch_date - only now ZOZOBRA appears (paid-partnership label)

Owner's rule: no ZOZOBRA content at all before the opening date - LILO first builds her own audience.

Phases and the weekday series come from data/campaign.json, so the Brain changes gear by itself.
"""
from __future__ import annotations

import json
from datetime import date, timedelta

from .config import ROOT, settings

PHASES = ("brand", "accelerate", "reveal", "launch", "open")


DEFAULT = {"start_date": "2026-10-18", "launch_date": "2026-12-17", "city_he": "חיפה והקריות",
           "launch_location_he": "ZOZOBRA חוצות המפרץ, חיפה", "weekly_series": {}, "public_spots": []}


def config() -> dict:
    """Volume copy first (editable), then the bundled file; never crash the panel over a missing file."""
    for path in (settings().data_dir / "campaign.json", ROOT / "data" / "campaign.json"):
        if path.exists():
            return DEFAULT | json.loads(path.read_text(encoding="utf-8"))
    return DEFAULT


def day_number(day: date) -> int:
    return (day - date.fromisoformat(config()["start_date"])).days + 1


def phase(day: date | None = None) -> str:
    day = day or date.today()
    if day >= date.fromisoformat(config()["launch_date"]):
        return "open"
    n = day_number(day)
    return "brand" if n <= 14 else "accelerate" if n <= 30 else "reveal" if n <= 45 else "launch"


def series(day: date) -> str:
    return config()["weekly_series"].get(str(day.weekday()), "")


def allows_zozobra(day: date) -> bool:
    return phase(day) == "open"


_PHASE_RULES = {
    "brand": (
        "PHASE brand (days 1-14): build LILO's own brand. ZOZOBRA is never named or shown: every day "
        "features_zozobra=false, dish_id='atmosphere', visual.venue_plate='none'. One vertical video per day."),
    "accelerate": (
        "PHASE accelerate (days 15-30): lean into the formats that performed best (see insights); more polls, "
        "reply-to-comment videos and collab-ready posts about real places. ZOZOBRA still not named."),
    "reveal": (
        "PHASE reveal (days 31-45): still ZERO ZOZOBRA - every day features_zozobra=false, dish_id='atmosphere', "
        "visual.venue_plate='none'. Bigger city formats: neighbourhood tours, 'best of the month', collab-ready "
        "posts about real places, reply-to-comment videos."),
    "launch": (
        "PHASE launch (days 46-60): still ZERO ZOZOBRA until the opening date - every day features_zozobra=false, "
        "dish_id='atmosphere', visual.venue_plate='none'. Peak growth: collabs with partner venues, holiday and "
        "weekend guides, community picks."),
    "open": (
        "PHASE open: ZOZOBRA is open. Hero dishes, fire show, bar nights; keep one city post a week so LILO stays "
        "a guide, not an ad."),
}


def brief(start: date) -> str:
    """Phase + series instructions for the Brain's user prompt (volatile, kept out of the cached system)."""
    c = config()
    days = [start + timedelta(days=i) for i in range(7)]
    plan = "\n".join(f"- {d.isoformat()} (day {day_number(d)}, {phase(d)}): series {series(d)}" for d in days)
    spots = "\n".join(f"- {s}" for s in c["public_spots"])
    rules = "\n".join(dict.fromkeys(_PHASE_RULES[phase(d)] for d in days))
    return (
        f"Campaign: LILO MOSCOWITZ, AI guide to food, drinks and nightlife in {c['city_he']}. "
        f"ZOZOBRA ({c['launch_location_he']}) opens around {c['launch_date']} (not final - never state the date "
        "as certain).\n" + rules + "\n"
        "Every day: one 9:16 reel of 15-35 seconds in that day's series, a 2-second hook, a clear save/share/"
        "comment CTA.\nNever say in speech or on-screen text that LILO is AI, virtual or a character - the AI "
        "label lives in the bio, the caption line and the platform's AI toggle.\nCity posts: name only real places from the research brief (list them in `places` with "
        "the source URL); positive picks only; LILO never claims she visited, ate or met anyone - she 'found', "
        "'picked', 'hears', 'asks you'. Visuals show her only in public locations, never inside another business:\n"
        + spots + "\nSign-off on every reel: spoken 'אוכלים. שותים. נשארים.' with on-screen 'EAT. DRINK. STAY.'\n"
        "Days this week:\n" + plan
    )
