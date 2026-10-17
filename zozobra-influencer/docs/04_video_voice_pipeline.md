# MODULE 2 — Video, Motion & Voice Pipeline

```
Brain DayPlan ─► hero still (LoRA+PuLID, best of 4 by face-similarity)
             │        └─► Runway Gen-4 Turbo image→video (10s A-roll, face-stable motion)
             │                         └─► Sync lipsync-2 + ElevenLabs v3 voice ─► lip-synced A-roll
             └─► B-roll stills (food / flames, no face) ─► image→video 5s each
                                                       └─► ffmpeg overlay at script timestamps,
                                                           -14 LUFS, 1080×1920@30 ─► final.mp4
```
Code: `src/zozobra/video.py`, `src/zozobra/voice.py`, orchestrated by `pipeline.produce_day`.

## 2.1 Animating her: which model for which shot

| Shot type | Best model | Why |
|---|---|---|
| Talking to camera (A-roll) | Runway Gen-4 Turbo / Kling 2.x image→video, **then** Sync lipsync-2 | Low-motion base keeps identity, and lip-sync replaces the mouth |
| Eating / slurping / drinking | Kling 2.x (best food and hand physics) or Veo 3 | Handles noodles, chopsticks and liquid most believably |
| Wok fire, steam, food macros (B-roll) | Veo 3 / Runway / Luma Ray | No face to drift; go wild on motion |
| Expressive close-ups without speech | Hedra Character-3 or LivePortrait (driven by a reference video of you acting the beat) | Exact expression timing |

**Rule:** the still *is* the identity. Video models keep a face well when (a) the first frame is
sharp and frontal-ish, (b) the motion is moderate, and (c) the head doesn't turn more than ~45°.
Big turns and hands over the face are where identity breaks, so cut to B-roll there.

### Motion prompt formula
`[camera move] + [subject action, specific body parts] + [physics detail] + [atmosphere] + guardrails`

Guardrails (auto-appended by `video.MOTION_GUARDRAILS`):
> Face remains consistent and stable, natural blinking, no morphing, realistic hand-object contact,
> chopsticks grip correctly, noodles have weight and sag with gravity, liquid moves with real
> viscosity, steam drifts upward, handheld micro-shake, 24fps cinematic.

### Ready-to-use motion prompts

**Noodle slurp (Kling / Runway)**
```
Slow handheld push-in. She lifts a thick bundle of red-broth ramen noodles with chopsticks to
mouth height, blows on them once, then slurps them in with a quick satisfied laugh; noodles sway
and drip chili oil back into the bowl; steam curls across the frame; wok flames flicker soft and
out of focus behind her.
```
**Wok-fire reveal**
```
Static low angle on the wok line. A cook tosses noodles and a 1-meter flame bursts up, lighting
her face orange from the side; she steps into frame from the right, looks at the camera and
smirks; sparks drift upward; copper lights pulse in the bokeh.
```
**Cocktail ASMR**
```
Macro, locked-off. A smoked cocktail is set on black marble; the glass dome lifts and smoke rolls
out slowly over the rim; her hand with a copper ring takes the glass by the stem; ice shifts with
a visible crack; red neon reflections slide across the glass.
```
**Spice challenge reaction**
```
Medium close-up, slight handheld. She takes a spoonful of red broth, freezes, eyes widen, then
she fans her face with one hand and laughs while her eyes water; ponytail swings; background
diners blurred.
```
**Walk-in, dark-luxury vibe (B-roll with her)**
```
Smooth gimbal follow from behind. She walks through the dark noodle bar past glowing copper
pendants toward the open kitchen, glances back over her shoulder at the camera with a half-smile;
steam and flame light ahead.
```

### Lip-sync and eating physics

- **Talking shots:** generate the A-roll with *closed or neutral mouth* motion ("she listens,
  nods, subtle smile"). Sync lipsync-2 then drives the mouth from the voice track. `sync_mode:
  loop` stretches a 10s base to any voice length.
- **Never lip-sync while chewing.** Script structure handles it: talk, then cut to B-roll, then a
  real eating shot with no words. The Brain marks macro shots, and `video.is_broll()` overlays them.
- **Hedra Character-3** is an alternative for one-take talking heads up to about 60s (upload the
  still plus audio). It's good for "storytime" pillar posts.
- **LivePortrait** (ComfyUI `ComfyUI-LivePortraitKJ`) is for precise reactions. Film yourself
  acting the beat on a phone, and LivePortrait transfers the expression onto her still.
- Eating realism: always show the food *leaving* the frame toward the mouth, then cut. Mouths
  closing on food are the #1 uncanny tell.

### Edit spec (TikTok/Reels)
- 1080×1920, 30fps, H.264 CRF 18, AAC 192k, `-14 LUFS` integrated (both platforms normalise there).
- 12–25s. Cut every 1–2s. Hook visual in frame 1, no logo intro.
- Burned-in Hebrew captions: Heebo/Assistant Black, white with 6px black stroke, centred in the
  safe zone (keep 250px clear top and bottom for platform UI).
- Use the platform's own trending sounds *inside the app* when posting manually. API posts can't
  attach licensed platform sounds, so for API posts use original audio or royalty-free tracks.

## 2.2 Voice clone (ElevenLabs)

There's no real person to clone, so her voice is **designed** (Voice Design), not cloned from
someone. That avoids consent and likeness issues entirely.

### Design parameters
| Param | Value |
|---|---|
| Voice description | *Israeli woman in her late twenties, warm slightly husky mid-low voice, fast energetic Tel Aviv delivery with playful smirks in the tone, crisp consonants, natural breathy laughs, speaks native Hebrew with casual English food words mixed in, intimate like talking to a friend at the bar* |
| Design model | `eleven_multilingual_ttv_v2` |
| TTS model | `eleven_v3` (Hebrew support + inline audio tags) |
| stability | 0.45 (v3 "Natural"; lower = more expressive, higher = more consistent) |
| similarity_boost | 0.8 |
| style | 0.35 |
| speed | 1.08 |
| seed | fixed per video (repeatable re-renders) |
| Output | `mp3_44100_128` |

### Audio tags the Brain writes (v3)
`[excited]` `[whispers]` `[laughs]` `[sighs]` `[playfully]` `[gasps]` `[mischievously]`.
Example the Brain produces:
```
[excited] שנייה, תשמעו את הווק הזה. [whispers] זה הראמן הכי חריף בתל אביב. [laughs] רמת חריפות: לילו.
```

### Hebrew + English slang tips
- Write English food words in Latin script inside Hebrew (`ה-wok`, `crispy`), and v3 pronounces them
  in English. Write slang phonetically in Hebrew (`וואלה`, `סבבה`).
- Hebrew without niqqud is ambiguous. For words it misreads, add niqqud just to that word
  (`בָּשָׂר`) or respell it.
- Keep one sentence per line. Short lines give natural breath pauses.

### Usage
```bash
python -m zozobra.voice design                         # once: creates the voice, saves previews to data/voice_previews/
export ELEVENLABS_VOICE_ID=...                          # the id it prints
python -m zozobra.voice say "[excited] וואלה, פצצה." out.mp3
python -m zozobra.voice week data/calendars/week_2026-10-18.json   # voices every reel in the calendar
```
Listen to all 3 previews and re-run `design` until it's right. The voice is then fixed forever.
Don't redesign it later, because followers notice.
