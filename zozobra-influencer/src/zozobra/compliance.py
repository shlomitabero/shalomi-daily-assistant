"""Disclosure + platform-limit checks applied to every post before it can publish.

Israeli Consumer Protection law and Meta/TikTok branded-content policies require paid
promotion to be marked as advertising, and both platforms require realistic AI-generated
media to be labelled. The Brain never writes these lines; this module always does.
"""
from __future__ import annotations

import re

from . import persona
from .schemas import DayPlan, Format

IG_CAPTION_MAX = 2200
IG_HASHTAG_MAX = 30
TIKTOK_CAPTION_MAX = 2200
MAX_HASHTAGS = 8
REEL_MIN_S, REEL_MAX_S = 7.0, 60.0

_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def finalize_caption(day: DayPlan) -> str:
    tags = " ".join("#" + t.lstrip("#").replace(" ", "") for t in day.hashtags)
    disclosures = ([persona.AD_DISCLOSURE_HE] if day.features_zozobra else []) + [persona.AI_DISCLOSURE_HE]
    if day.visual.venue_plate != "none":   # ZOZOBRA scenes are built on design renders, not photos
        disclosures.append(persona.RENDER_DISCLOSURE_HE)
    return "\n".join([day.caption_he.strip(), day.cta_he.strip(), "", *disclosures, "", tags]).strip()


def validate_day(day: DayPlan, valid_dish_ids: set[str]) -> list[str]:
    problems: list[str] = []
    if day.dish_id != "atmosphere" and day.dish_id not in valid_dish_ids:
        problems.append(f"unknown dish_id '{day.dish_id}' (not in menu)")
    from .venue import plate_ids

    if day.visual.venue_plate != "none" and day.visual.venue_plate not in plate_ids():
        problems.append(f"unknown venue_plate '{day.visual.venue_plate}'")
    if not day.features_zozobra and (day.dish_id != "atmosphere" or day.visual.venue_plate != "none"):
        problems.append("city post must use dish_id 'atmosphere' and venue_plate 'none'")
    from .campaign import allows_zozobra

    if day.features_zozobra and not allows_zozobra(day.day):
        problems.append("ZOZOBRA may not appear before the reveal phase (day 31)")
    if not _HHMM.match(day.post_time_local):
        problems.append(f"bad post_time_local '{day.post_time_local}'")
    if not set(day.platforms) <= {"instagram", "tiktok"} or not day.platforms:
        problems.append(f"bad platforms {day.platforms}")
    if day.format is not Format.reel and "tiktok" in day.platforms:
        problems.append("TikTok only receives video (format must be reel)")
    if not 1 <= len(day.hashtags) <= MAX_HASHTAGS:
        problems.append(f"{len(day.hashtags)} hashtags (want 1-{MAX_HASHTAGS})")
    if len(finalize_caption(day)) > IG_CAPTION_MAX:
        problems.append("caption over 2200 chars after disclosures")
    if day.format is Format.reel:
        if not day.script:
            problems.append("reel has no script")
        else:
            dur = day.script[-1].t_end
            if not REEL_MIN_S <= dur <= REEL_MAX_S:
                problems.append(f"reel duration {dur:.1f}s outside {REEL_MIN_S}-{REEL_MAX_S}s")
            if any(b.t_start > a.t_end + 0.01 for a, b in zip(day.script, day.script[1:])):
                problems.append("script has gaps between lines")
    return problems
