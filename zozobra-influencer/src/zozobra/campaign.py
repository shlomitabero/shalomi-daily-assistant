"""Growth campaign: LILO builds a following as Haifa's AI nightlife guide before ZOZOBRA opens.

    grow    -> city nightlife content only, ZOZOBRA is never named (no ad label needed)
    teaser  -> last weeks before opening: mysterious hints ("something is opening in the Bay")
    launch  -> ZOZOBRA content, every post carries the paid-partnership label

The phase is computed from data/campaign.json (launch_date), so the Brain changes gear by itself.
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

from .config import ROOT, settings


def config() -> dict:
    path = settings().data_dir / "campaign.json"
    if not path.exists():
        path = ROOT / "data" / "campaign.json"
    return json.loads(path.read_text(encoding="utf-8"))


def phase(day: date | None = None) -> str:
    c = config()
    day = day or date.today()
    launch = date.fromisoformat(c["launch_date"])
    if day >= launch:
        return "launch"
    if day >= launch - timedelta(days=c.get("teaser_days", 21)):
        return "teaser"
    return "grow"


def brief(start: date) -> str:
    """Phase instructions for the Brain's user prompt (volatile, so kept out of the cached system)."""
    c = config()
    p = phase(start)
    spots = "\n".join(f"- {s}" for s in c["public_spots"])
    common = (
        f"Campaign city: {c['city_he']}. ZOZOBRA opens on {c['launch_date']} at {c['launch_location_he']}.\n"
        "Public locations LILO can be shown in (visual.scene, visual.venue_plate='none'):\n" + spots
    )
    if p == "grow":
        return (
            "PHASE: GROW (build followers). LILO is Haifa & the Krayot's AI nightlife guide.\n"
            "- Do NOT mention ZOZOBRA, its dishes or its interior. Set every day's features_zozobra=false, "
            "dish_id='atmosphere', visual.venue_plate='none'.\n"
            "- Content: guides to real neighbourhoods and real places found in the research brief (cite each in "
            "`places` with its source URL), weekend 'where to go' lists, polls, reply-to-comments, POV humour about "
            "being an AI who can't taste ('you are my mouth').\n"
            "- She never claims she ate, drank or visited somewhere - she 'hears', 'picks', 'asks you'. "
            "Only positive picks; never criticise a business.\n"
            "- Visuals show LILO in the public locations above - never inside another business.\n"
            "- Sign-off: spoken 'אוכלים. שותים. נשארים.' with on-screen 'EAT. DRINK. STAY.' (her tagline; later "
            "revealed as ZOZOBRA's).\n" + common
        )
    if p == "teaser":
        return (
            "PHASE: TEASER (opening in under three weeks). Keep 1-2 city posts per week; the rest tease the "
            "opening without naming it: 'something is opening in the Bay', countdowns, glimpses of the fire and the "
            "dark-luxury space (ZOZOBRA plates allowed, stage is coming_soon). Teaser posts set features_zozobra=true "
            "and may name ZOZOBRA only in the final week. Never say it is open.\n" + common
        )
    return (
        "PHASE: LAUNCH. ZOZOBRA is open. Hero dishes, fire show, opening-week giveaways and date nights; "
        "features_zozobra=true on every ZOZOBRA post. Keep one city post per week so the guide identity stays.\n"
        + common
    )
