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
        "dish_id": "spicy_ramen", "concept": "משיכת נודלס", "hook_he": "שמעתם את הווק?",
        "hook_alternatives_he": ["א", "ב"],
        "visual": {"scene": "at the wok line", "action": "lifting noodles", "wardrobe": "",
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
    assert "spicy_ramen" in captured["messages"][0]["content"]
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
                              post_time="20:00", pillar=pillar, dish_id="spicy_ramen", hook="h", fmt="reel")
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
    monkeypatch.setattr(pipeline, "PublishGuard", lambda _: account_health.PublishGuard(date(2026, 10, 1), tmp_path / "l.json"))
    assert pipeline.publish_due(now) == ["2026-10-18: waiting for approval"]
    pipeline.approve("2026-10-18")
    assert all("DRY RUN" in l for l in pipeline.publish_due(now))
