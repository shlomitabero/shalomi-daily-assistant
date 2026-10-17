"""MODULE 2.2 - LILO's voice via the ElevenLabs REST API.

    python -m zozobra.voice design            # create her voice once, prints voice_id
    python -m zozobra.voice say "טקסט" out.mp3 # one-off line
    python -m zozobra.voice week data/calendars/week_2026-10-18.json   # every reel in a calendar
"""
from __future__ import annotations

import argparse
import base64
import sys
from pathlib import Path

import requests

from . import persona
from .config import settings
from .schemas import Format, WeekPlan

API = "https://api.elevenlabs.io/v1"
TTS_MODEL = "eleven_v3"                       # Hebrew + inline audio tags ([laughs], [whispers]...)
DESIGN_MODEL = "eleven_multilingual_ttv_v2"   # text-to-voice design

# Tuned for an energetic-but-consistent creator read. v3 stability: lower = more expressive.
VOICE_SETTINGS = {
    "stability": 0.45,          # "natural" band; 0.0 creative / 1.0 robust
    "similarity_boost": 0.8,
    "style": 0.35,
    "use_speaker_boost": True,
    "speed": 1.08,              # Tel Aviv pacing, slightly faster than default
}

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


def synthesize(text: str, out_path: Path, voice_id: str | None = None, seed: int = 4242) -> Path:
    voice_id = voice_id or settings().elevenlabs_voice_id
    if not voice_id:
        sys.exit("ELEVENLABS_VOICE_ID is not set - run `python -m zozobra.voice design` first")
    r = requests.post(
        f"{API}/text-to-speech/{voice_id}",
        params={"output_format": "mp3_44100_128"},
        headers=_headers(),
        timeout=180,
        json={
            "text": text,
            "model_id": TTS_MODEL,
            "language_code": "he",
            "voice_settings": VOICE_SETTINGS,
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
