"""Hosted alternative to the self-run ComfyUI/Runway/Sync stack: one FAL_KEY, no GPU.

  images   fal-ai/flux-lora               (Flux.1-dev + LILO's LoRA = identity lock)
  training fal-ai/flux-lora-fast-training (train the LoRA from a zip of the curated dataset)
  video    fal-ai/kling-video/.../image-to-video (strong food + hand physics)
  lipsync  fal-ai/sync-lipsync/v2
  talk     2026 video models that render picture + Hebrew speech + lip-sync in one pass
           (Veo 3.1 / Sora 2 Pro / Seedance 2.0) - replaces TTS + lipsync when selected
  storage  fal CDN (public HTTPS URLs for intermediate files)

Model ids are constants so they can be bumped when fal publishes newer versions.
"""
from __future__ import annotations

import zipfile
from pathlib import Path

import requests

from . import persona
from .config import settings

IMAGE_APP = "fal-ai/flux-lora"
IMG2IMG_APP = "fal-ai/flux-lora/image-to-image"
TRAIN_APP = "fal-ai/flux-lora-fast-training"
VIDEO_APP = "fal-ai/kling-video/v2.1/master/image-to-video"
LIPSYNC_APP = "fal-ai/sync-lipsync/v2"


def _fal():
    import fal_client

    if not settings().fal_key:
        raise RuntimeError("FAL_KEY is not set")
    return fal_client


def upload(path: Path) -> str:
    """Public URL for a local file. Prefer our own server (/pub/<token>/...) so no storage account
    is needed; fall back to fal's CDN when the panel isn't publicly reachable."""
    s = settings()
    try:
        rel = Path(path).resolve().relative_to(s.data_dir.resolve())
    except ValueError:
        rel = None
    if s.public_base_url and s.media_token and rel is not None:
        return f"{s.public_base_url}/pub/{s.media_token}/{rel.as_posix()}"
    return _fal().upload_file(path)


