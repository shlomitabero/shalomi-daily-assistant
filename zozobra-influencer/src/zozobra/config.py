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


def _runtime_path() -> Path:
    return Path(os.getenv("DATA_DIR", str(DATA_DIR))) / "runtime.json"


def runtime() -> dict:
    """Values the control panel saves (LoRA URL, voice id, weekly focus...). Env vars win."""
    import json

    try:
        return json.loads(_runtime_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {}


def save_runtime(**values) -> None:
    import json

    data = runtime() | values
    _runtime_path().parent.mkdir(parents=True, exist_ok=True)
    _runtime_path().write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _env_or_runtime(name: str, key: str) -> str:
    return os.getenv(name) or runtime().get(key, "")


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    model: str = field(default_factory=lambda: os.getenv("ZOZOBRA_MODEL", "claude-opus-5-5"))
    # "fal" = hosted (one FAL_KEY, no GPU). "self" = your ComfyUI + Runway + Sync + S3.
    provider: str = field(default_factory=lambda: os.getenv("MEDIA_PROVIDER", "fal"))
    fal_key: str = field(default_factory=lambda: os.getenv("FAL_KEY", ""))
    lora_url: str = field(default_factory=lambda: _env_or_runtime("LILO_LORA_URL", "lora_url"))
    comfyui_url: str = field(default_factory=lambda: os.getenv("COMFYUI_URL", "http://127.0.0.1:8188"))
    lora_name: str = field(default_factory=lambda: os.getenv("LILO_LORA_NAME", "lilo_flux_v1.safetensors"))
    face_ref: str = field(default_factory=lambda: os.getenv("LILO_FACE_REF", "lilo_face_ref_front.png"))

    runway_api_key: str = field(default_factory=lambda: os.getenv("RUNWAY_API_KEY", ""))
    sync_api_key: str = field(default_factory=lambda: os.getenv("SYNC_API_KEY", ""))
    elevenlabs_api_key: str = field(default_factory=lambda: os.getenv("ELEVENLABS_API_KEY", ""))
    elevenlabs_voice_id: str = field(default_factory=lambda: _env_or_runtime("ELEVENLABS_VOICE_ID", "voice_id"))

    media_bucket: str = field(default_factory=lambda: os.getenv("MEDIA_BUCKET", ""))
    media_public_base_url: str = field(default_factory=lambda: os.getenv("MEDIA_PUBLIC_BASE_URL", ""))
    s3_endpoint_url: str = field(default_factory=lambda: os.getenv("S3_ENDPOINT_URL", ""))

    ig_user_id: str = field(default_factory=lambda: os.getenv("IG_USER_ID", ""))
    ig_access_token: str = field(default_factory=lambda: os.getenv("IG_ACCESS_TOKEN", ""))
    graph_version: str = field(default_factory=lambda: os.getenv("META_GRAPH_VERSION", "v23.0"))
    tiktok_access_token: str = field(default_factory=lambda: os.getenv("TIKTOK_ACCESS_TOKEN", ""))

    require_human_approval: bool = field(default_factory=lambda: _bool("REQUIRE_HUMAN_APPROVAL", True))
    dry_run: bool = field(default_factory=lambda: _bool("DRY_RUN", True))

    account_created: str = field(default_factory=lambda: os.getenv("ACCOUNT_CREATED", "2026-10-01"))
    panel_password: str = field(default_factory=lambda: os.getenv("PANEL_PASSWORD", ""))
    # Public, token-protected file URLs served by the panel itself (/pub/<token>/...), so the media
    # APIs can fetch inputs without a third-party storage bucket.
    public_base_url: str = field(default_factory=lambda: os.getenv("PUBLIC_BASE_URL", "").rstrip("/"))
    media_token: str = field(default_factory=lambda: os.getenv("MEDIA_TOKEN", ""))

    data_dir: Path = field(default_factory=lambda: Path(os.getenv("DATA_DIR", str(DATA_DIR))))


def settings() -> Settings:
    return Settings()
