"""Burned-in Hebrew on-screen text (ASS via libass, which handles RTL shaping).

Style: Heebo Black, white with a thick black outline, centred in the safe zone - 250px clear at
top and bottom for the platforms' UI.
"""
from __future__ import annotations

from pathlib import Path

from .config import ROOT
from .schemas import ScriptLine

FONTS_DIR = ROOT / "assets" / "fonts"

HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,Heebo Black,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,7,2,8,80,80,420,177
Style: Line,Heebo Black,78,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,6,2,2,80,80,520,177

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def _ts(seconds: float) -> str:
    cs = int(round(seconds * 100))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _escape(text: str) -> str:
    return text.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", "\\N")


def build_ass(lines: list[ScriptLine], hook: str | None = None) -> str:
    events = []
    if hook:
        events.append(f"Dialogue: 1,{_ts(0)},{_ts(1.8)},Hook,,0,0,0,,{{\\fad(0,150)}}{_escape(hook)}")
    for line in lines:
        text = line.on_screen_text_he.strip()
        if not text:
            continue
        start = max(line.t_start, 1.8) if hook else line.t_start
        if start >= line.t_end:
            continue
        events.append(f"Dialogue: 0,{_ts(start)},{_ts(line.t_end)},Line,,0,0,0,,{{\\fad(80,80)}}{_escape(text)}")
    return HEADER + "\n".join(events) + "\n"


def write_ass(lines: list[ScriptLine], path: Path, hook: str | None = None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(build_ass(lines, hook), encoding="utf-8")
    return path


def ffmpeg_filter(ass_path: Path) -> str:
    """Filter string for -filter_complex (paths escaped for ffmpeg's filter parser)."""
    esc = lambda p: str(p.resolve()).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
    return f"ass='{esc(ass_path)}':fontsdir='{esc(FONTS_DIR)}'"
