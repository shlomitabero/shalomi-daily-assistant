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
