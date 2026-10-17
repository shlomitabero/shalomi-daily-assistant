# MODULE 1.2: Master Image Prompts

Generate these **before** the LoRA exists. They become the training set. Workflow:

1. Generate **R0, the anchor portrait**, until one face is unmistakably "her." Lock that seed.
2. Generate every other sheet *from R0* (Flux Kontext / PuLID with R0 as the face reference, or
   Midjourney `--cref`), so all 30 dataset images share one identity.
3. Curate (see `03_consistency_workflow.md`), then train.

The identity block below is identical to `persona.FACE_TOKENS + HAIR_TOKENS + BODY_TOKENS`.

```
IDENTITY = 27-year-old Israeli woman, warm olive skin with natural texture and faint freckles
across the nose bridge, almond-shaped hazel-green eyes, thick straight dark brows, small beauty
mark under the left eye, softly defined cheekbones, full lips with a subtle natural tint,
slightly asymmetric confident half-smile, jet-black hair in a sleek high ponytail with two loose
face-framing strands, thin gold hoop earrings, athletic slim build
```

```
REALISM = shot on Sony A7R V, 85mm f/1.8, natural skin texture with visible pores and fine
vellus hair, subtle under-eye texture, no retouching, true-to-life color, soft film grain
```

---

## Flux.1 [dev] / [pro]: reference sheet prompts

Settings: guidance 3.0–3.5, 28–32 steps, `euler` + `beta`, no negative prompt (Flux ignores it at
cfg 1). Use 1024×1024 for portraits and 832×1216 for full body.

### R0: Anchor portrait (front, neutral)
```
Studio headshot, front-facing, eye level, {IDENTITY}, neutral relaxed expression with a hint of a
smile, plain black ribbed tank top, seamless mid-grey background, large soft key light from
front-left, gentle fill, faint rim light separating the hair, {REALISM}
```

### R1: Three-quarter left / R2: three-quarter right
```
Studio portrait, head turned 45 degrees to her {left|right}, eyes to camera, {IDENTITY},
calm confident expression, black ribbed tank, seamless mid-grey background, soft key light,
{REALISM}
```

### R3: Side profile (left, which shows the beauty mark side) / R4: right profile
```
Clean side profile portrait facing {left|right}, {IDENTITY}, ponytail visible behind, chin level,
seamless mid-grey background, soft butterfly lighting, sharp profile silhouette, {REALISM}
```

### R5: Full body front, signature look
```
Full-body fashion photo, standing straight facing camera, weight on one leg, arms relaxed,
{IDENTITY}, 1.68m tall, wearing a cropped black chef-style jacket with copper snap buttons over a
black ribbed tank, high-waisted wide black trousers, black leather boots, thin gold chain
necklace, small red chili-pepper enamel pin on the collar, seamless mid-grey studio background,
even soft lighting, head-to-toe in frame, 50mm, {REALISM}
```

### R6: Full body side / R7: full body back three-quarter
```
Full-body photo, {side view walking left | back three-quarter view looking over her shoulder},
{IDENTITY}, same signature outfit (cropped black chef jacket with copper snaps, wide black
trousers, gold chain, red chili pin), seamless mid-grey background, {REALISM}
```

### R8–R13: Expression set (one image each, same framing as R0)
```
Close-up portrait, {IDENTITY}, {EXPRESSION}, black ribbed tank, seamless dark charcoal background,
soft key light, {REALISM}
```
| ID | EXPRESSION |
|---|---|
| R8 | genuine open-mouth laugh, eyes crinkled, head tilted back slightly |
| R9 | spicy reaction: eyes watering, mouth in an "O", fanning her face with one hand |
| R10 | eyes closed, savoring a bite, slow satisfied smile |
| R11 | playful smirk with one raised eyebrow, looking straight into the lens |
| R12 | surprised wide eyes, eyebrows up, lips parted ("wait, WHAT?") |
| R13 | talking mid-sentence, mouth open on a vowel, animated hand gesture near her face |