def _download(url: str, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    r = requests.get(url, timeout=300)
    r.raise_for_status()
    path.write_bytes(r.content)
    return path


def generate_image(prompt: str, seed: int, out_dir: Path, *, width: int = 1080, height: int = 1920,
                   num_images: int = 1, use_lora: bool = True) -> list[Path]:
    s = settings()
    args = {
        "prompt": prompt,
        "image_size": {"width": width, "height": height},
        "num_inference_steps": 28,
        "guidance_scale": 3.2,
        "num_images": num_images,
        "seed": seed,
        "output_format": "png",
        "enable_safety_checker": True,
    }
    if use_lora:
        if not s.lora_url:
            raise RuntimeError("LILO_LORA_URL is not set - train the LoRA first (python -m zozobra.fal_provider train)")
        args["loras"] = [{"path": s.lora_url, "scale": 0.9}]
    result = _fal().subscribe(IMAGE_APP, arguments=args)
    return [_download(img["url"], out_dir / f"{seed}_{i}.png") for i, img in enumerate(result["images"])]


def place_in_plate(prompt: str, plate: Path, seed: int, out_dir: Path, *, strength: float = 0.55,
                   num_images: int = 1) -> list[Path]:
    """LILO (LoRA) painted into a real ZOZOBRA interior plate. strength ~0.55-0.7: low keeps the room
    exact, high gives her more room to appear naturally (re-roll if the room changes too much)."""
    s = settings()
    if not s.lora_url:
        raise RuntimeError("LILO_LORA_URL is not set - train the LoRA first")
    result = _fal().subscribe(IMG2IMG_APP, arguments={
        "image_url": upload(plate),
        "prompt": prompt,
        "strength": strength,
        "num_inference_steps": 32,
        "guidance_scale": 3.2,
        "num_images": num_images,
        "seed": seed,
        "loras": [{"path": s.lora_url, "scale": 0.95}],
        "output_format": "png",
    })
    return [_download(img["url"], out_dir / f"venue_{seed}_{i}.png") for i, img in enumerate(result["images"])]


def animate(image_url: str, prompt: str, duration: int = 10, no_fire: bool = False) -> str:
    negative = "face morphing, identity change, extra fingers, blur, distortion, low quality"
    if no_fire:
        negative += ", fire, flames, sparks, burning"
    negative += ", red lanterns, paper lanterns, chinese lanterns, red lamps, extra lamps, new decorations"
    result = _fal().subscribe(VIDEO_APP, arguments={
        "image_url": image_url,
        "prompt": prompt[:2500],
        "duration": "10" if duration > 5 else "5",
        "negative_prompt": negative,
        "cfg_scale": 0.5,
    })
    return result["video"]["url"]


# engine -> (fal app, max seconds per clip, extra arguments)
TALK_ENGINES = {
    "veo": ("fal-ai/veo3.1/image-to-video", 8,
            {"aspect_ratio": "9:16", "resolution": "1080p", "generate_audio": True, "duration": "8s"}),
    "sora": ("fal-ai/sora-2/image-to-video/pro", 12, {"aspect_ratio": "9:16", "resolution": "1080p", "duration": 12}),
    "seedance": ("bytedance/seedance-2.0/image-to-video", 10,
                 {"aspect_ratio": "9:16", "resolution": "1080p", "generate_audio": True, "duration": "10"}),
}
TALK_LABELS_HE = {"veo": "Google Veo 3.1", "sora": "OpenAI Sora 2 Pro", "seedance": "ByteDance Seedance 2.0"}


def talk_prompt(scene: str, action: str, spoken_he: str, no_fire: bool = True) -> str:
    """One prompt that asks the model to act AND speak the Hebrew line itself."""
    parts = [
        f"Vertical 9:16 cinematic social video. The woman in the image keeps exactly the same face, hair and outfit. "
        f"Setting: {scene}. {action}. Her outfit is elegant and modest, fully covered.",
        f'She speaks directly to camera in natural, fluent native Israeli Hebrew with a natural native Israeli accent, '
        f'warm and playful, conversational pace, perfect lip-sync. She says, in Hebrew: "{spoken_he}"',
        "Audio: only her voice and soft real restaurant ambience. No music, no narrator, no other voices.",
        "No subtitles, no captions, no on-screen text, no logos. Keep the room exactly as in the image: "
        "no new lamps, lanterns or decorations.",
    ]
    if no_fire:
        parts.append("No fire, flames or sparks anywhere.")
    return " ".join(parts)


def talk(engine: str, image_url: str, prompt: str) -> str:
    """Speaking clip from a still. Falls back to the minimal schema if a model rejects an option."""
    app, _, extra = TALK_ENGINES[engine]
    base = {"image_url": image_url, "prompt": prompt[:4800]}
    try:
        result = _fal().subscribe(app, arguments={**base, **extra})
    except Exception as ex:
        print(f"[talk] {engine} rejected options ({ex}); retrying with defaults", flush=True)
        keep = {k: v for k, v in extra.items() if k == "generate_audio"}
        result = _fal().subscribe(app, arguments={**base, **keep})
    return result["video"]["url"]


def lipsync(video_url: str, audio_url: str) -> str:
    result = _fal().subscribe(LIPSYNC_APP, arguments={
        "video_url": video_url, "audio_url": audio_url, "sync_mode": "loop"})
    return result["video"]["url"]


def train_lora(dataset_dir: Path, steps: int = 2000) -> str:
    """Zip the curated dataset (images + .txt captions), train on fal, return the LoRA URL."""
    files = sorted(p for p in dataset_dir.iterdir() if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".txt"})
    if sum(p.suffix != ".txt" for p in files) < 15:
        raise ValueError("need at least 15 curated images (30 recommended) - see docs/03")
    archive = dataset_dir.parent / f"{dataset_dir.name}.zip"
    with zipfile.ZipFile(archive, "w") as z:
        for p in files:
            z.write(p, p.name)
    result = _fal().subscribe(TRAIN_APP, arguments={
        "images_data_url": upload(archive),
        "trigger_word": persona.TRIGGER,
        "steps": steps,
        "create_masks": True,
        "is_style": False,
    }, with_logs=True)
    return result["diffusers_lora_file"]["url"]


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Train LILO's LoRA on fal.ai")
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train"); t.add_argument("dataset", type=Path); t.add_argument("--steps", type=int, default=2000)
    args = ap.parse_args()
    print("LILO_LORA_URL=" + train_lora(args.dataset, args.steps))
