# LILO: first look (Figma AI, GPT Image)

- `R0_anchor.jpg` is **LILO's official face, approved by the owner on 2026-10-17.** The panel installs it as
  `data/refs/R0_anchor.png` on first start. It is the reference for the 30-image training sheet, the LoRA, and the
  face-similarity QA gate. Do not replace it: changing her face after launch breaks continuity for followers.
- `lilo_bar.jpg` and `lilo_noodles.jpg` are concept scenes inside ZOZOBRA, made from text only.

These were generated without the LoRA, so the face is similar but not locked between shots.
After the LoRA is trained (needs FAL_KEY), every shot uses the same identity.
