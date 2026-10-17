"""MODULE 1 runtime - drive the identity-locked ComfyUI workflow over its HTTP API.

The workflow (comfyui/lilo_flux_pulid_lora_api.json) is exported in ComfyUI "API format".
We patch only the prompt / seed / size nodes by their titles, queue it, and download outputs.
"""
from __future__ import annotations

import copy
import json
import time
import uuid
from pathlib import Path

import requests

from . import persona
from .config import ROOT, settings

WORKFLOW_PATH = ROOT / "comfyui" / "lilo_flux_pulid_lora_api.json"


def load_workflow(path: Path = WORKFLOW_PATH) -> dict:
    wf = json.loads(path.read_text(encoding="utf-8"))
    return {k: v for k, v in wf.items() if not k.startswith("_")}


def _node(wf: dict, title: str) -> dict:
    for node in wf.values():
        if node.get("_meta", {}).get("title") == title:
            return node
    raise KeyError(f"workflow has no node titled '{title}'")


def build_workflow(prompt: str, seed: int, *, width: int = 1080, height: int = 1920,
                   lora: str | None = None, face_ref: str | None = None,
                   init_image: str | None = None, denoise: float = 1.0) -> dict:
    s = settings()
    wf = copy.deepcopy(load_workflow())
    _node(wf, "POSITIVE")["inputs"]["text"] = prompt
    _node(wf, "NEGATIVE")["inputs"]["text"] = persona.NEGATIVE
    _node(wf, "SEED")["inputs"]["seed"] = seed
    latent = _node(wf, "LATENT")["inputs"]
    latent["width"], latent["height"] = width, height
    _node(wf, "LILO_LORA")["inputs"]["lora_name"] = lora or s.lora_name
    _node(wf, "FACE_REF")["inputs"]["image"] = face_ref or s.face_ref
    if init_image:  # img2img: start from a real venue plate instead of empty latent
        wf["100"] = {"class_type": "LoadImage", "inputs": {"image": init_image}, "_meta": {"title": "INIT_IMAGE"}}
        wf["101"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["100", 0], "vae": ["3", 0]},
                     "_meta": {"title": "INIT_LATENT"}}
        sampler = _node(wf, "SEED")["inputs"]
        sampler["latent_image"], sampler["denoise"] = ["101", 0], denoise
    return wf


def upload_input(path: Path) -> str:
    """Copy a local image into ComfyUI's input folder; returns the name to reference."""
    base = settings().comfyui_url.rstrip("/")
    with path.open("rb") as f:
        r = requests.post(f"{base}/upload/image", files={"image": (path.name, f, "image/jpeg")},
                          data={"overwrite": "true"}, timeout=60)
    r.raise_for_status()
    return r.json()["name"]


def generate(prompt: str, seed: int, out_dir: Path, **kw) -> list[Path]:
    base = settings().comfyui_url.rstrip("/")
    client_id = str(uuid.uuid4())
    r = requests.post(f"{base}/prompt", json={"prompt": build_workflow(prompt, seed, **kw),
                                              "client_id": client_id}, timeout=30)
    r.raise_for_status()
    prompt_id = r.json()["prompt_id"]

    deadline = time.time() + 600
    while time.time() < deadline:
        hist = requests.get(f"{base}/history/{prompt_id}", timeout=30).json()
        if prompt_id in hist:
            break
        time.sleep(2)
    else:
        raise TimeoutError(f"ComfyUI job {prompt_id} did not finish in 10 minutes")

    out_dir.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []
    for node_out in hist[prompt_id]["outputs"].values():
        for img in node_out.get("images", []):
            data = requests.get(f"{base}/view", params={"filename": img["filename"],
                                "subfolder": img["subfolder"], "type": img["type"]}, timeout=60)
            data.raise_for_status()
            path = out_dir / img["filename"]
            path.write_bytes(data.content)
            saved.append(path)
    return saved
