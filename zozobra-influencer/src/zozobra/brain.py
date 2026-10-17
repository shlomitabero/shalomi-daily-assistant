"""MODULE 3 - LILO's brain.

Turns a weekly focus into a validated 7-day content calendar: visual prompts,
Hebrew Reel/TikTok scripts with voice direction, captions, hooks and hashtags.

    python -m zozobra.brain --focus "הראמן החריף + אווירת ערב" --start 2026-10-18
"""
from __future__ import annotations

import argparse
import json
from datetime import date, timedelta
from pathlib import Path

import anthropic

from . import persona, venue
from .compliance import finalize_caption, validate_day
from .config import settings
from .schemas import DayPlan, WeekPlan

SYSTEM_PROMPT = f"""You are the creative brain of {persona.NAME} ({persona.FULL_NAME}, {persona.HANDLE}), a
clearly-labelled AI virtual food & lifestyle creator for the Israeli market. Her brand partner is
ZOZOBRA, an Asian street-food noodle bar with a dark-luxury, high-energy, open show-kitchen vibe:
woks on fire, steam, copper light, black surfaces.

## Who she is
{persona.BACKSTORY}

## How she talks (Hebrew copy and spoken scripts)
{persona.VOICE_RULES_HE}

## What wins on Israeli TikTok / Reels (apply it)
- The hook lands in the first 1.5 seconds: a sound (wok hiss, crunch), a bold claim, or a pattern break.
  No "היי חברים" openers.
- Reels are 12-25 seconds. One idea per video. Cut every 1-2 seconds.
- Sensory close-ups beat talking heads: noodle pulls, cheese/sauce drips, flame bursts, ice crack ASMR.
- Peak engagement windows (Asia/Jerusalem): weekdays 19:00-21:30, Thursday 20:00-22:00 is the big
  going-out night, Friday 12:00-14:00. Never schedule during national memorial sirens or similar
  sensitive dates - flag them if the week includes one.
- Mix pillars across the week (hero_dish, fire_show, night_vibe, challenge, pov_story, community);
  never the same pillar two days in a row.
- Hashtags: 3-8, mixing Hebrew discovery tags (e.g. אוכלבתלאביב, מסעדותבתלאביב, אוכלאסייתי) with
  a few English ones (foodtok, ramen, wok). No banned/spammy tags, no #fyp spam stacks.
- Captions: 1-3 short lines, one question to drive comments, one clear CTA (save / tag who you'd
  bring / come tonight).

## The real ZOZOBRA space (design renders = ground truth)
Every post set inside the restaurant must pick ONE plate id below as `visual.venue_plate`; the pipeline
paints LILO into that exact room and animates it for atmosphere cutaways, so `visual.scene` and
`visual.action` must match what the plate shows and where LILO can be in it. Use 'none' only for
food-only macros or outdoor shots. Rotate plates across the week; prefer `bar_tower_vertical` and
`mirror_corridor` (already vertical) for talking shots. For atmosphere cutaways write shots starting
with "venue establishing:" so they use the real plate. If stage is 'coming_soon', frame the space as a
teaser ("בקרוב") and never say it's open.
{venue.brain_brief()}

## Decor words
Never write "lantern(s)" or invent lamps: the red elements are draped crimson silk fabric ribbons, and
the glowing bar tower is a tiered canopy of backlit paper panels. These words are for visual prompts
only - spoken lines, on-screen text and captions never narrate the decor; they talk about the food,
the technique, the moment and the guests.

## Creative direction
Write like ZOZOBRA's creative director, not like a teen influencer: premium, confident, warm, precise.
Every reel ends with the brand sign-off spoken as "זוזוברה. אוכלים, שותים, נשארים." with on-screen
text "EAT. DRINK. STAY.". Wardrobe is elegant and modest - never revealing.

## Fire
Wok fire exists ONLY in the open kitchen plate. Never write flames, fire or sparks into scenes, actions
or motion prompts set at the bar, the paper-panel bar tower, tables, booths or corridors.

## Hard rules
- Mention ONLY dishes, drinks, branches and offers that appear in the provided menu JSON. Never
  invent prices, discounts or opening hours.
- The `visual.scene` / `visual.action` fields describe the place and what she does. Do NOT describe
  her face, hair or body - the pipeline injects her locked identity tokens automatically.
- Don't write disclosure lines; the compliance layer appends the AI label and the ad label itself.
- Alcohol content: adults only, no binge framing, no drinking-and-driving, never paired with
  challenges.
- No health claims, no attacking competitors, nothing sexual.

Return only the JSON object that matches the schema."""


def _client() -> anthropic.Anthropic:
    return anthropic.Anthropic()


def load_menu(path: Path | None = None) -> dict:
    if path is None:
        path = settings().data_dir / "menu.json"
        if not path.exists():  # fresh deployment volume: fall back to the bundled menu
            from .config import ROOT

            path = ROOT / "data" / "menu.json"
    return json.loads(path.read_text(encoding="utf-8"))


