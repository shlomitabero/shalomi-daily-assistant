# LILO: first look (Figma AI, GPT Image)

- `R0_anchor_candidate.jpg` is the proposed anchor face (character bible §Visual signature). If approved, it becomes
  `data/refs/R0_anchor.png` and seeds the 30-image training sheet and the LoRA (panel → הקמה).
- `lilo_bar.jpg` and `lilo_noodles.jpg` are concept scenes inside ZOZOBRA, made from text only.

These were generated without the LoRA, so the face is similar but not locked between shots.
After the LoRA is trained (needs FAL_KEY), every shot uses the same identity.
