"""MODULE 2.2 - LILO's voice via the ElevenLabs REST API.

    python -m zozobra.voice design            # create her voice once, prints voice_id
    python -m zozobra.voice say "טקסט" out.mp3 # one-off line
    python -m zozobra.voice week data/calendars/week_2026-10-18.json   # every reel in a calendar
"""
from __future__ import annotations

import argparse
import base64
import re
import sys
from pathlib import Path

import requests

from . import persona
from .config import settings
from .schemas import Format, WeekPlan

API = "https://api.elevenlabs.io/v1"
TTS_MODEL = "eleven_v3"                       # Hebrew + inline audio tags ([laughs], [whispers]...)
DESIGN_MODEL = "eleven_multilingual_ttv_v2"   # text-to-voice design

# Read styles for LILO's voice (eleven_v3 accepts stability 0.0 / 0.5 / 1.0 only).
# The owner picks one on the setup page; it is stored as runtime "voice_preset".
VOICE_PRESETS = {
    "natural": {"label": "טבעית", "stability": 0.5, "speed": 1.0, "tags": True},
    "steady": {"label": "יציבה ונקייה", "stability": 1.0, "speed": 1.0, "tags": False},
    "lively": {"label": "אנרגטית", "stability": 0.0, "speed": 1.05, "tags": True},
}
DEFAULT_PRESET = "natural"


def _preset(name: str | None = None) -> dict:
    from .config import runtime

    return VOICE_PRESETS.get(name or runtime().get("voice_preset", DEFAULT_PRESET), VOICE_PRESETS[DEFAULT_PRESET])

DESIGN_PREVIEW_TEXT = (
    "וואלה, תקשיבו רגע. אני עומדת פה ליד הווק, האש בגובה של מטר, "
    "והראמן הזה? רמת חריפות: לילו. אין דברים כאלה. נתראה ליד האש."
)


def _headers() -> dict:
    key = settings().elevenlabs_api_key
    if not key:
        sys.exit("ELEVENLABS_API_KEY is not set")
    return {"xi-api-key": key, "Content-Type": "application/json"}


def design_voice(name: str = "LILO") -> str:
    """Generate 3 previews from the persona description, keep the first, return its voice_id.
    Listen to data/voice_previews/*.mp3 and re-run (or pick another id) until it's her."""
    r = requests.post(f"{API}/text-to-voice/design", headers=_headers(), timeout=120, json={
        "voice_description": persona.VOICE_DESCRIPTION,
        "model_id": DESIGN_MODEL,
        "text": DESIGN_PREVIEW_TEXT,
    })
    r.raise_for_status()
    previews = r.json()["previews"]
    out = settings().data_dir / "voice_previews"
    out.mkdir(parents=True, exist_ok=True)
    for i, p in enumerate(previews):
        (out / f"preview_{i}_{p['generated_voice_id']}.mp3").write_bytes(base64.b64decode(p["audio_base_64"]))

    r = requests.post(f"{API}/text-to-voice", headers=_headers(), timeout=60, json={
        "voice_name": name,
        "voice_description": persona.VOICE_DESCRIPTION,
        "generated_voice_id": previews[0]["generated_voice_id"],
    })
    r.raise_for_status()
    return r.json()["voice_id"]


SAMPLE_LINE = "[excited] שנייה, תשמעו את הווק הזה. [laughs] רמת חריפות: לילו. נתראה ליד האש!"


def hebrew_voices(limit: int = 12) -> list[dict]:
    """Native Hebrew female voices from the ElevenLabs Voice Library (real Israeli accents)."""
    seen, out = set(), []
    for params in ({"language": "he", "gender": "female", "age": "young"},
                   {"language": "he", "gender": "female"},
                   {"language": "he"}):
        r = requests.get(f"{API}/shared-voices", headers=_headers(), timeout=30,
                         params={**params, "page_size": 30, "sort": "usage_character_count_1y"})
        r.raise_for_status()
        for v in r.json().get("voices", []):
            if v["voice_id"] in seen or (v.get("gender") and v["gender"] != "female"):
                continue
            seen.add(v["voice_id"])
            out.append({"voice_id": v["voice_id"], "public_owner_id": v["public_owner_id"],
                        "name": v.get("name", ""), "accent": v.get("accent", ""), "age": v.get("age", ""),
                        "description": (v.get("description") or "")[:140], "preview_url": v.get("preview_url", "")})
        if len(out) >= limit:
            break
    return out[:limit]


def adopt_library_voice(public_owner_id: str, voice_id: str, name: str = "LILO") -> str:
    """Add a Voice Library voice to the account and return the voice_id to use for TTS."""
    r = requests.post(f"{API}/voices/add/{public_owner_id}/{voice_id}", headers=_headers(), timeout=30,
                      json={"new_name": name})
    r.raise_for_status()
    return r.json()["voice_id"]


def synthesize(text: str, out_path: Path, voice_id: str | None = None, seed: int = 4242,
               preset: str | None = None) -> Path:
    voice_id = voice_id or settings().elevenlabs_voice_id
    if not voice_id:
        sys.exit("ELEVENLABS_VOICE_ID is not set - run `python -m zozobra.voice design` first")
    p = _preset(preset)
    r = requests.post(
        f"{API}/text-to-speech/{voice_id}",
        params={"output_format": "mp3_44100_128"},
        headers=_headers(),
        timeout=180,
        json={
            "text": text if p["tags"] else re.sub(r"\[[^\]]*\]\s*", "", text),
            "model_id": TTS_MODEL,
            "language_code": "he",
            "voice_settings": {"stability": p["stability"], "similarity_boost": 0.85, "speed": p["speed"],
                               "use_speaker_boost": True},
            "seed": seed,               # same seed -> repeatable takes for re-renders
        },
    )
    r.raise_for_status()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(r.content)
    return out_path


def voice_week(calendar: Path) -> list[Path]:
    from .brain import spoken_script

    plan = WeekPlan.model_validate_json(calendar.read_text(encoding="utf-8"))
    out_dir = settings().data_dir / "audio" / calendar.stem
    return [synthesize(spoken_script(d), out_dir / f"{d.day}.mp3")
            for d in plan.days if d.format is Format.reel]


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("design")
    say = sub.add_parser("say"); say.add_argument("text"); say.add_argument("out", type=Path)
    wk = sub.add_parser("week"); wk.add_argument("calendar", type=Path)
    args = ap.parse_args()
    if args.cmd == "design":
        print("voice_id:", design_voice())
    elif args.cmd == "say":
        print(synthesize(args.text, args.out))
    else:
        for p in voice_week(args.calendar):
            print(p)


if __name__ == "__main__":
    main()
