import json
from pathlib import Path

from zozobra.pipeline import chunk_lines, retime
from zozobra.schemas import WeekPlan

SAMPLE = Path(__file__).resolve().parents[1] / "examples" / "week_sample.json"


def _week():
    return WeekPlan.model_validate_json(SAMPLE.read_text(encoding="utf-8"))


def test_chunks_fit_engine_length_and_keep_order():
    for day in _week().days:
        groups = chunk_lines(day.script, 8)
        assert [l for g in groups for l in g] == list(day.script)
        for g in groups:
            assert g[-1].t_end - g[0].t_start <= 8 or len(g) == 1
            assert len({bool(l.spoken_he.strip()) for l in g}) == 1


def test_retime_follows_real_clip_lengths():
    day = _week().days[0]
    groups = chunk_lines(day.script, 8)
    lines = retime(groups, [8.0] * len(groups))
    assert lines[0].t_start == 0 and abs(lines[-1].t_end - 8.0 * len(groups)) < 0.05
    assert all(a.t_end <= b.t_start + 0.01 for a, b in zip(lines, lines[1:]))


def test_no_lanterns_or_bar_fire_in_sample():
    text = SAMPLE.read_text(encoding="utf-8").lower()
    assert "lantern" not in text


def test_city_posts_skip_ad_label_but_keep_ai_label():
    from zozobra import persona
    from zozobra.compliance import finalize_caption, validate_day

    launch = WeekPlan.model_validate_json((SAMPLE.parent / "launch_posts.json").read_text(encoding="utf-8"))
    for day in launch.days:
        cap = finalize_caption(day)
        assert persona.AD_DISCLOSURE_HE not in cap and persona.AI_DISCLOSURE_HE in cap
        assert "זוזוברה" not in day.model_dump_json() and validate_day(day, set()) == []
    zoz = _week().days[0]
    assert persona.AD_DISCLOSURE_HE in finalize_caption(zoz)


def test_campaign_phases():
    from datetime import date

    from zozobra import campaign

    assert campaign.phase(date(2026, 10, 18)) == "brand"          # day 1
    assert campaign.phase(date(2026, 11, 1)) == "accelerate"      # day 15
    assert campaign.phase(date(2026, 11, 17)) == "reveal"         # day 31
    assert campaign.phase(date(2026, 12, 2)) == "launch"          # day 46
    assert campaign.phase(date(2026, 12, 17)) == "open"
    assert campaign.series(date(2026, 10, 18)).startswith("Hidden Gems")   # Sunday
    assert "ZOZOBRA is never named" in campaign.brief(date(2026, 10, 18))


