import json
from datetime import date, datetime, timedelta
from types import SimpleNamespace

import pytest

from zozobra import account_health, analytics, brain, compliance, image_gen, persona, pipeline
from zozobra.schemas import DayPlan, WeekPlan


def make_day(d: date, **over) -> dict:
    base = {
        "day": d.isoformat(), "weekday_he": "ראשון", "post_time_local": "20:00",
        "platforms": ["instagram", "tiktok"], "format": "reel", "pillar": "hero_dish",
        "dish_id": "bangkok_heat", "concept": "משיכת נודלס", "hook_he": "שמעתם את הווק?",
        "hook_alternatives_he": ["א", "ב"],
        "visual": {"venue_plate": "bar_tower_vertical", "scene": "at the wok line", "action": "lifting noodles", "wardrobe": "",
                   "motion_prompt": "slow push-in"},
        "script": [
            {"t_start": 0, "t_end": 4, "spoken_he": "וואלה", "voice_direction": "[excited]",
             "on_screen_text_he": "", "shot": "medium, LILO to camera"},
            {"t_start": 4, "t_end": 12, "spoken_he": "תטעמו", "voice_direction": "[whispers]",
             "on_screen_text_he": "", "shot": "macro noodle pull"},
        ],
        "caption_he": "מי בא?", "cta_he": "תייגו", "hashtags": ["אוכלבתלאביב", "ramen"],
        "trend_or_audio_note": "",
    }
    base.update(over)
    return base


def make_week(start=date(2026, 10, 18)) -> dict:
    pillars = ["hero_dish", "fire_show", "night_vibe", "challenge", "pov_story", "community", "hero_dish"]
    return {"weekly_focus": "ראמן", "strategy_summary_he": "...",
            "days": [make_day(start + timedelta(i), pillar=pillars[i]) for i in range(7)]}


MENU = brain.load_menu()
IDS = {d["id"] for d in MENU["dishes"]} | {d["id"] for d in MENU["drinks"]}


def test_caption_always_carries_disclosures():
    cap = compliance.finalize_caption(DayPlan.model_validate(make_day(date(2026, 10, 18))))
    assert persona.AI_DISCLOSURE_HE in cap and persona.AD_DISCLOSURE_HE in cap
    assert "#אוכלבתלאביב" in cap


def test_validation_catches_invented_dish_and_bad_formats():
    d = DayPlan.model_validate(make_day(date(2026, 10, 18), dish_id="lobster", format="carousel"))
    problems = compliance.validate_day(d, IDS)
    assert any("unknown dish_id" in p for p in problems)
    assert any("TikTok only" in p for p in problems)
    assert compliance.validate_day(DayPlan.model_validate(make_day(date(2026, 10, 18))), IDS) == []


def test_visual_prompt_locks_identity():
    p = brain.full_image_prompt(DayPlan.model_validate(make_day(date(2026, 10, 18))))
    assert p.startswith(f"photo of {persona.TRIGGER} woman")
    assert persona.FACE_TOKENS in p and persona.SIGNATURE_LOOK in p


def test_workflow_patching():
    wf = image_gen.build_workflow("PROMPT", 7, width=1080, height=1350)
    titles = {n["_meta"]["title"]: n for n in wf.values()}
    assert titles["POSITIVE"]["inputs"]["text"] == "PROMPT"
    assert titles["SEED"]["inputs"]["seed"] == 7
    assert titles["LATENT"]["inputs"]["height"] == 1350
    assert all(not k.startswith("_") for k in wf)


def test_publish_guard(tmp_path):
    g = account_health.PublishGuard(date(2026, 10, 15), ledger=tmp_path / "l.json")
    tz = account_health.TZ
    assert not g.check("instagram", datetime(2026, 10, 18, 3, 0, tzinfo=tz)).allowed  # quiet hours
    t = datetime(2026, 10, 18, 19, 0, tzinfo=tz)
    assert g.check("instagram", t).allowed
    g.record("instagram", t, "x")
    assert "cap" in g.check("instagram", t + timedelta(hours=4)).reason  # week 1: 1/day


