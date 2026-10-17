"""Orchestrator: calendar -> media -> human approval -> publish -> analytics.

    python -m zozobra.pipeline plan    --focus "..." [--start YYYY-MM-DD]
    python -m zozobra.pipeline produce data/calendars/week_2026-10-18.json [--day 2026-10-18]
    python -m zozobra.pipeline approve 2026-10-18
    python -m zozobra.pipeline publish-due           # run every 15 min from cron
    python -m zozobra.pipeline metrics               # nightly: refresh insights
    python -m zozobra.pipeline replies <ig_media_id> # draft comment replies into the queue

DRY_RUN=true (the default) prints every prompt and API step without spending credits.
"""
from __future__ import annotations

import argparse
import json
from datetime import date, datetime, timedelta
from pathlib import Path

from . import persona
from .account_health import TZ, PublishGuard
from .brain import full_image_prompt, generate_week, load_menu, save, spoken_script
from .compliance import finalize_caption
from .config import settings
from .schemas import DayPlan, Format, WeekPlan

ACCOUNT_CREATED = date(2026, 10, 1)   # set to the real account creation date (drives warm-up caps)
ANCHOR_FACE = settings().data_dir / "refs" / "R0_anchor.png"   # curated anchor portrait from docs/02


def _queue_dir() -> Path:
    return settings().data_dir / "queue"


def broll_prompt(day: DayPlan, shot: str, menu: dict) -> str:
    dish = next((d for d in menu.get("dishes", []) + menu.get("drinks", []) if d["id"] == day.dish_id), None)
    hero = dish["hero_visual"] if dish else ""
    return ", ".join(x for x in [shot, hero, persona.WORLD_TOKENS, persona.CAMERA_TOKENS,
                                 "no people, no faces, food photography"] if x)


def produce_day(day: DayPlan, menu: dict, workdir: Path, dry_run: bool) -> dict:
    """Render all media for one calendar day and drop a pending item in the approval queue."""
    from .video import is_broll

    workdir.mkdir(parents=True, exist_ok=True)
    caption = finalize_caption(day)
    hero_prompt = full_image_prompt(day)
    broll_lines = [l for l in day.script if is_broll(l.shot)]
    steps = {"hero_prompt": hero_prompt,
             "broll": [{"t": [l.t_start, l.t_end], "prompt": broll_prompt(day, l.shot, menu)} for l in broll_lines],
             "motion_prompt": day.visual.motion_prompt,
             "voice_text": spoken_script(day) if day.format is Format.reel else "",
             "caption": caption}
    item = {"day": day.day.isoformat(), "post_time": day.post_time_local, "platforms": day.platforms,
            "format": day.format.value, "pillar": day.pillar.value, "dish_id": day.dish_id,
            "hook": day.hook_he, "caption": caption, "status": "pending", "media_url": None,
            "image_urls": [], "steps": steps}

    if not dry_run:
        from . import image_gen, qa, storage, video, voice

        seed = int(day.day.strftime("%Y%m%d"))
        stills = [p for i in range(4) for p in image_gen.generate(hero_prompt, seed + i, workdir / "hero")]
        hero, _ = qa.best_match(stills, ANCHOR_FACE)
        stills = [hero] + [p for p in stills if p != hero]
        still_urls = [storage.publish_file(p, f"lilo/{day.day}/{p.name}") for p in stills]
        if day.format is Format.reel:
            a_roll_raw = video.animate_still(still_urls[0], day.visual.motion_prompt, duration=10)
            audio = voice.synthesize(spoken_script(day), workdir / "voice.mp3")
            audio_url = storage.publish_file(audio, f"lilo/{day.day}/voice.mp3")
            a_roll = video.download(video.lipsync(a_roll_raw, audio_url), workdir / "a_roll.mp4")
            cutaways = []
            for i, (line, spec) in enumerate(zip(broll_lines, steps["broll"])):
                img = image_gen.generate(spec["prompt"], seed + 100 + i, workdir / "broll")[0]
                url = storage.publish_file(img, f"lilo/{day.day}/{img.name}")
                clip = video.download(video.animate_still(url, line.shot), workdir / f"broll_{i}.mp4")
                cutaways.append((clip, line.t_start, line.t_end))
            final = video.compose(a_roll, cutaways, workdir / "final.mp4")
            item["media_url"] = storage.publish_file(final, f"lilo/{day.day}/final.mp4")
        else:
            item["image_urls"] = still_urls

    _queue_dir().mkdir(parents=True, exist_ok=True)
    (_queue_dir() / f"{day.day}.json").write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8")
    return item


