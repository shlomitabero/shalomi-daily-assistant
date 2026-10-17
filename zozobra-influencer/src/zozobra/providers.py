"""One interface over the two media stacks, chosen by MEDIA_PROVIDER."""
from __future__ import annotations

from pathlib import Path

from .config import settings


def _fal() -> bool:
    return settings().provider == "fal"


def image(prompt: str, seed: int, out_dir: Path, *, use_lora: bool = True) -> list[Path]:
    if _fal():
        from .fal_provider import generate_image

        return generate_image(prompt, seed, out_dir, use_lora=use_lora)
    from .image_gen import generate

    return generate(prompt, seed, out_dir)


def upload(path: Path, key: str) -> str:
    if _fal():
        from .fal_provider import upload as fal_upload

        return fal_upload(path)
    from .storage import publish_file

    return publish_file(path, key)


def animate(image_url: str, prompt: str, duration: int) -> str:
    from .video import MOTION_GUARDRAILS

    if _fal():
        from .fal_provider import animate as fal_animate

        return fal_animate(image_url, f"{prompt} {MOTION_GUARDRAILS}", duration)
    from .video import animate_still

    return animate_still(image_url, prompt, duration)


def lipsync(video_url: str, audio_url: str) -> str:
    if _fal():
        from .fal_provider import lipsync as fal_lipsync

        return fal_lipsync(video_url, audio_url)
    from .video import lipsync as sync_lipsync

    return sync_lipsync(video_url, audio_url)
