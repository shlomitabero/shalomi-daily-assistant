"""Place a green-screen LILO render INTO a real ZOZOBRA interior render (no invented decor).

    python scripts/composite_lilo.py lilo_green.png <plate_id> out.jpg [--scale 0.9] [--x 0.5] [--night]

The background is the restaurant's own design render (assets/venue), so lamps, ribbons, screens and
walls are exactly the real design. LILO is keyed, despilled, colour-matched to the plate and grounded
with a soft shadow; the background gets a light depth-of-field blur so she reads as in-camera.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from zozobra import venue  # noqa: E402

W, H = 1080, 1920


def key_green(img: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    a = np.asarray(img.convert("RGB")).astype(np.float32) / 255
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    greenness = g - np.maximum(r, b)                     # >0 on screen, ~<=0 on subject
    alpha = 1 - np.clip((greenness - 0.08) / 0.22, 0, 1)
    # despill: clamp green to the max of red/blue where it leaks onto hair / skin edges
    g2 = np.minimum(g, np.maximum(r, b) * 1.02)
    rgb = np.stack([r, g2, b], -1)
    alpha_img = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.2))
    return rgb, np.asarray(alpha_img).astype(np.float32) / 255


def match_colour(fg: np.ndarray, alpha: np.ndarray, bg: np.ndarray, strength: float = 0.55) -> np.ndarray:
    m = alpha > 0.9
    out = fg.copy()
    for c in range(3):
        fmu, fsd = fg[..., c][m].mean(), fg[..., c][m].std() + 1e-6
        bmu, bsd = bg[..., c].mean(), bg[..., c].std() + 1e-6
        shifted = (fg[..., c] - fmu) / fsd * (fsd * (1 - strength) + bsd * strength) + (fmu * (1 - strength) + bmu * 1.15 * strength)
        out[..., c] = np.clip(shifted, 0, 1)
    return out


def composite(lilo: Path, plate_id: str, out: Path, scale: float = 0.92, x: float = 0.5, night: bool = True,
              blur: float = 2.2) -> Path:
    bg_img = Image.open(venue.plate_9x16(plate_id, out_dir=out.parent / "plates", night=night)).convert("RGB").resize((W, H))
    bg_img = bg_img.filter(ImageFilter.GaussianBlur(blur))
    bg = np.asarray(bg_img).astype(np.float32) / 255

    fg_img = Image.open(lilo).convert("RGB")
    fh = int(H * scale); fw = int(fg_img.width * fh / fg_img.height)
    fg_img = fg_img.resize((fw, fh), Image.LANCZOS)
    rgb, alpha = key_green(fg_img)
    rgb = match_colour(rgb, alpha, bg)

    canvas_rgb = np.zeros((H, W, 3), np.float32); canvas_a = np.zeros((H, W), np.float32)
    left = int(x * W - fw / 2); top = H - fh
    sx0, sx1 = max(0, -left), min(fw, W - left)
    dx0, dx1 = max(0, left), min(W, left + fw)
    canvas_rgb[top:H, dx0:dx1] = rgb[:, sx0:sx1]
    canvas_a[top:H, dx0:dx1] = alpha[:, sx0:sx1]

    # soft contact shadow on the background behind her
    shadow = Image.fromarray((canvas_a * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(28))
    sh = np.asarray(shadow).astype(np.float32)[..., None] / 255
    bg = bg * (1 - 0.35 * sh)

    a = canvas_a[..., None]
    comp = canvas_rgb * a + bg * (1 - a)
    # unify with a light grain + warm grade so both layers share one "camera"
    rng = np.random.default_rng(7)
    comp = np.clip(comp + rng.normal(0, 0.012, comp.shape), 0, 1)
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray((comp * 255).astype(np.uint8)).save(out, quality=93)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("lilo", type=Path); ap.add_argument("plate"); ap.add_argument("out", type=Path)
    ap.add_argument("--scale", type=float, default=0.92); ap.add_argument("--x", type=float, default=0.5)
    ap.add_argument("--day", action="store_true", help="use the daytime plate instead of the night variant")
    a = ap.parse_args()
    print(composite(a.lilo, a.plate, a.out, a.scale, a.x, night=not a.day))
