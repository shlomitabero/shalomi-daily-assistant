"""Writes examples/launch_posts.json - LILO's first three posts (GROW phase: Haifa nightlife guide,
ZOZOBRA not named). Seeded into the panel as calendar week_2026-10-19.

    python examples/make_launch.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from zozobra.schemas import WeekPlan  # noqa: E402

SIGN_OFF = ("אוכלים. שותים. נשארים.", "[warmly]", "EAT. DRINK. STAY.")
OUTFIT = "tailored black blazer over a high-neck black top, black wide-leg trousers, thin gold chain"
TAGS = ["חיפה", "חיפהבלילה", "בילוייםבחיפה", "קריות", "haifa", "nightlife"]


def L(t0, t1, spoken, voice, onscreen, shot):
    return {"t_start": t0, "t_end": t1, "spoken_he": spoken, "voice_direction": voice,
            "on_screen_text_he": onscreen, "shot": shot}


def city_day(day, weekday, time, pillar, concept, hook, alts, scene, action, motion, script, caption, cta, tags):
    return {"day": day, "weekday_he": weekday, "post_time_local": time, "platforms": ["instagram", "tiktok"],
            "format": "reel", "pillar": pillar, "dish_id": "atmosphere", "features_zozobra": False, "places": [],
            "concept": concept, "hook_he": hook, "hook_alternatives_he": alts,
            "visual": {"venue_plate": "none", "scene": scene, "action": action, "wardrobe": OUTFIT,
                       "motion_prompt": motion},
            "script": script, "caption_he": caption, "cta_he": cta, "hashtags": tags, "trend_or_audio_note": ""}


DAYS = [
    city_day(
        "2026-10-19", "שני", "20:00", "pov_story",
        "היכרות: לילו, מדריכת הבילויים של חיפה והקריות, שואלת את הקהל לאן יוצאים",
        "נעים מאוד, אני לילו.", ["אני צריכה את העזרה שלכם", "מדריכת הלילה החדשה של חיפה"],
        "Louis Promenade in Haifa at night, the lights of Haifa Bay and the port glittering far below, warm street lamps",
        "leaning on the promenade railing, turning to camera with a confident half-smile, a small wave",
        "Slow push-in from medium to medium close-up. She turns from the bay view to the camera, smiles and gives a "
        "small wave; city lights twinkle in the bokeh behind her; a light breeze moves loose strands of her hair.",
        [L(0, 3, "נעים מאוד, אני לילו.", "[warmly]", "נעים מאוד, אני לילו 👋", "medium, LILO to camera at the promenade"),
         L(3, 7, "אני מכירה כל פינה שווה בחיפה ובקריות.", "[confidently]", "חיפה והקריות", "medium close-up, LILO to camera"),
         L(7, 11, "ומעכשיו, אני מראה לכם לאן יוצאים.", "[playfully]", "לאן יוצאים?", "close-up, LILO smiling"),
         L(11, 15, "כתבו לי בתגובות: לאן יוצאים הערב?", "[warmly]", "לאן יוצאים הערב? 👇", "medium close-up, LILO points at camera"),
         L(15, 17.5, *SIGN_OFF, "medium, LILO turns back to the bay view")],
        "נעים מאוד, אני לילו 🌙\nאני מכירה כל פינה שווה בחיפה ובקריות.\nומעכשיו אני מראה לכם לאן יוצאים.",
        "כתבו בתגובות לאן יוצאים הערב 👇", TAGS),
    city_day(
        "2026-10-21", "רביעי", "20:00", "night_vibe",
        "חיפה לא הולכת לישון מוקדם: שלושה אזורים לערב בעיר",
        "חושבים שחיפה הולכת לישון מוקדם?", ["3 אזורים לערב בחיפה", "מי אמר שאין מה לעשות בחיפה בלילה?"],
        "Ben Gurion Boulevard in Haifa's German Colony at night, the illuminated Baha'i terraces rising up the mountain behind her",
        "walking slowly toward camera on the boulevard, then stopping and counting on her fingers",
        "Smooth gimbal walk-backwards in front of her as she strolls down the boulevard; the lit terraces glow behind; "
        "she stops and counts three on her fingers with a knowing smile.",
        [L(0, 2.5, "חושבים שחיפה הולכת לישון מוקדם?", "[playfully]", "חיפה ישנה מוקדם? 🤨", "medium, LILO walking toward camera"),
         L(2.5, 6.5, "העיר התחתית. ברים קטנים בין מבני אבן ישנים.", "[confidently]", "1. העיר התחתית", "medium close-up, LILO to camera"),
         L(6.5, 10.5, "המושבה הגרמנית. ערב מול הגנים המוארים.", "[warmly]", "2. המושבה הגרמנית", "medium, LILO gestures to the lit terraces behind"),
         L(10.5, 14.5, "ורחוב מסדה, למי שאוהב שכונה עם אופי.", "[playfully]", "3. רחוב מסדה", "medium close-up, LILO counts three on her fingers"),
         L(14.5, 17, *SIGN_OFF, "medium, LILO smiles and walks on")],
        "חיפה לא הולכת לישון מוקדם 🌙\nהעיר התחתית, המושבה הגרמנית ורחוב מסדה: שלושה אזורים לערב בעיר.\nאיזה מקום הייתם מוסיפים?",
        "שמרו לסופ\"ש ותייגו את מי שבא איתכם", TAGS),
    city_day(
        "2026-10-23", "שישי", "13:00", "community",
        "הקהל בוחר: המקום הכי שווה בקריות לערב. התגובה המובילה נכנסת לסרטון הבא",
        "יש לי בעיה עם הקריות.", ["אתם בוחרים את הסרטון הבא שלי", "המקום הכי שווה בקריות? אתם תגידו"],
        "Haifa Bay waterfront at golden hour, the Krayot skyline in the distance, calm sea",
        "holding a phone, scrolling and looking up at camera with a curious raised eyebrow",
        "Static medium shot with a gentle handheld drift. She scrolls on her phone, looks up at the camera with a "
        "raised eyebrow, then points at the lens; golden light, soft breeze.",
        [L(0, 3, "יש לי בעיה. אני לא מכירה מספיק את הקריות.", "[playfully]", "בעיה 😅", "medium, LILO looking up from her phone"),
         L(3, 7, "ואתם? אתם מכירים כל פינה.", "[warmly]", "", "medium close-up, LILO to camera"),
         L(7, 11.5, "כתבו בתגובות את המקום הכי שווה בקריות לערב.", "[confidently]", "המקום הכי שווה בקריות? 👇", "medium close-up, LILO points at camera"),
         L(11.5, 15, "התגובה עם הכי הרבה לייקים נכנסת לסרטון הבא.", "[excited]", "הכי הרבה לייקים = הסרטון הבא", "close-up, LILO smiling"),
         L(15, 17.5, *SIGN_OFF, "medium, LILO puts the phone away and smiles")],
        "אני מכירה את חיפה. את הקריות? אתם מכירים יותר טוב ממני 😅\nכתבו בתגובות את המקום הכי שווה לערב בקריות.\nהתגובה עם הכי הרבה לייקים נכנסת לסרטון הבא.",
        "כתבו בתגובות ותייגו חברים שיצביעו 👇", TAGS),
]

WEEK = {
    "weekly_focus": "פתיחת החשבון: לילו, מדריכת הבילויים הווירטואלית של חיפה והקריות",
    "strategy_summary_he": "שלושה פוסטים ראשונים: היכרות שמזמינה תגובות, מדריך קצר שמזמין שמירה ושיתוף, "
                           "ופוסט קהילה שהופך את העוקבים לשותפים בתוכן. זוזוברה לא מוזכרת עד שלב הטיזר.",
    "days": DAYS,
}

if __name__ == "__main__":
    plan = WeekPlan.model_validate(WEEK)
    out = ROOT / "examples" / "launch_posts.json"
    out.write_text(plan.model_dump_json(indent=2), encoding="utf-8")
    print(f"ok {len(plan.days)} posts")
