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

from . import persona, venue
from .account_health import TZ, PublishGuard
from .brain import full_image_prompt, generate_week, load_menu, save, spoken_script
from .compliance import finalize_caption
from .config import can_render, runtime, settings
from .fal_provider import TALK_ENGINES
from .schemas import DayPlan, Format, WeekPlan



def _queue_dir() -> Path:
    return settings().data_dir / "queue"


def broll_prompt(day: DayPlan, shot: str, menu: dict) -> str:
    dish = next((d for d in menu.get("dishes", []) + menu.get("drinks", []) if d["id"] == day.dish_id), None)
    hero = dish["hero_visual"] if dish else ""
    world = persona.WORLD_TOKENS if day.features_zozobra else ""
    return ", ".join(x for x in [shot, hero, world, persona.CAMERA_TOKENS,
                                 "no people, no faces, food photography"] if x)


_INVENTS_DECOR = (("lanterns", "paper-panel canopy"), ("lantern", "paper-panel canopy"))


def _clean(text: str) -> str:
    """Words that make image/video models invent decor ZOZOBRA doesn't have."""
    for a, b in _INVENTS_DECOR:
        text = text.replace(a, b).replace(a.capitalize(), b)
    return text


def produce_day(day: DayPlan, menu: dict, workdir: Path, dry_run: bool) -> dict:
    """Render all media for one calendar day and drop a pending item in the approval queue."""
    from .video import is_broll

    workdir.mkdir(parents=True, exist_ok=True)
    caption = finalize_caption(day)
    hero_prompt = _clean(full_image_prompt(day))
    day = day.model_copy(update={"visual": day.visual.model_copy(update={"motion_prompt": _clean(day.visual.motion_prompt)})})
    broll_lines = [l for l in day.script if is_broll(l.shot)]
    plate_id = day.visual.venue_plate if day.visual.venue_plate in venue.plate_ids() else None
    night = int(day.post_time_local[:2]) >= 19
    steps = {"hero_prompt": hero_prompt,
             "venue_plate": plate_id, "venue_night_variant": night,
             "broll": [{"t": [l.t_start, l.t_end],
                        "source": "venue_plate" if plate_id and not venue.is_food_shot(l.shot) else "generated",
                        "prompt": l.shot if plate_id and not venue.is_food_shot(l.shot) else broll_prompt(day, l.shot, menu)}
                       for l in broll_lines],
             "motion_prompt": day.visual.motion_prompt,
             "voice_text": spoken_script(day) if day.format is Format.reel else "",
             "caption": caption}
    item = {"day": day.day.isoformat(), "post_time": day.post_time_local, "platforms": day.platforms,
            "format": day.format.value, "pillar": day.pillar.value, "dish_id": day.dish_id,
            "hook": day.hook_he, "caption": caption, "status": "pending", "media_url": None,
            "image_urls": [], "steps": steps}

    if not dry_run:
        from . import providers as P
        from . import qa, subtitles, video, voice

        seed = int(day.day.strftime("%Y%m%d"))
        if plate_id:
            plate_img = venue.plate_9x16(plate_id, night=night)
            stills = [p for i in range(4) for p in P.image_in_venue(hero_prompt, plate_img, seed + i, workdir / "hero")]
        else:
            stills = [p for i in range(4) for p in P.image(hero_prompt, seed + i, workdir / "hero")]
        anchor = settings().data_dir / "refs" / "R0_anchor.png"
        if anchor.exists():
            hero, _ = qa.best_match(stills, anchor)
            stills = [hero] + [p for p in stills if p != hero]
        item["image_paths"] = [str(p) for p in stills]
        still_urls = [P.upload(p, f"lilo/{day.day}/{p.name}") for p in stills]
        engine = runtime().get("video_engine")
        if day.format is Format.reel and engine in TALK_ENGINES and settings().provider == "fal":
            final = _produce_talking(day, plate_id, night, still_urls[0], stills[0], engine, workdir, seed)
            item["media_path"] = str(final)
            item["media_url"] = P.upload(final, f"lilo/{day.day}/final.mp4")
            item["engine"] = engine
        elif day.format is Format.reel:
            no_fire = not venue.fire_allowed(plate_id)
            a_roll_raw = P.animate(still_urls[0], day.visual.motion_prompt, 10, no_fire=no_fire)
            audio = voice.synthesize(spoken_script(day), workdir / "voice.mp3")
            a_roll = video.download(P.lipsync(a_roll_raw, P.upload(audio, f"lilo/{day.day}/voice.mp3")),
                                    workdir / "a_roll.mp4")
            cutaways = []
            for i, (line, spec) in enumerate(zip(broll_lines, steps["broll"])):
                if spec["source"] == "venue_plate":   # the real room, animated - never an invented interior
                    img = venue.plate_9x16(plate_id, night=night)
                else:
                    img = P.image(spec["prompt"], seed + 100 + i, workdir / "broll", use_lora=False)[0]
                clip = video.download(P.animate(P.upload(img, f"lilo/{day.day}/{img.name}"), line.shot, 5,
                                                no_fire=no_fire and spec["source"] == "venue_plate"),
                                      workdir / f"broll_{i}.mp4")
                cutaways.append((clip, line.t_start, line.t_end))
            subs = subtitles.write_ass(day.script, workdir / "subs.ass", hook=day.hook_he)
            final = video.compose(a_roll, cutaways, workdir / "final.mp4", subtitles=subs)
            item["media_path"] = str(final)
            item["media_url"] = P.upload(final, f"lilo/{day.day}/final.mp4")
        else:
            item["image_urls"] = still_urls[:10]

    _queue_dir().mkdir(parents=True, exist_ok=True)
    (_queue_dir() / f"{day.day}.json").write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8")
    return item