def build_user_prompt(focus: str, start: date, menu: dict, insights: str | None) -> str:
    days = [(start + timedelta(days=i)).isoformat() for i in range(7)]
    parts = [
        f"Weekly focus: {focus}",
        f"Plan exactly these 7 days, in order: {', '.join(days)}",
        "Menu JSON (the only dishes/drinks you may reference):",
        json.dumps(menu, ensure_ascii=False, indent=2),
    ]
    if insights:
        parts += ["Performance insights from previous weeks (lean into what worked):", insights]
    return "\n\n".join(parts)


def generate_week(
    focus: str,
    start: date,
    *,
    menu: dict | None = None,
    insights: str | None = None,
    client: anthropic.Anthropic | None = None,
) -> WeekPlan:
    """One structured-output call -> validated WeekPlan."""
    menu = menu or load_menu()
    client = client or _client()
    schema = anthropic.transform_schema(WeekPlan)

    with client.beta.messages.stream(
        model=settings().model,
        max_tokens=64000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        thinking={"type": "adaptive"},
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": schema}},
        system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": build_user_prompt(focus, start, menu, insights)}],
    ) as stream:
        message = stream.get_final_message()

    if message.stop_reason == "refusal":
        raise RuntimeError(f"Brain declined the brief: {message.stop_details}")
    if message.stop_reason == "max_tokens":
        raise RuntimeError("Calendar was cut off at max_tokens; shorten the brief or split the week.")

    text = next(b.text for b in message.content if b.type == "text")
    plan = WeekPlan.model_validate_json(text)

    valid_ids = {d["id"] for d in menu.get("dishes", [])} | {d["id"] for d in menu.get("drinks", [])}
    problems = [f"{d.day}: {p}" for d in plan.days for p in validate_day(d, valid_ids)]
    if len(plan.days) != 7:
        problems.append(f"expected 7 days, got {len(plan.days)}")
    if problems:
        raise ValueError("Calendar failed validation:\n" + "\n".join(problems))
    return plan


def full_image_prompt(day: DayPlan) -> str:
    """Identity-locked prompt for ComfyUI (Module 1)."""
    return persona.visual_prompt(day.visual.scene, day.visual.action, day.visual.wardrobe or None)


def spoken_script(day: DayPlan) -> str:
    """ElevenLabs v3 text with inline audio tags (Module 2)."""
    return " ".join(f"{line.voice_direction} {line.spoken_he}".strip() for line in day.script)


def render_markdown(plan: WeekPlan) -> str:
    out = [f"# LILO x ZOZOBRA - {plan.weekly_focus}", "", plan.strategy_summary_he, ""]
    for d in plan.days:
        out += [
            f"## {d.weekday_he} {d.day} · {d.post_time_local} · {d.format.value} · {d.pillar.value}",
            f"**Concept:** {d.concept}",
            f"**Hook:** {d.hook_he}  (A/B: {' | '.join(d.hook_alternatives_he)})",
            "",
            "**Image prompt (Flux + LoRA):**",
            f"```\n{full_image_prompt(d)}\n```",
            "**Motion prompt (image-to-video):**",
            f"```\n{d.visual.motion_prompt}\n```",
            "**Script:**",
            "| t | spoken | voice | on-screen | shot |",
            "|---|---|---|---|---|",
            *[
                f"| {l.t_start:.1f}-{l.t_end:.1f}s | {l.spoken_he} | {l.voice_direction} | {l.on_screen_text_he} | {l.shot} |"
                for l in d.script
            ],
            "",
            "**Caption:**",
            "```",
            finalize_caption(d),
            "```",
            f"Audio/trend: {d.trend_or_audio_note or '-'}",
            "",
        ]
    return "\n".join(out)


def save(plan: WeekPlan, out_dir: Path | None = None) -> Path:
    out_dir = out_dir or settings().data_dir / "calendars"
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = out_dir / f"week_{plan.days[0].day.isoformat()}"
    stem.with_suffix(".json").write_text(plan.model_dump_json(indent=2), encoding="utf-8")
    stem.with_suffix(".md").write_text(render_markdown(plan), encoding="utf-8")
    return stem.with_suffix(".json")


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate LILO's 7-day content calendar")
    ap.add_argument("--focus", required=True)
    ap.add_argument("--start", type=date.fromisoformat, default=date.today() + timedelta(days=1))
    ap.add_argument("--insights", help="Path to an insights text file (see analytics.weekly_insights)")
    args = ap.parse_args()

    insights = Path(args.insights).read_text(encoding="utf-8") if args.insights else None
    if insights is None:
        from .analytics import weekly_insights

        insights = weekly_insights() or None
    plan = generate_week(args.focus, args.start, insights=insights)
    print(f"Saved {save(plan)}")


if __name__ == "__main__":
    main()
