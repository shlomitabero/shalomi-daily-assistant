"""Setup checker: what's configured, what's missing, and how to fix it (in Hebrew).

    python -m zozobra.doctor            # offline checks only
    python -m zozobra.doctor --online   # also pings each API with the configured keys
"""
from __future__ import annotations

import argparse
import shutil
from dataclasses import dataclass

import requests

from .config import settings


@dataclass
class Check:
    key: str
    title: str
    ok: bool
    detail: str
    fix: str
    required: bool = True


def _ping(fn) -> tuple[bool, str]:
    try:
        return True, fn()
    except Exception as e:  # report, never crash the checker
        return False, f"{type(e).__name__}: {str(e)[:160]}"


def run(online: bool = False) -> list[Check]:
    s = settings()
    out: list[Check] = []
    add = lambda *a, **k: out.append(Check(*a, **k))

    add("ffmpeg", "ffmpeg (עריכת וידאו)", bool(shutil.which("ffmpeg")), shutil.which("ffmpeg") or "לא מותקן",
        "התקן ffmpeg (מותקן אוטומטית ב-Docker)")
    try:
        from .brain import load_menu

        menu = load_menu()
        add("menu", "תפריט ZOZOBRA", bool(menu.get("dishes")), f"{len(menu.get('dishes', []))} מנות",
            "ערוך את התפריט בלשונית 'תפריט'")
    except Exception as e:
        add("menu", "תפריט ZOZOBRA", False, str(e), "תקן את data/menu.json")

    import os

    has_claude = bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"))
    add("anthropic", "Claude (המוח)", has_claude, "מוגדר" if has_claude else "חסר",
        "צור מפתח ב-console.anthropic.com והגדר ANTHROPIC_API_KEY")
    if s.provider == "fal":
        add("fal", "fal.ai (תמונות + וידאו + ליפסינק)", bool(s.fal_key), "מוגדר" if s.fal_key else "חסר",
            "צור מפתח ב-fal.ai/dashboard/keys והגדר FAL_KEY")
        add("lora", "מודל הפנים של לילו (LoRA)", bool(s.lora_url), s.lora_url[:60] or "עוד לא אומן",
            "לשונית 'הקמה': עוגן → גיליון → אימון. בסוף מתקבל LILO_LORA_URL")
    else:
        for k, title in [("comfyui_url", "ComfyUI"), ("runway_api_key", "Runway"), ("sync_api_key", "Sync"),
                         ("media_bucket", "S3/R2 bucket")]:
            add(k, title, bool(getattr(s, k)), "מוגדר" if getattr(s, k) else "חסר", f"הגדר {k.upper()}")
    add("eleven", "ElevenLabs (קול)", bool(s.elevenlabs_api_key), "מוגדר" if s.elevenlabs_api_key else "חסר",
        "צור מפתח ב-elevenlabs.io → Profile → API keys, הגדר ELEVENLABS_API_KEY")
    add("voice", "הקול של לילו", bool(s.elevenlabs_voice_id), s.elevenlabs_voice_id or "עוד לא נוצר",
        "לשונית 'הקמה' → 'צור קול', ואז הגדר ELEVENLABS_VOICE_ID")
    anchor = s.data_dir / "refs" / "R0_anchor.png"
    add("anchor", "תמונת עוגן (R0)", anchor.exists(), "קיימת" if anchor.exists() else "חסרה",
        "לשונית 'הקמה' → 'צור מועמדות לעוגן' ובחר אחת", required=False)
    add("ig", "אינסטגרם (Graph API)", bool(s.ig_user_id and s.ig_access_token),
        "מוגדר" if s.ig_user_id else "חסר", "ראה docs/05 סעיף 4.1 — IG_USER_ID + IG_ACCESS_TOKEN")
    add("tiktok", "טיקטוק (Content Posting API)", bool(s.tiktok_access_token),
        "מוגדר" if s.tiktok_access_token else "חסר", "ראה docs/05 — TIKTOK_ACCESS_TOKEN", required=False)
    add("dry", "מצב בדיקה (DRY_RUN)", True, "פעיל — שום דבר לא מתפרסם" if s.dry_run else "כבוי — פרסום אמיתי",
        "כשהכול ירוק, הגדר DRY_RUN=false", required=False)

    if online:
        by_key = {c.key: c for c in out}

        def check(key: str, fn):
            c = by_key[key]
            if c.ok:
                c.ok, c.detail = _ping(fn)

        def claude():
            import anthropic

            anthropic.Anthropic().models.retrieve(s.model)
            return f"מחובר ({s.model})"

        def eleven():
            r = requests.get("https://api.elevenlabs.io/v1/user", headers={"xi-api-key": s.elevenlabs_api_key}, timeout=20)
            r.raise_for_status()
            return "מחובר"

        def ig():
            r = requests.get(f"{s.graph_base}/{s.ig_user_id}",
                             params={"fields": "username", "access_token": s.ig_access_token}, timeout=20)
            r.raise_for_status()
            return "@" + r.json()["username"]

        def tiktok():
            from .publish_tiktok import TikTokPublisher

            return "@" + TikTokPublisher().creator_info().get("creator_username", "?")

        check("anthropic", claude)
        check("eleven", eleven)
        check("ig", ig)
        check("tiktok", tiktok)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--online", action="store_true")
    for c in run(ap.parse_args().online):
        mark = "✅" if c.ok else ("❌" if c.required else "⚠️")
        print(f"{mark} {c.title}: {c.detail}" + ("" if c.ok else f"\n    → {c.fix}"))


if __name__ == "__main__":
    main()
