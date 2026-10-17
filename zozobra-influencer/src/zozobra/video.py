"""MODULE 2.1 - still -> motion -> lip-sync -> final 9:16 reel.

Stage 1  Runway image-to-video animates the identity-locked still (face stays because the
         first frame IS the LoRA/PuLID render; keep motion prompts face-stable).
Stage 2  Sync (lipsync-2) re-drives the mouth on talking shots with the ElevenLabs audio.
         B-roll shots (food macros, flames) skip this stage.
Stage 3  ffmpeg lays B-roll cutaways over the lip-synced A-roll at the script's timestamps and
         normalises loudness to -14 LUFS (Reels/TikTok target).

API shapes follow the vendors' public docs at time of writing - check RUNWAY_VERSION and the
Sync model name against current docs before production.
"""
from __future__ import annotations

import subprocess
import time
from pathlib import Path

import requests

from .config import settings

RUNWAY_API = "https://api.dev.runwayml.com/v1"
RUNWAY_VERSION = "2024-11-06"
RUNWAY_MODEL = "gen4_turbo"
SYNC_API = "https://api.sync.so/v2"
SYNC_MODEL = "lipsync-2"

# Appended to every motion prompt: protects identity and food physics.
MOTION_GUARDRAILS = (
    "Face remains consistent and stable, natural blinking, no morphing, realistic hand-object "
    "contact, chopsticks grip correctly, noodles have weight and sag with gravity, liquid moves "
    "with real viscosity, steam drifts upward, handheld micro-shake, 24fps cinematic."
)


def _poll(url: str, headers: dict, done: set[str], failed: set[str], key: str = "status",
          timeout_s: int = 900) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        body = requests.get(url, headers=headers, timeout=30).json()
        if body.get(key) in done:
            return body
        if body.get(key) in failed:
            raise RuntimeError(f"job failed: {body}")
        time.sleep(5)
    raise TimeoutError(url)


def animate_still(image_url: str, motion_prompt: str, duration: int = 5) -> str:
    """Returns a URL to the generated clip."""
    h = {"Authorization": f"Bearer {settings().runway_api_key}", "X-Runway-Version": RUNWAY_VERSION}
    r = requests.post(f"{RUNWAY_API}/image_to_video", headers=h, timeout=60, json={
        "model": RUNWAY_MODEL,
        "promptImage": image_url,
        "promptText": f"{motion_prompt} {MOTION_GUARDRAILS}"[:1000],
        "ratio": "720:1280",
        "duration": duration,
    })
    r.raise_for_status()
    task = _poll(f"{RUNWAY_API}/tasks/{r.json()['id']}", h, {"SUCCEEDED"}, {"FAILED", "CANCELLED"})
    return task["output"][0]


def lipsync(video_url: str, audio_url: str) -> str:
    h = {"x-api-key": settings().sync_api_key, "Content-Type": "application/json"}
    r = requests.post(f"{SYNC_API}/generate", headers=h, timeout=60, json={
        "model": SYNC_MODEL,
        "input": [{"type": "video", "url": video_url}, {"type": "audio", "url": audio_url}],
        "options": {"sync_mode": "loop"},   # loop the 10s A-roll to cover the full voice track
    })
    r.raise_for_status()
    job = _poll(f"{SYNC_API}/generate/{r.json()['id']}", h, {"COMPLETED"}, {"FAILED", "REJECTED"})
    return job["outputUrl"]


def download(url: str, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with path.open("wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    return path


def is_broll(shot: str) -> bool:
    """Cutaways without LILO's face (food macros, flames) - voice keeps playing underneath."""
    s = shot.lower()
    return any(k in s for k in ("macro", "close-up of", "b-roll", "broll", "insert", "overhead dish", "flame"))


def compose(a_roll: Path, broll: list[tuple[Path, float, float]], out: Path,
            music: Path | None = None, subtitles: Path | None = None) -> Path:
    """A-roll = lip-synced LILO clip carrying the voice track. Each B-roll clip is laid over it
    for [start, end] seconds, so the mouth is hidden exactly while she isn't on screen."""
    out.parent.mkdir(parents=True, exist_ok=True)
    args = ["ffmpeg", "-y", "-i", str(a_roll)]
    for clip, _, _ in broll:
        args += ["-i", str(clip)]
    if music:
        args += ["-i", str(music)]

    norm = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p"
    graph = [f"[0:v]{norm}[base0]"]
    for i, (_, start, end) in enumerate(broll, start=1):
        graph.append(f"[{i}:v]{norm},setpts=PTS-STARTPTS+{start}/TB[b{i}]")
        graph.append(f"[base{i-1}][b{i}]overlay=enable='between(t,{start},{end})':eof_action=pass[base{i}]")
    if subtitles:
        from .subtitles import ffmpeg_filter

        graph.append(f"[base{len(broll)}]{ffmpeg_filter(subtitles)}[v]")
    else:
        graph.append(f"[base{len(broll)}]null[v]")
    if music:
        m = len(broll) + 1
        graph.append(f"[{m}:a]volume=0.18[m];[0:a][m]amix=inputs=2:duration=first,"
                     "loudnorm=I=-14:TP=-1.5:LRA=11[a]")
    else:
        graph.append("[0:a]loudnorm=I=-14:TP=-1.5:LRA=11[a]")

    subprocess.run([*args, "-filter_complex", ";".join(graph), "-map", "[v]", "-map", "[a]",
                    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-c:a", "aac", "-b:a", "192k",
                    "-shortest", "-movflags", "+faststart",
                    # IPTC "trainedAlgorithmicMedia" marker so platforms can read the AI provenance
                    "-metadata", "comment=AI-generated (trainedAlgorithmicMedia) - LILO virtual creator x ZOZOBRA",
                    str(out)], check=True, capture_output=True)
    return out
