# MODULE 1.3 — Consistency Workflow (Face & Body Lock)

Three layers, each covering the others' weak spots:

| Layer | Locks | Tool | Strength |
|---|---|---|---|
| 1. Identity LoRA | Face + body + signature outfit + "vibe" | Flux.1-dev LoRA (ostris ai-toolkit) | 0.85–0.95 |
| 2. Face adapter | Exact facial geometry per shot | PuLID-Flux (InsightFace + EVA-CLIP) | weight 0.75–0.85, start 0.1 |
| 3. Face repair | Small/distant faces, hands | FaceDetailer (Impact Pack) + PuLID, denoise 0.35 | only when face < 15% of frame |

LoRA alone drifts on unusual angles. PuLID alone keeps the face but loses the body and outfit.
Together they hold up across 50+ scenes.

---

## Step 1 — Build the dataset (30 images)

From the prompts in `02_master_image_prompts.md`:

| Bucket | Count | Notes |
|---|---|---|
| Close-up face (front, ¾ L/R, profiles) | 8 | 1024², sharp eyes, beauty mark visible |
| Expressions | 6 | R8–R13 |
| Half body | 6 | Hands with chopsticks/glass, natural grip |
| Full body | 5 | Signature + 2 alt outfits |
| In-world / outdoor | 5 | Varied light, incl. daylight, so the LoRA doesn't learn "always dark" |

**Curation pass (non-negotiable):**
1. Face-similarity filter: compute InsightFace `buffalo_l` embeddings, keep only images with cosine
   similarity ≥ 0.62 to R0. Drop the rest; drift in the dataset becomes drift in the LoRA.
2. Fix hands / earrings / pin with inpainting; delete anything with artifacts.
3. Upscale small faces (4x-UltraSharp), then downscale to ≤1536 on the long edge.

**Captions** (`image_017.txt`): trigger + *what changes*, never the locked traits, so they get
absorbed into the trigger:
```
l1l0zzb woman, laughing, holding chopsticks with ramen noodles, sitting at a dark bar,
warm copper light, medium shot
```
Don't write "freckles", "beauty mark", "ponytail" or "olive skin" in captions. Do write outfit
when it's an alt outfit, so the signature look stays the default.

## Step 2 — Train the LoRA

Config: `lora/lilo_flux_lora.yaml` (ai-toolkit). Key choices:

| Param | Value | Why |
|---|---|---|
| Base | FLUX.1-dev, quantized fp8 | Best realism / skin texture |
| Rank / alpha | 32 / 16 | Face + body + outfit without overbaking |
| LR | 1e-4, AdamW8bit, EMA 0.99 | Stable identity convergence |
| Steps | 3000, save every 250 | Pick by eye; usually 1750–2250 |
| Resolution | 512/768/1024 buckets | Generalises across framings |
| Text encoders | Frozen | Flux identity lives in the transformer |
| Caption dropout | 0.05 | Lets the trigger alone summon her |

Hardware: 24 GB VRAM (RTX 4090 / L40S / A6000): about an hour. Cloud: RunPod or Replicate's
`ostris/flux-dev-lora-trainer` with the same params (steps 2000, lr 1e-4, rank 32).

**Checkpoint selection:** render the 4 sample prompts × 4 seeds for each saved step. Score the face
similarity to R0 automatically (target ≥ 0.65 mean), then check by eye that the outfit doesn't
appear when the prompt asks for a different one (a sign of overfitting). Ship the earliest
checkpoint that passes.

## Step 3 — ComfyUI production graph

API-format file: `comfyui/lilo_flux_pulid_lora_api.json`, driven by `src/zozobra/image_gen.py`.

```
UNETLoader(flux1-dev fp8) ─► LoraLoader(lilo_flux_v1 @0.9) ─► ApplyPulidFlux(weight .8, start .1, end 1)
DualCLIPLoader(t5xxl + clip_l) ─┘            │                      ▲
                                             ▼                      │ LoadImage(lilo_face_ref_front.png)
                                  CLIPTextEncode(POSITIVE) ─► FluxGuidance 3.2 ─► KSampler(euler/beta, 28 steps, cfg 1)
                                                                              EmptySD3LatentImage 1080×1920 ─┘
                                                                                     ▼
                                                                   VAEDecode ─► SaveImage
```