### R14–R17: Hands and props (for chopstick and glass physics)
```
Medium close-up, {IDENTITY}, {ACTION}, slim copper ring on right index finger, anatomically
correct hand, five fingers, natural grip, dark moody background with warm copper light, {REALISM}
```
- holding wooden chopsticks correctly, lifting a strand of noodles toward her mouth
- holding a coupe cocktail glass by the stem, smiling over the rim
- tossing a carbon-steel wok with one hand, small flame at the lip of the wok
- pointing at the camera with chopsticks, mid-laugh

### R18–R29: In-world scenes (variety for the dataset)
Use the R5 outfit and the ZOZOBRA world block:
```
WORLD = ZOZOBRA dark-luxury Asian restaurant interior, towering tiered lantern canopy of backlit
warm-paper panels over a circular bar with hanging wine glasses, sculptural crimson silk ribbons
swirling across the dark ceiling, black-metal slatted screen partitions, charred-bark textured walls
with warm grazing uplights, polished dark concrete floor with glowing LED strips, rust-copper
cylinder pendants, candlelit wooden tables, bamboo, open kitchen with wok flames behind the bar
```
(Taken from the real design renders in `assets/venue/`. For production shots the pipeline uses the
renders themselves, not just this text. See `03_consistency_workflow.md`, Step 4.)
- `{IDENTITY}, sitting at the black marble counter, slurping spicy red ramen, chili oil droplets, {WORLD}, 35mm, {REALISM}`
- `{IDENTITY}, standing beside the wok station, a giant flame burst behind her lighting her face orange, laughing, {WORLD}, {REALISM}`
- `{IDENTITY}, leaning on the bar holding a smoked cocktail, red neon rim light, {WORLD}, 50mm, {REALISM}`
- `{IDENTITY}, eating golden chicken curry with a spoon, steam curling, candid moment, {WORLD}, {REALISM}`
- Also include 2 outdoor night street shots, 2 daylight shots and 2 alt-outfit shots so the LoRA
  learns *her* and not *the restaurant*.

---

## Midjourney v6 / v6.1 equivalents

Generate R0 first, upscale it, and use its URL as `--cref` for everything else.

```
R0:  editorial studio headshot of a 27-year-old Israeli woman, warm olive skin with natural
     texture and faint freckles, almond hazel-green eyes, thick straight dark brows, small beauty
     mark under left eye, jet-black sleek high ponytail with face-framing strands, thin gold
     hoops, black ribbed tank, mid-grey seamless backdrop, soft key light, 85mm, visible pores,
     unretouched --ar 4:5 --style raw --stylize 50 --v 6.1

Sheet: character reference sheet of the same woman, front view, 3/4 view, side profile and full
     body, cropped black chef jacket with copper snaps, wide black trousers, red chili pin, grey
     studio background, consistent lighting --cref <R0_URL> --cw 100 --ar 3:2 --style raw --v 6.1

Expressions: same woman, 6-panel expression sheet: laughing, spicy reaction fanning face,
     eyes closed savoring, smirk with raised brow, surprised, mid-sentence talking
     --cref <R0_URL> --cw 100 --ar 3:2 --style raw --v 6.1

Scene: the same woman slurping spicy red ramen at a black marble bar, wok flames behind her, copper
     and amber lights, red neon reflections, steam, candid, 35mm, film grain
     --cref <R0_URL> --cw 100 --ar 9:16 --style raw --stylize 75 --v 6.1
```
Use `--cw 100` for face, hair and outfit. Drop to `--cw 30` to keep only the face when changing outfit.

---

## Production prompt template (after LoRA, used automatically by the Brain)

`persona.visual_prompt(scene, action, wardrobe)` produces:
```
photo of l1l0zzb woman, {FACE}, {HAIR}, {BODY}, {WARDROBE or SIGNATURE_LOOK}, {ACTION}, {SCENE},
shot on Sony A7S III, 35mm f/1.4, shallow depth of field, cinematic low-key lighting, natural
skin texture with visible pores, subtle film grain, 9:16 vertical
```
