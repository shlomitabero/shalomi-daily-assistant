"""Typed contracts between the Brain, the media pipeline and the publishers."""
from __future__ import annotations

from datetime import date
from enum import Enum

from pydantic import BaseModel, Field


class Format(str, Enum):
    reel = "reel"            # 9:16 video -> IG Reels + TikTok
    carousel = "carousel"    # IG carousel of stills
    story = "story"          # IG story (ephemeral, low-stakes testing)


class Pillar(str, Enum):
    hero_dish = "hero_dish"            # one dish, sensory close-ups
    fire_show = "fire_show"            # woks, flames, chef choreography
    night_vibe = "night_vibe"          # dark-luxury atmosphere, date night, cocktails
    challenge = "challenge"            # spice challenge / trend format
    pov_story = "pov_story"            # POV / storytime / relatable humor
    community = "community"            # replies to comments, polls, UGC duets


class ScriptLine(BaseModel):
    t_start: float = Field(description="Seconds from video start")
    t_end: float
    spoken_he: str = Field(description="What LILO says, natural spoken Israeli Hebrew")
    voice_direction: str = Field(description="ElevenLabs v3 audio tag(s), e.g. [excited], [whispers], [laughs]")
    on_screen_text_he: str = Field(description="Burned-in caption / text overlay, max ~6 words; empty string if none")
    shot: str = Field(description="Camera shot for this beat, e.g. 'macro noodle pull', 'medium, LILO to camera'")


class Visual(BaseModel):
    venue_plate: str = Field(description="Id of the ZOZOBRA interior plate this shot happens in (from the venue list), or 'none' for food-only / outdoor shots")
    scene: str = Field(description="Where, inside ZOZOBRA, lighting, props. English. No description of LILO's face/body - that is injected automatically.")
    action: str = Field(description="What LILO is doing, pose, expression, hands. English.")
    wardrobe: str = Field(description="Outfit for this shot in English, or empty string to use the signature look")
    motion_prompt: str = Field(description="Image-to-video prompt: camera move + subject motion + physics, English, one paragraph")


class DayPlan(BaseModel):
    day: date
    weekday_he: str
    post_time_local: str = Field(description="HH:MM Asia/Jerusalem")
    platforms: list[str] = Field(description="Subset of ['instagram','tiktok']")
    format: Format
    pillar: Pillar
    dish_id: str = Field(description="Must be an id from the menu, or 'atmosphere' for vibe-only posts")
    concept: str = Field(description="One-sentence idea in Hebrew")
    hook_he: str = Field(description="First 1.5 seconds - spoken or on-screen hook in Hebrew")
    hook_alternatives_he: list[str] = Field(description="Two alternative hooks for A/B testing")
    visual: Visual
    script: list[ScriptLine]
    caption_he: str = Field(description="Caption body without hashtags and without disclosure lines")
    cta_he: str
    hashtags: list[str] = Field(description="Without '#'. Mix of Hebrew and English, 3-8 tags")
    trend_or_audio_note: str = Field(description="Trending format/sound to ride, or empty string")


class WeekPlan(BaseModel):
    weekly_focus: str
    strategy_summary_he: str
    days: list[DayPlan]