def approve(day: str) -> None:
    path = _queue_dir() / f"{day}.json"
    item = json.loads(path.read_text(encoding="utf-8"))
    item["status"] = "approved"
    path.write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8")


def publish_due(now: datetime | None = None, dry_run: bool | None = None) -> list[str]:
    from .analytics import db, record_post

    s = settings()
    dry_run = s.dry_run if dry_run is None else dry_run
    now = (now or datetime.now(TZ)).astimezone(TZ)
    guard = PublishGuard(ACCOUNT_CREATED)
    log: list[str] = []
    for path in sorted(_queue_dir().glob("*.json")):
        item = json.loads(path.read_text(encoding="utf-8"))
        due = datetime.fromisoformat(f"{item['day']}T{item['post_time']}").replace(tzinfo=TZ)
        if item["status"] == "published" or due > now or now - due > timedelta(hours=6):
            continue
        if s.require_human_approval and item["status"] != "approved":
            log.append(f"{item['day']}: waiting for approval")
            continue
        for platform in item["platforms"]:
            if platform in item.get("published", {}):
                continue
            decision = guard.check(platform, now)
            if not decision.allowed:
                log.append(f"{item['day']} {platform}: held ({decision.reason})")
                continue
            if dry_run:
                log.append(f"{item['day']} {platform}: DRY RUN would publish")
                continue
            post_id = _publish(platform, item)
            guard.record(platform, now, post_id)
            record_post(db(), post_id=post_id, platform=platform, day=item["day"], post_time=item["post_time"],
                        pillar=item["pillar"], dish_id=item["dish_id"], hook=item["hook"], fmt=item["format"])
            item.setdefault("published", {})[platform] = post_id
            log.append(f"{item['day']} {platform}: published {post_id}")
        if set(item.get("published", {})) >= set(item["platforms"]):
            item["status"] = "published"
        path.write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8")
    return log


def _publish(platform: str, item: dict) -> str:
    if platform == "instagram":
        from .publish_instagram import InstagramPublisher

        ig = InstagramPublisher()
        if ig.quota_left() < 1:
            raise RuntimeError("Instagram publishing quota exhausted")
        if item["format"] == "carousel":
            return ig.publish_carousel(item["image_urls"], item["caption"])
        return ig.publish_reel(item["media_url"], item["caption"])
    from .publish_tiktok import TikTokPublisher

    return TikTokPublisher().publish_video(item["media_url"], item["caption"])


def main() -> None:
    ap = argparse.ArgumentParser(prog="zozobra")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan"); p.add_argument("--focus", required=True)
    p.add_argument("--start", type=date.fromisoformat, default=date.today() + timedelta(days=1))
    pr = sub.add_parser("produce"); pr.add_argument("calendar", type=Path); pr.add_argument("--day")
    a = sub.add_parser("approve"); a.add_argument("day")
    sub.add_parser("publish-due")
    sub.add_parser("metrics")
    r = sub.add_parser("replies"); r.add_argument("media_id"); r.add_argument("--context", default="")
    args = ap.parse_args()
    s = settings()

    if args.cmd == "plan":
        from .analytics import weekly_insights

        print(save(generate_week(args.focus, args.start, insights=weekly_insights() or None)))
    elif args.cmd == "produce":
        plan = WeekPlan.model_validate_json(args.calendar.read_text(encoding="utf-8"))
        menu = load_menu()
        for d in plan.days:
            if args.day and d.day.isoformat() != args.day:
                continue
            item = produce_day(d, menu, s.data_dir / "renders" / d.day.isoformat(), s.dry_run)
            print(json.dumps(item["steps"], ensure_ascii=False, indent=2) if s.dry_run else f"{d.day}: queued")
    elif args.cmd == "approve":
        approve(args.day)
    elif args.cmd == "publish-due":
        print("\n".join(publish_due()) or "nothing due")
    elif args.cmd == "metrics":
        from .analytics import db, refresh, weekly_insights

        conn = db()
        print(f"refreshed {refresh(conn)} posts\n{weekly_insights(conn)}")
    elif args.cmd == "replies":
        from .engagement import draft_replies, ig_comments, queue

        print(queue(draft_replies(ig_comments(args.media_id), args.context), args.media_id))


if __name__ == "__main__":
    main()
