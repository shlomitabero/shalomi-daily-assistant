# LILO × ZOZOBRA: AI Virtual Creator Agent

A clearly-labelled AI food & lifestyle creator ("LILO", `@lilo.eats.fire`). It plans, renders,
voices, publishes and learns from content for ZOZOBRA on Instagram and TikTok.

| Module | Blueprint | Code / config |
|---|---|---|
| 1. Persona & face/body lock | [01 Character bible](docs/01_persona_bible.md) · [02 Master prompts](docs/02_master_image_prompts.md) · [03 Consistency workflow](docs/03_consistency_workflow.md) | `src/zozobra/persona.py` · `lora/lilo_flux_lora.yaml` · `comfyui/lilo_flux_pulid_lora_api.json` · `image_gen.py` · `qa.py` |
| 2. Video, motion, voice | [04 Video & voice](docs/04_video_voice_pipeline.md) | `video.py` (Runway → Sync → ffmpeg) · `voice.py` (ElevenLabs v3) |
| 3. Brain | system prompt + schema inside `brain.py` | `brain.py` · `schemas.py` · `compliance.py` |
| 4. Publishing & account health | [05 Publishing & setup](docs/05_publishing_account_setup.md) | `publish_instagram.py` · `publish_tiktok.py` · `account_health.py` · `storage.py` |
| 5. Growth loop *(assumed, see doc)* | [06 Growth loop](docs/06_growth_loop.md) | `analytics.py` · `engagement.py` |
| Orchestrator | | `pipeline.py` · `web.py` (panel) · `jobs.py` (scheduler) · `doctor.py` (setup check) |
| Module 1 executable | | `refsheet.py` (anchor → 30-image dataset) · `fal_provider.py` (LoRA training, images, video, lip-sync) · `subtitles.py` (Hebrew burned-in text) |

> **בעברית, צעד אחרי צעד:** [docs/00_מדריך_הפעלה.md](docs/00_מדריך_הפעלה.md)

## Control panel (recommended)
```bash
./run.sh            # → http://localhost:8000   (Hebrew RTL panel: setup wizard, planning, approval, replies, insights)
```
Or deploy the included `Dockerfile` (Railway: `railway.json`, mount a volume at `/data`, set `PANEL_PASSWORD`).
The panel runs its own scheduler: publish check every 15 min, metrics 02:30, optional auto-plan Sunday 10:00.

`MEDIA_PROVIDER=fal` (default) needs a single `FAL_KEY` for images, LoRA training, video and lip-sync, so no GPU
and no S3 are required. TikTok gets a direct file upload, so no domain verification is needed either.
`MEDIA_PROVIDER=self` uses your own ComfyUI + Runway + Sync + S3/R2.

## Command line
```bash
cd zozobra-influencer
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # fill keys; DRY_RUN=true by default
export PYTHONPATH=src

python -m zozobra.doctor --online      # what's configured / missing
# 0. data/menu.json holds ZOZOBRA dishes from public Wolt listings - have the restaurant confirm it
# 1. Weekly calendar (Claude, structured output) → data/calendars/week_<date>.{json,md}
python -m zozobra.pipeline plan --focus "הראמן החריף + אווירת ערב דארק-לאקשרי" --start 2026-10-18
# 2. See every prompt that would run (dry run), then set DRY_RUN=false to render for real
python -m zozobra.pipeline produce data/calendars/week_2026-10-18.json --day 2026-10-18
# 3. Watch data/renders/2026-10-18/final.mp4, then approve
python -m zozobra.pipeline approve 2026-10-18
# 4. Cron does the rest: publish-due every 15 min, metrics nightly, plan every Sunday
pytest -q
```

## Built-in safety rails
- **Disclosure is automatic and non-removable.** Every caption gets the Hebrew ad label
  (`#פרסומת | שיתוף פעולה בתשלום`) and the AI-character label. TikTok posts set
  `brand_content_toggle` and `is_aigc`.
- **Menu-grounded copy.** The calendar is rejected if it names a dish that isn't in `menu.json`.
- **Human approval** before every publish and every comment reply (on by default).
- **Official APIs only**, with warm-up caps, minimum gaps and quiet hours. No engagement automation.
- **Identity QA.** Renders whose face drifts from the anchor portrait are rejected.

## Before going live
1. Panel → Setup: anchor → character sheet → train (or `python -m zozobra.refsheet anchor|pick|sheet`
   + `python -m zozobra.fal_provider train data/refs/dataset`). The LoRA URL is saved automatically.
2. Panel → Setup → create voice (or `python -m zozobra.voice design`).
3. Accounts + Meta/TikTok apps per doc 05. TikTok app audit is needed for public posts.
4. Check vendor API versions (Runway `X-Runway-Version`, Sync model, Graph API version) against
   current docs. They're constants at the top of each module.
5. Have ZOZOBRA's legal/marketing sign off on the disclosure wording and on any offers.
