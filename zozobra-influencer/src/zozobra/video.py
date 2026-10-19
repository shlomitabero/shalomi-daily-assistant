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

import json
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
    if "lilo" in s or "she " in s or "her " in s:   # she's on screen -> A-roll, never covered
        return False
    return any(k in s for k in ("macro", "close-up of", "b-roll", "broll", "insert", "overhead dish", "flame", "venue", "interior", "establishing"))


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


def probe(path: Path) -> tuple[float, bool]:
    """(duration seconds, has an audio stream)."""
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type",
                          "-of", "json", str(path)], check=True, capture_output=True, text=True).stdout
    info = json.loads(out)
    return float(info["format"]["duration"]), any(s.get("codec_type") == "audio" for s in info.get("streams", []))


def concat(clips: list[Path], out: Path, subtitles: Path | None = None) -> Path:
    """Talking clips (each carrying its own speech) back to back; silent clips get a silent track."""
    out.parent.mkdir(parents=True, exist_ok=True)
    norm = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p,setsar=1"
    args, graph, pairs = ["ffmpeg", "-y"], [], ""
    for i, clip in enumerate(clips):
        dur, has_audio = probe(clip)
        args += ["-i", str(clip)]
        graph.append(f"[{i}:v]{norm}[v{i}]")
        if has_audio:
            graph.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo[a{i}]")
        else:
            graph.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={dur:.3f}[a{i}]")
        pairs += f"[v{i}][a{i}]"
    graph.append(f"{pairs}concat=n={len(clips)}:v=1:a=1[vc][ac]")
    if subtitles:
        from .subtitles import ffmpeg_filter

        graph.append(f"[vc]{ffmpeg_filter(subtitles)}[v]")
    else:
        graph.append("[vc]null[v]")
    graph.append("[ac]loudnorm=I=-14:TP=-1.5:LRA=11[a]")
    subprocess.run([*args, "-filter_complex", ";".join(graph), "-map", "[v]", "-map", "[a]",
                    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart",
                    "-metadata", "comment=AI-generated (trainedAlgorithmicMedia) - LILO virtual creator x ZOZOBRA",
                    str(out)], check=True, capture_output=True)
    return out


def last_frame(clip: Path, out: Path) -> Path:
    """Final frame of a clip - the next talking clip starts from it, so there is no jump between clips."""
    subprocess.run(["ffmpeg", "-y", "-sseof", "-0.15", "-i", str(clip), "-frames:v", "1", "-q:v", "2", str(out)],
                   check=True, capture_output=True)
    return out


def trim_after_speech(clip: Path, tail: float = 0.35, min_keep: float = 1.5) -> Path:
    """Cut the silent tail after the last spoken word (where models drift or repeat lines)."""
    dur, has_audio = probe(clip)
    if not has_audio:
        return clip
    log = subprocess.run(["ffmpeg", "-i", str(clip), "-af", "silencedetect=noise=-32dB:d=0.35", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    starts = [float(x.split("silence_start:")[1].split()[0]) for x in log.splitlines() if "silence_start:" in x]
    ends = [float(x.split("silence_end:")[1].split()[0]) for x in log.splitlines() if "silence_end:" in x]
    # trailing silence = the last silence has no end, or (newer ffmpeg) ends at the end of the stream
    trailing = starts and (len(ends) < len(starts) or ends[-1] >= dur - 0.15)
    if not trailing:
        return clip
    cut = starts[-1] + tail
    if cut < min_keep or cut >= dur - 0.2:
        return clip
    out = clip.with_name(clip.stem + "_trim.mp4")
    subprocess.run(["ffmpeg", "-y", "-i", str(clip), "-t", f"{cut:.2f}", "-c:v", "libx264", "-preset", "fast",
                    "-crf", "18", "-c:a", "aac", str(out)], check=True, capture_output=True)
    return out