def chunk_lines(lines: list, max_s: float) -> list[list]:
    """Consecutive script lines grouped into clips no longer than the engine's max length.
    Silent lines (no speech) form their own groups - they become ambient cutaways."""
    groups: list[list] = []
    for line in lines:
        cur = groups[-1] if groups else None
        same_kind = cur and bool(cur[0].spoken_he.strip()) == bool(line.spoken_he.strip())
        if cur and same_kind and line.t_end - cur[0].t_start <= max_s:
            cur.append(line)
        else:
            groups.append([line])
    return groups


def retime(groups: list[list], durations: list[float]) -> list:
    """Subtitle timings from the real clip lengths: each clip's span is shared by text length."""
    out, t = [], 0.0
    for group, dur in zip(groups, durations):
        weights = [max(len(l.spoken_he or l.on_screen_text_he), 1) for l in group]
        for line, w in zip(group, weights):
            span = dur * w / sum(weights)
            out.append(line.model_copy(update={"t_start": round(t, 2), "t_end": round(t + span, 2)}))
            t += span
    return out


def _produce_talking(day: DayPlan, plate_id, night: bool, hero_url: str, hero: Path, engine: str,
                     workdir: Path, seed: int) -> Path:
    """2026 path: the video model speaks the Hebrew itself (picture + voice + lip-sync in one pass)."""
    from . import providers as P
    from . import subtitles, video
    from .fal_provider import clip_seconds, talk, talk_prompt

    no_fire = not venue.fire_allowed(plate_id)
    groups = chunk_lines(day.script, TALK_ENGINES[engine][1])
    clips, start_url = [], hero_url
    for i, group in enumerate(groups):
        spoken = " ".join(l.spoken_he.strip() for l in group if l.spoken_he.strip())
        if spoken:
            prompt = talk_prompt(_clean(day.visual.scene), _clean(day.visual.action), spoken, no_fire)
            url = talk(engine, start_url, prompt, clip_seconds(engine, spoken))
        else:   # silent cutaway: the real room or the dish, animated without speech
            if plate_id and not venue.is_food_shot(group[0].shot):
                img = venue.plate_9x16(plate_id, night=night)
            else:
                from .brain import load_menu
                img = P.image(broll_prompt(day, group[0].shot, load_menu()), seed + 100 + i,
                              workdir / "broll", use_lora=False)[0]
            url = P.animate(P.upload(img, f"lilo/{day.day}/{img.name}"), " ".join(l.shot for l in group), 5,
                            no_fire=no_fire and bool(plate_id))
        clip = video.download(url, workdir / f"talk_{i}.mp4")
        if spoken:
            clip = video.trim_after_speech(clip)
            # the next talking clip continues from where this one ended - no jump between clips
            frame = video.last_frame(clip, workdir / f"talk_{i}_last.jpg")
            start_url = P.upload(frame, f"lilo/{day.day}/{frame.name}")
        clips.append(clip)
        print(f"[talk] {day.day} clip {i + 1}/{len(groups)} ready", flush=True)
    lines = retime(groups, [video.probe(c)[0] for c in clips])
    subs = subtitles.write_ass(lines, workdir / "subs.ass", hook=day.hook_he)
    return video.concat(clips, workdir / "final.mp4", subtitles=subs)


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
    guard = PublishGuard(date.fromisoformat(s.account_created))
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

    # Prefer direct file upload (no TikTok domain verification needed)
    media = Path(item["media_path"]) if item.get("media_path") and Path(item["media_path"]).exists() else item["media_url"]
    return TikTokPublisher().publish_video(media, item["caption"])


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
            render = can_render(s)
            item = produce_day(d, menu, s.data_dir / "renders" / d.day.isoformat(), not render)
            print(f"{d.day}: queued" if render else json.dumps(item["steps"], ensure_ascii=False, indent=2))
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