def test_brain_with_fake_client():
    week = make_week()

    class FakeStream:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get_final_message(self):
            return SimpleNamespace(stop_reason="end_turn", stop_details=None,
                                   content=[SimpleNamespace(type="text", text=json.dumps(week, ensure_ascii=False))])

    captured = {}

    def stream(**kw):
        captured.update(kw)
        return FakeStream()

    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=stream)))
    plan = brain.generate_week("ראמן", date(2026, 10, 18), menu=MENU, client=client)
    assert len(plan.days) == 7
    assert captured["output_config"]["format"]["type"] == "json_schema"
    assert "bangkok_heat" in captured["messages"][0]["content"]
    md = brain.render_markdown(plan)
    assert persona.AI_DISCLOSURE_HE in md


def test_brain_rejects_hallucinated_dish():
    week = make_week()
    week["days"][2]["dish_id"] = "sushi_tower"
    msg = SimpleNamespace(stop_reason="end_turn", stop_details=None,
                          content=[SimpleNamespace(type="text", text=json.dumps(week, ensure_ascii=False))])

    class S:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get_final_message(self): return msg

    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=lambda **kw: S())))
    with pytest.raises(ValueError, match="sushi_tower"):
        brain.generate_week("x", date(2026, 10, 18), menu=MENU, client=client)


def test_analytics_insights(tmp_path):
    conn = analytics.db(tmp_path / "a.sqlite")
    for i, (pillar, views, shares) in enumerate([("fire_show", 1000, 80), ("night_vibe", 1000, 5)]):
        analytics.record_post(conn, post_id=str(i), platform="instagram", day="2026-10-18",
                              post_time="20:00", pillar=pillar, dish_id="bangkok_heat", hook="h", fmt="reel")
        conn.execute("INSERT INTO metrics VALUES (?,?,?,?,?,?,?,?)", (str(i), "t", views, views, 50, 10, shares, 20))
    conn.commit()
    text = analytics.weekly_insights(conn, top_n=1)
    assert text.index("fire_show") < text.index("night_vibe")


def test_pipeline_dry_run_and_approval_gate(tmp_path, monkeypatch):
    monkeypatch.setenv("DRY_RUN", "true")
    monkeypatch.setenv("REQUIRE_HUMAN_APPROVAL", "true")
    monkeypatch.setattr(pipeline, "_queue_dir", lambda: tmp_path / "queue")
    monkeypatch.setattr(account_health.settings().__class__, "data_dir", tmp_path, raising=False)
    plan = WeekPlan.model_validate(make_week())
    day = plan.days[0]
    item = pipeline.produce_day(day, MENU, tmp_path / "r", dry_run=True)
    assert item["steps"]["broll"] and "no faces" in item["steps"]["broll"][0]["prompt"]
    assert "[excited]" in item["steps"]["voice_text"]

    now = datetime(2026, 10, 18, 20, 5, tzinfo=account_health.TZ)
    monkeypatch.setattr(pipeline, "PublishGuard", lambda *_: account_health.PublishGuard(date(2026, 10, 1), tmp_path / "l.json"))
    assert pipeline.publish_due(now) == ["2026-10-18: waiting for approval"]
    pipeline.approve("2026-10-18")
    assert all("DRY RUN" in l for l in pipeline.publish_due(now))


def test_subtitles_ass():
    from zozobra import subtitles

    day = DayPlan.model_validate(make_day(date(2026, 10, 18)))
    day.script[1].on_screen_text_he = "רמת חריפות: לילו"
    ass = subtitles.build_ass(day.script, hook="שנייה {תשמעו}")
    assert "Style: Hook,Heebo Black" in ass
    assert "Dialogue: 0,0:00:04.00,0:00:12.00,Line" in ass and "רמת חריפות" in ass
    assert "{תשמעו}" not in ass  # braces would be parsed as ASS override tags


def test_sample_week_is_valid():
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "examples" / "week_sample.json"
    plan = WeekPlan.model_validate_json(path.read_text(encoding="utf-8"))
    assert len(plan.days) == 7
    assert all(compliance.validate_day(d, IDS) == [] for d in plan.days)


