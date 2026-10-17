"""ZOZOBRA's real interior (design renders in assets/venue) as the ground truth for every scene.

- `catalog()`        plates + signature elements, fed to the Brain so it picks a real zone per post
- `plate_9x16()`     a 1080x1920 crop of a plate (focus_x keeps the interesting part in frame)
- `is_food_shot()`   food cutaways are generated; venue cutaways animate the real plate instead
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from .config import ROOT, settings

VENUE_DIR = ROOT / "assets" / "venue"
W, H = 1080, 1920
FOOD_WORDS = ("noodle", "dish", "bowl", "curry", "ramen", "wok", "sauce", "peanut", "roll", "chopstick",
              "spoon", "plate", "food", "pad thai", "beef", "broth", "lime", "cocktail", "glass", "bite")


@lru_cache(maxsize=1)
def catalog() -> dict:
    return json.loads((VENUE_DIR / "venue.json").read_text(encoding="utf-8"))


def plate_ids() -> set[str]:
    return {p["id"] for p in catalog()["plates"]}


def plate(plate_id: str) -> dict:
    for p in catalog()["plates"]:
        if p["id"] == plate_id:
            return p
    raise KeyError(f"unknown venue plate '{plate_id}'")


def plate_path(plate_id: str, night: bool = False) -> Path:
    p = plate(plate_id)
    return VENUE_DIR / (p.get("night_variant") if night and p.get("night_variant") else p["file"])


def plate_9x16(plate_id: str, out_dir: Path | None = None, night: bool = False) -> Path:
    """Crop to 9:16 around focus_x, upscale to 1080x1920. Cached on disk."""
    from PIL import Image

    out_dir = out_dir or settings().data_dir / "venue_cache"
    out = out_dir / f"{plate_id}{'_night' if night else ''}_9x16.jpg"
    if out.exists():
        return out
    img = Image.open(plate_path(plate_id, night)).convert("RGB")
    w, h = img.size
    target = W / H
    if w / h > target:      # too wide: crop width around focus_x
        cw = int(h * target)
        cx = int(plate(plate_id).get("focus_x", 0.5) * w)
        left = min(max(0, cx - cw // 2), w - cw)
        img = img.crop((left, 0, left + cw, h))
    else:                   # too tall: crop height around the centre
        ch = int(w / target)
        top = (h - ch) // 2
        img = img.crop((0, top, w, top + ch))
    out.parent.mkdir(parents=True, exist_ok=True)
    img.resize((W, H), Image.LANCZOS).save(out, quality=93)
    return out


def is_food_shot(shot: str) -> bool:
    s = shot.lower()
    return any(k in s for k in FOOD_WORDS)


def brain_brief() -> str:
    """Compact venue description for the Brain's system prompt (stable -> cache-friendly)."""
    c = catalog()
    lines = [f"Stage: {c['stage']}", "Signature elements: " + "; ".join(c["signature_elements"]), "Plates:"]
    for p in c["plates"]:
        lines.append(f"- {p['id']} ({p['orientation']}, {p['zone_he']}): {p['description']}. "
                     f"LILO can be: {p['lilo_spots']}. Good for: {', '.join(p['best_for'])}.")
    return "\n".join(lines)
