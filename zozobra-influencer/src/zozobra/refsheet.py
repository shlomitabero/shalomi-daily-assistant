"""MODULE 1 executable: build LILO's training dataset from the master prompts (docs/02).

    python -m zozobra.refsheet anchor            # 8 candidates for R0 -> pick one
    python -m zozobra.refsheet pick data/refs/candidates/R0/1000_3.png
    python -m zozobra.refsheet sheet             # 30 identity-locked images + captions, from R0
    python -m zozobra.fal_provider train data/refs/dataset     # -> LILO_LORA_URL
"""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from . import persona
from .config import settings

IDENTITY = f"{persona.FACE_TOKENS}, {persona.HAIR_TOKENS}, {persona.BODY_TOKENS}"
REALISM = ("shot on Sony A7R V, 85mm f/1.8, natural skin texture with visible pores and fine vellus hair, "
           "subtle under-eye texture, no retouching, true-to-life color, soft film grain")
STUDIO = "seamless mid-grey studio background, large soft key light from front-left, gentle fill"
OUTFIT = persona.SIGNATURE_LOOK
WORLD = persona.WORLD_TOKENS

ANCHOR_PROMPT = (f"Studio headshot, front-facing, eye level, {IDENTITY}, neutral relaxed expression with a hint "
                 f"of a smile, plain black ribbed tank top, {STUDIO}, faint rim light separating the hair, {REALISM}")

# id -> (prompt, caption for LoRA training: trigger + what CHANGES, never the locked traits)
SHEET: dict[str, tuple[str, str]] = {
    "R1": (f"Studio portrait, head turned 45 degrees to her left, eyes to camera, {IDENTITY}, calm confident expression, black ribbed tank, {STUDIO}, {REALISM}",
           "three-quarter view facing left, black tank top, grey studio background"),
    "R2": (f"Studio portrait, head turned 45 degrees to her right, eyes to camera, {IDENTITY}, calm confident expression, black ribbed tank, {STUDIO}, {REALISM}",
           "three-quarter view facing right, black tank top, grey studio background"),
    "R3": (f"Clean side profile portrait facing left, {IDENTITY}, ponytail visible behind, {STUDIO}, {REALISM}",
           "side profile facing left, grey studio background"),
    "R4": (f"Clean side profile portrait facing right, {IDENTITY}, ponytail visible behind, {STUDIO}, {REALISM}",
           "side profile facing right, grey studio background"),
    "R5": (f"Full-body fashion photo, standing facing camera, weight on one leg, {IDENTITY}, wearing {OUTFIT}, black leather boots, {STUDIO}, head-to-toe in frame, 50mm, {REALISM}",
           "full body, standing, signature outfit, grey studio background"),
    "R6": (f"Full-body photo, side view walking left, {IDENTITY}, wearing {OUTFIT}, {STUDIO}, {REALISM}",
           "full body, walking, side view, signature outfit"),
    "R7": (f"Full-body photo, back three-quarter view looking over her shoulder, {IDENTITY}, wearing {OUTFIT}, {STUDIO}, {REALISM}",
           "full body, looking over shoulder, signature outfit"),
    "R8": (f"Close-up portrait, {IDENTITY}, genuine open-mouth laugh, eyes crinkled, head tilted back slightly, black ribbed tank, dark charcoal background, {REALISM}",
           "laughing, close-up, dark background"),
    "R9": (f"Close-up portrait, {IDENTITY}, spicy reaction, eyes watering, mouth in an O, fanning her face with one hand, dark charcoal background, {REALISM}",
           "spicy reaction fanning face, close-up"),
    "R10": (f"Close-up portrait, {IDENTITY}, eyes closed savoring a bite, slow satisfied smile, dark charcoal background, {REALISM}",
            "eyes closed savoring, close-up"),
    "R11": (f"Close-up portrait, {IDENTITY}, playful smirk with one raised eyebrow, looking into the lens, dark charcoal background, {REALISM}",
            "smirk raised eyebrow, close-up"),
    "R12": (f"Close-up portrait, {IDENTITY}, surprised wide eyes, eyebrows up, lips parted, dark charcoal background, {REALISM}",
            "surprised expression, close-up"),
    "R13": (f"Close-up portrait, {IDENTITY}, talking mid-sentence, mouth open on a vowel, animated hand gesture near her face, dark charcoal background, {REALISM}",
            "talking mid-sentence, hand gesture, close-up"),
    "R14": (f"Medium close-up, {IDENTITY}, holding wooden chopsticks correctly, lifting a strand of noodles toward her mouth, slim copper ring on right index finger, anatomically correct hand, dark moody background with warm copper light, {REALISM}",
            "holding chopsticks lifting noodles, medium close-up, copper light"),
    "R15": (f"Medium close-up, {IDENTITY}, holding a coupe cocktail glass by the stem, smiling over the rim, anatomically correct hand, dark moody background with warm copper light, {REALISM}",
            "holding cocktail glass, smiling, medium close-up"),
    "R16": (f"Medium shot, {IDENTITY}, wearing {OUTFIT}, tossing a carbon-steel wok with one hand, small flame at the lip of the wok, anatomically correct hands, {WORLD}, {REALISM}",
            "tossing a wok with flame, signature outfit, dark kitchen"),
    "R17": (f"Medium close-up, {IDENTITY}, pointing at the camera with chopsticks, mid-laugh, dark moody background with warm copper light, {REALISM}",
            "pointing chopsticks at camera, laughing"),
    "R18": (f"{IDENTITY}, wearing {OUTFIT}, sitting at a black marble counter slurping spicy noodles, chili oil droplets, {WORLD}, 35mm, {REALISM}",
            "sitting at a bar eating noodles, signature outfit, dark noodle bar"),
    "R19": (f"{IDENTITY}, wearing {OUTFIT}, standing beside the wok station, a giant flame burst behind her lighting her face orange, laughing, {WORLD}, {REALISM}",
            "standing by wok flames, laughing, signature outfit"),
    "R20": (f"{IDENTITY}, black satin slip dress and black leather jacket, leaning on the bar holding a smoked cocktail, red neon rim light, {WORLD}, 50mm, {REALISM}",
            "black slip dress and leather jacket, holding cocktail at bar, red neon"),
    "R21": (f"{IDENTITY}, wearing {OUTFIT}, eating golden curry with a spoon, steam curling, candid moment, {WORLD}, {REALISM}",
            "eating curry with spoon, candid, signature outfit"),
    "R22": (f"{IDENTITY}, oversized black hoodie with copper embroidery, walking on a Tel Aviv street at night, shop lights bokeh, 35mm, {REALISM}",
            "black hoodie, walking on city street at night"),
    "R23": (f"{IDENTITY}, oversized black hoodie with copper embroidery, sitting on a bench at night eating from a takeaway box with chopsticks, street lights, {REALISM}",
            "black hoodie, eating takeaway on a bench at night"),
    "R24": (f"{IDENTITY}, white linen shirt, daylight at a Tel Aviv seaside promenade, laughing, natural sunlight, 50mm, {REALISM}",
            "white linen shirt, daylight, seaside promenade, laughing"),
    "R25": (f"{IDENTITY}, white t-shirt, daylight market stall, holding a lime, soft natural light, {REALISM}",
            "white t-shirt, daylight market, holding a lime"),
    "R26": (f"Half-body portrait, {IDENTITY}, wearing {OUTFIT}, arms crossed, confident smile, {STUDIO}, {REALISM}",
            "half body, arms crossed, signature outfit, grey studio background"),
    "R27": (f"Half-body portrait, {IDENTITY}, black satin slip dress, soft smile looking away from camera, warm amber light, dark background, {REALISM}",
            "black slip dress, looking away, warm amber light"),
    "R28": (f"Overhead three-quarter angle, {IDENTITY}, wearing {OUTFIT}, looking up at camera from a bar stool, copper pendant lights, {WORLD}, {REALISM}",
            "high angle, looking up from bar stool, signature outfit"),
    "R29": (f"Low angle medium shot, {IDENTITY}, wearing {OUTFIT}, laughing with head thrown back, steam around her, {WORLD}, {REALISM}",
            "low angle, laughing, steam, signature outfit"),
}