def test_public_waitlist_needs_consent(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PANEL_PASSWORD", "pw")
    from zozobra import web

    c = TestClient(web.app)
    assert c.get("/join?src=bio").status_code == 200            # public, no password
    assert c.post("/join", data={"name": "דנה", "phone": "0501234567"}).status_code == 400
    assert c.post("/join", data={"name": "דנה", "phone": "0501234567", "consent": "yes", "src": "bio"}).status_code == 200
    assert c.get("/leads").status_code == 401                    # list stays private
    r = c.get("/leads.csv", auth=("lilo", "pw"))
    assert "0501234567" in r.text and "bio" in r.text


def test_instagram_login_token_uses_instagram_graph(tmp_path, monkeypatch):
    from zozobra import publish_instagram
    from zozobra.config import settings

    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.delenv("IG_ACCESS_TOKEN", raising=False)
    calls = []

    class R:
        status_code = 200
        text = ""
        def json(self): return {"user_id": "1784", "username": "lilo_moskowitz"}

    monkeypatch.setattr(publish_instagram.requests, "get", lambda url, **kw: calls.append(url) or R())
    assert publish_instagram.connect(" IGAAtoken ")["username"] == "lilo_moskowitz"
    assert calls[0].startswith("https://graph.instagram.com/")
    s = settings()
    assert s.ig_access_token == "IGAAtoken" and s.ig_user_id == "1784"
    assert s.graph_base.startswith("https://graph.instagram.com/")


def test_phone_posting_only_after_approval(tmp_path, monkeypatch):
    import json as _json

    from fastapi.testclient import TestClient

    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PANEL_PASSWORD", "")
    from zozobra import web

    (tmp_path / "queue").mkdir()
    video = tmp_path / "final.mp4"
    video.write_bytes(b"x")
    item = {"day": "2026-10-19", "post_time": "20:00", "platforms": ["instagram"], "format": "reel",
            "pillar": "pov_story", "dish_id": "atmosphere", "hook": "h", "caption": "c", "status": "pending",
            "media_path": str(video), "image_urls": [], "steps": {}}
    (tmp_path / "queue" / "2026-10-19.json").write_text(_json.dumps(item), encoding="utf-8")
    c = TestClient(web.app)
    assert "id=\"share\"" not in c.get("/queue/2026-10-19").text
    c.post("/queue/2026-10-19/posted")
    assert _json.loads((tmp_path / "queue" / "2026-10-19.json").read_text())["status"] == "pending"
    c.post("/queue/2026-10-19/save", data={"caption": "c", "post_time": "20:00", "action": "approve"})
    assert "id=\"share\"" in c.get("/queue/2026-10-19").text
    c.post("/queue/2026-10-19/posted")
    assert _json.loads((tmp_path / "queue" / "2026-10-19.json").read_text())["status"] == "published"


def test_home_screen_link_logs_in_with_cookie(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PANEL_PASSWORD", "pw")
    monkeypatch.setenv("PANEL_LOGIN_KEY", "secret-key")
    from zozobra import web

    c = TestClient(web.app, base_url="https://testserver")
    assert c.get("/").status_code == 401
    assert c.get("/?k=wrong").status_code == 401
    assert c.get("/?k=secret-key").status_code == 200
    assert c.get("/calendars").status_code == 200            # cookie from the key visit
    assert TestClient(web.app).get("/apple-touch-icon.png").status_code == 200


def test_fix_button_revises_text_without_rerender(tmp_path, monkeypatch):
    import json as _json
    import shutil

    from fastapi.testclient import TestClient

    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PANEL_PASSWORD", "")
    monkeypatch.setenv("DRY_RUN", "true")
    from zozobra import brain, jobs, pipeline, web

    (tmp_path / "calendars").mkdir()
    shutil.copy(SAMPLE.parent / "launch_posts.json", tmp_path / "calendars" / "week_2026-10-19.json")
    day = WeekPlan.model_validate_json((SAMPLE.parent / "launch_posts.json").read_text(encoding="utf-8")).days[0]
    monkeypatch.setattr(pipeline, "_queue_dir", lambda: tmp_path / "queue")
    pipeline.produce_day(day, {}, tmp_path / "r", dry_run=True)
    monkeypatch.setattr(brain, "revise_day", lambda d, instr, **kw: d.model_copy(update={"caption_he": "כיתוב מתוקן"}))
    monkeypatch.setattr(jobs, "submit", lambda title, fn, *a: fn(*a))   # run inline

    c = TestClient(web.app)
    assert "✏️ תקן" in c.get("/").text
    c.post("/queue/2026-10-19/fix", data={"instruction": "תקצר את הכיתוב"})
    item = _json.loads((tmp_path / "queue" / "2026-10-19.json").read_text(encoding="utf-8"))
    assert item["status"] == "pending" and item["caption"].startswith("כיתוב מתוקן")
    assert item["revisions"][-1]["instruction"] == "תקצר את הכיתוב"
    c.post("/queue/2026-10-19/approve")
    assert _json.loads((tmp_path / "queue" / "2026-10-19.json").read_text(encoding="utf-8"))["status"] == "approved"


def test_clip_length_fits_line_and_silent_tail_is_cut(tmp_path):
    import subprocess

    from zozobra import video
    from zozobra.fal_provider import clip_seconds

    assert clip_seconds("veo", "נעים מאוד, אני לילו.") == 4
    assert clip_seconds("veo", " ".join(["מילה"] * 30)) == 8
    clip = tmp_path / "c.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x568:d=5", "-f", "lavfi",
                    "-i", "sine=f=440:d=2,apad=pad_dur=3", "-shortest", str(clip)], check=True)
    trimmed = video.trim_after_speech(clip)
    assert 2.0 < video.probe(trimmed)[0] < 2.8
    assert video.last_frame(trimmed, tmp_path / "f.jpg").stat().st_size > 0


def test_lilo_never_says_she_is_ai_in_scheduled_scripts():
    import re

    for path in (SAMPLE.parent / "calendars").glob("week_*.json"):
        for day in WeekPlan.model_validate_json(path.read_text(encoding="utf-8")).days:
            for line in day.script:
                assert not re.search(r"\bAI\b|דמות|וירטואל", line.spoken_he + " " + line.on_screen_text_he), (day.day, line)