Install:
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/balazik/ComfyUI-PuLID-Flux     # or sipie800/ComfyUI-PuLID-Flux-Enhanced
git clone https://github.com/ltdrdata/ComfyUI-Impact-Pack   # FaceDetailer (layer 3)
pip install insightface onnxruntime-gpu facexlib
# models/
#   unet/flux1-dev.safetensors            clip/t5xxl_fp16.safetensors, clip/clip_l.safetensors
#   vae/ae.safetensors                    loras/lilo_flux_v1.safetensors
#   pulid/pulid_flux_v0.9.1.safetensors   insightface/models/antelopev2/*
#   input/lilo_face_ref_front.png         (= curated R0)
```

**Why PuLID starts at 0.1:** the first ~10% of denoising sets composition and pose. Letting the
LoRA and prompt own that step avoids the "pasted-on face, frozen pose" look.

**Tuning cheatsheet**

| Symptom | Fix |
|---|---|
| Face correct, looks pasted / stiff | PuLID weight → 0.7, start_at → 0.15 |
| Face drifts on profiles | Add a profile face ref (R3) and swap `FACE_REF` for side-angle shots |
| Outfit leaks into alt-wardrobe shots | LoRA strength → 0.8, describe the alt outfit first in the prompt |
| Plastic skin | Guidance 3.5 → 2.8; add "visible pores, unretouched"; skip upscalers that smooth |
| Small face in wide fire shots looks wrong | Enable FaceDetailer: bbox `face_yolov8m`, denoise 0.35, PuLID on the detailer's model path |
| Hands with chopsticks break | Generate at 1080×1920 directly (no upscaling from small), add "anatomically correct hand", inpaint hands at 0.45 |

## Step 4: Placing her in ZOZOBRA (the real interior)

ZOZOBRA's interior design renders live in `assets/venue/` (10 zones, 4 with night variants), with a
catalog in `assets/venue/venue.json`. They are the **ground truth** for every in-restaurant scene:

| Zone (plate id) | What's there | Best for |
|---|---|---|
| `bar_tower_vertical` | Already 9:16. Tiered lantern canopy over the circular bar, ribbons, slatted screens | Talking shots, night vibe |
| `bar_canopy_bamboo` | Circular bar, open kitchen behind, bamboo foreground | Fire show, hero dish |
| `bar_stools_ribbons` | Bar-stool row, hanging glasses, crimson ribbons | Challenges, cocktails |
| `booth_row_ribbon` | Bolster-armchair booths, candles, black pendants | Eating shots, POV |
| `booth_wall_bar_view` | Banquette, hammered wall, view to the kitchen and bar | Tracking shots |
| `dining_hall_ribbons` | Communal table, ribbons, rust pendants | Group / community |
| `screens_bamboo_square` | Between the slatted screens | Reveals |
| `entrance_fringe_corridor` | Golden fringe ceiling, bark walls, uplights | Arrival / "come in" |
| `mirror_corridor` | Already 9:16. Mirror at the end | Outfit check / mirror selfie |
| `restroom_vanity` | Rust-metal vanity | Lipstick touch-up POV |

How the pipeline uses them (automatic):
1. The Brain picks a `venue_plate` for every in-restaurant post and writes the scene to match it.
2. `venue.plate_9x16()` crops the plate to 1080×1920 around its `focus_x`. Posts after 19:00 use the
   night variant.
3. **LILO into the room:** img2img with her LoRA at strength ~0.62, which keeps the room's layout,
   materials and light while she appears in it. On fal this is `fal-ai/flux-lora/image-to-image`;
   in ComfyUI it's the same graph with `LoadImage → VAEEncode` replacing the empty latent and
   `denoise 0.62`. The best of 4 renders by face similarity is kept.
4. **Atmosphere cutaways** (shots starting with `venue establishing:`) animate the plate itself
   with image-to-video, so the room on screen is the actual design, never an invented restaurant.
5. **Food** stays real or generated close-up: food words in a shot send it to the food generator,
   and dishes must exist in `menu.json`.

**Interim method, used before the LoRA exists:** generate LILO on a flat chroma-green background
and composite her onto the real plate with `scripts/composite_lilo.py`. That script keys out the
green, removes green spill, colour-matches her to the room, and adds a soft shadow, depth blur and
shared grain. The room is pixel-for-pixel the real design, so no invented lamps, signs or murals
can appear. Text-to-image scenes that "describe" the room are not allowed for publishing: they
invent decor such as calligraphy lanterns, dragon murals or red paper lanterns that ZOZOBRA
doesn't have.

Tuning: if the room changes too much, lower strength to 0.55. If LILO looks pasted on or too small,
raise it to 0.7 and describe her position from the plate's `lilo_spots`. If the space isn't open
yet, set `stage: coming_soon` (panel → המקום). The Brain then writes teaser content and never
claims the space is open.

The renders are a design visualisation. Once the branch is open and real photos of the service exist
(woks on, people at the bar), add them as new plates with the same fields. Real photos beat renders
for trust.

## Step 5 — Automatic QA gate (every render)

Before an image goes to video, reject it if:
- InsightFace similarity to R0 < 0.60 (face drift)
- No face detected on a shot that should have her
- Hand keypoint count is wrong (MediaPipe Hands) on shots tagged "chopsticks" / "glass"

Rejected renders are re-rolled with seed+1000, up to 3 times, then flagged to a human.