def test_web_panel_flow(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DRY_RUN", "true")
    monkeypatch.setenv("PANEL_PASSWORD", "")
    from zozobra import web

    c = TestClient(web.app)
    for url in ["/", "/plan", "/calendars", "/menu", "/setup", "/insights", "/replies"]:
        assert c.get(url).status_code == 200, url
    assert c.post("/setup/sample", follow_redirects=False).status_code == 303
    pipeline.produce_day(
        WeekPlan.model_validate_json((tmp_path / "calendars" / "week_2026-10-18.json").read_text(encoding="utf-8")).days[0],
        MENU, tmp_path / "r", dry_run=True)
    r = c.post("/queue/2026-10-18/save", data={"caption": "בלי גילוי", "post_time": "20:00", "action": "approve"})
    assert r.status_code == 200
    import json as _json

    saved = _json.loads((tmp_path / "queue" / "2026-10-18.json").read_text(encoding="utf-8"))
    assert saved["status"] == "approved" and persona.AD_DISCLOSURE_HE in saved["caption"]
    assert c.get("/media/../../etc/passwd").status_code == 404
    assert c.post("/menu", data={"menu": "{bad"}).status_code == 200  # shows error, doesn't save


def test_panel_password(monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("PANEL_PASSWORD", "s3cret")
    from zozobra import web

    c = TestClient(web.app)
    assert c.get("/").status_code == 401
    assert c.get("/", auth=("lilo", "s3cret")).status_code == 200
    assert c.get("/healthz").status_code == 200


def test_venue_plates_drive_scenes(tmp_path):
    from zozobra import venue

    assert {"bar_tower_vertical", "entrance_fringe_corridor", "dining_hall_ribbons"} <= venue.plate_ids()
    for pid in venue.plate_ids():
        assert venue.plate_path(pid).exists()
    crop = venue.plate_9x16("dining_hall_ribbons", out_dir=tmp_path)
    from PIL import Image

    assert Image.open(crop).size == (1080, 1920)

    bad = DayPlan.model_validate(make_day(date(2026, 10, 18)))
    bad.visual.venue_plate = "rooftop"
    assert any("venue_plate" in p for p in compliance.validate_day(bad, IDS))

    week = WeekPlan.model_validate_json((pipeline.Path(__file__).resolve().parents[1] / "examples" / "week_sample.json").read_text(encoding="utf-8"))
    thu = next(d for d in week.days if d.day == date(2026, 10, 22))
    item = pipeline.produce_day(thu, MENU, tmp_path / "r", dry_run=True)
    assert item["steps"]["venue_plate"] == "bar_tower_vertical" and item["steps"]["venue_night_variant"]
    assert [b["source"] for b in item["steps"]["broll"]] == ["venue_plate"]
    sun = pipeline.produce_day(week.days[0], MENU, tmp_path / "r", dry_run=True)
    assert all(b["source"] == "generated" for b in sun["steps"]["broll"])  # food macros are generated
    assert "paper-panel canopy" in brain.SYSTEM_PROMPT and "lantern" not in venue.brain_brief() and "bar_tower_vertical" in brain.SYSTEM_PROMPT


def test_comfy_img2img_patch():
    wf = image_gen.build_workflow("P", 1, init_image="plate.jpg", denoise=0.6)
    sampler = next(n for n in wf.values() if n["_meta"]["title"] == "SEED")["inputs"]
    assert sampler["latent_image"] == ["101", 0] and sampler["denoise"] == 0.6


def test_shots_with_lilo_are_never_broll():
    from zozobra.video import is_broll

    assert not is_broll("medium, LILO walks out of frame past the flames")
    assert is_broll("macro flame burst in the wok")
    assert is_broll("venue establishing: slow tilt up to the lantern canopy")


def test_fresh_install_seeds_sample_week(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    from zozobra import web

    web._seed_sample_week()
    assert (tmp_path / "calendars" / "week_2026-10-18.json").exists()
    assert (tmp_path / "refs" / "R0_anchor.png").exists()


def test_public_media_urls(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PANEL_PASSWORD", "pw")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://panel.example")
    monkeypatch.setenv("MEDIA_TOKEN", "tok123")
    (tmp_path / "refs").mkdir()
    (tmp_path / "refs" / "a.png").write_bytes(b"x")
    from zozobra import fal_provider, web

    assert fal_provider.upload(tmp_path / "refs" / "a.png") == "https://panel.example/pub/tok123/refs/a.png"
    c = TestClient(web.app)
    assert c.get("/pub/tok123/refs/a.png").content == b"x"          # no basic auth needed
    assert c.get("/pub/wrong/refs/a.png").status_code == 404
    assert c.get("/pub/tok123/../../etc/passwd").status_code in (401, 404)  # never served
    assert c.get("/media/refs/a.png").status_code == 401             # everything else still locked
