"""Runtime settings, read once from the environment (.env supported)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # python-dotenv is optional
    pass

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    model: str = field(default_factory=lambda: os.getenv("ZOZOBRA_MODEL", "claude-opus-5-5"))
    comfyui_url: str = field(default_factory=lambda: os.getenv("COMFYUI_URL", "http://127.0.0.1:8188"))
    lora_name: str = field(default_factory=lambda: os.getenv("LILO_LORA_NAME", "lilo_flux_v1.safetensors"))
    face_ref: str = field(default_factory=lambda: os.getenv("LILO_FACE_REF", "lilo_face_ref_front.png"))

    runway_api_key: str = field(default_factory=lambda: os.getenv("RUNWAY_API_KEY", ""))
    sync_api_key: str = field(default_factory=lambda: os.getenv("SYNC_API_KEY", ""))
    elevenlabs_api_key: str = field(default_factory=lambda: os.getenv("ELEVENLABS_API_KEY", ""))
    elevenlabs_voice_id: str = field(default_factory=lambda: os.getenv("ELEVENLABS_VOICE_ID", ""))

    media_bucket: str = field(default_factory=lambda: os.getenv("MEDIA_BUCKET", ""))
    media_public_base_url: str = field(default_factory=lambda: os.getenv("MEDIA_PUBLIC_BASE_URL", ""))
    s3_endpoint_url: str = field(default_factory=lambda: os.getenv("S3_ENDPOINT_URL", ""))

    ig_user_id: str = field(default_factory=lambda: os.getenv("IG_USER_ID", ""))
    ig_access_token: str = field(default_factory=lambda: os.getenv("IG_ACCESS_TOKEN", ""))
    graph_version: str = field(default_factory=lambda: os.getenv("META_GRAPH_VERSION", "v23.0"))
    tiktok_access_token: str = field(default_factory=lambda: os.getenv("TIKTOK_ACCESS_TOKEN", ""))

    require_human_approval: bool = field(default_factory=lambda: _bool("REQUIRE_HUMAN_APPROVAL", True))
    dry_run: bool = field(default_factory=lambda: _bool("DRY_RUN", True))

    data_dir: Path = DATA_DIR


def settings() -> Settings:
    return Settings()