REFERENCE_PROMPTS = {"R0": ANCHOR_PROMPT}


def _refs() -> Path:
    return settings().data_dir / "refs"


def anchor_candidates(n: int = 8) -> list[Path]:
    from .fal_provider import generate_image

    return generate_image(ANCHOR_PROMPT, 1000, _refs() / "candidates" / "R0", width=1024, height=1024,
                          num_images=min(n, 4), use_lora=False) + \
        (generate_image(ANCHOR_PROMPT, 2000, _refs() / "candidates" / "R0", width=1024, height=1024,
                        num_images=n - 4, use_lora=False) if n > 4 else [])


def pick_anchor(path: Path) -> Path:
    dest = _refs() / "R0_anchor.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(path, dest)
    return dest


def build_sheet(seed: int = 7) -> Path:
    """Every SHEET prompt rendered with the R0 face (PuLID), saved with its training caption."""
    import fal_client

    from .fal_provider import _download, upload

    anchor = _refs() / "R0_anchor.png"
    if not anchor.exists():
        raise FileNotFoundError("pick an anchor first: python -m zozobra.refsheet pick <image>")
    ref_url = upload(anchor)
    out = _refs() / "dataset"
    out.mkdir(parents=True, exist_ok=True)
    shutil.copy(anchor, out / "R0.png")
    (out / "R0.txt").write_text(f"{persona.TRIGGER} woman, front-facing portrait, neutral expression, black tank top, grey studio background", encoding="utf-8")
    for ref_id, (prompt, caption) in SHEET.items():
        portrait = any(k in prompt for k in ("Close-up", "Studio portrait", "profile"))
        res = fal_client.subscribe("fal-ai/flux-pulid", arguments={
            "prompt": prompt, "reference_image_url": ref_url,
            "image_size": {"width": 1024, "height": 1024} if portrait else {"width": 832, "height": 1216},
            "num_inference_steps": 24, "guidance_scale": 4, "seed": seed,
            "id_weight": 1.0, "start_step": 0, "true_cfg": 1,
        })
        _download(res["images"][0]["url"], out / f"{ref_id}.png")
        (out / f"{ref_id}.txt").write_text(f"{persona.TRIGGER} woman, {caption}", encoding="utf-8")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("anchor"); a.add_argument("-n", type=int, default=8)
    p = sub.add_parser("pick"); p.add_argument("image", type=Path)
    sub.add_parser("sheet")
    args = ap.parse_args()
    if args.cmd == "anchor":
        for c in anchor_candidates(args.n):
            print(c)
    elif args.cmd == "pick":
        print(pick_anchor(args.image))
    else:
        print(f"dataset ready: {build_sheet()}  -> curate (docs/03), then: python -m zozobra.fal_provider train {_refs() / 'dataset'}")


if __name__ == "__main__":
    main()
