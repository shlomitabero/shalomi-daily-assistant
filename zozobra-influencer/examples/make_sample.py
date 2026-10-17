"""Writes examples/week_sample.json - a hand-written reference week in the exact schema the Brain
returns. Used by the control panel's "load sample" button and by tests.

    python examples/make_sample.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from zozobra.schemas import WeekPlan  # noqa: E402


def L(t0, t1, spoken, voice, onscreen, shot):
    return {"t_start": t0, "t_end": t1, "spoken_he": spoken, "voice_direction": voice,
            "on_screen_text_he": onscreen, "shot": shot}


DAYS = [
    {
        "day": "2026-10-18", "weekday_he": "ראשון", "post_time_local": "20:00", "platforms": ["instagram", "tiktok"],
        "format": "reel", "pillar": "fire_show", "dish_id": "bangkok_heat",
        "concept": "פותחים את השבוע עם להבה של מטר: לילו ליד הווק כשהבנגקוק היט נזרק לאוויר",
        "hook_he": "שנייה, תשמעו את הווק הזה 🔥",
        "hook_alternatives_he": ["זה לא פילטר. זו להבה אמיתית.", "יש לי שאלה אחת: אתם עומדים בחום?"],
        "visual": {"scene": "standing beside the open wok line at ZOZOBRA, a cook tossing noodles behind her, a tall flame bursting, copper pendant lights, steam",
                   "action": "turning to camera with a confident half-smile, one hand on the pass counter, flame light on her face",
                   "wardrobe": "",
                   "motion_prompt": "Static low angle on the wok line. A cook tosses glossy caramel-chili noodles and a one-meter flame bursts up, lighting her face orange from the side; she turns her head toward the camera and smirks; sparks drift upward; copper lights glow in the bokeh."},
        "script": [
            L(0, 2.5, "שנייה, תשמעו את הווק הזה.", "[whispers]", "", "macro flame burst in the wok, sizzling sound"),
            L(2.5, 7, "זה בנגקוק היט. גארליק-קרמל, צ'ילי, מנטה.", "[excited]", "בנגקוק היט 🔥", "medium, LILO to camera at the wok line"),
            L(7, 11, "והחלק הכי טוב? הזריקה השנייה.", "[playfully]", "הזריקה השנייה", "macro noodles tossed mid-air, slow motion"),
            L(11, 15.5, "רמת חריפות: לילו. מי בא איתי?", "[laughs]", "רמת חריפות: לילו 🌶️🌶️🌶️", "medium close-up, LILO laughing to camera"),
            L(15.5, 18, "נתראה ליד האש.", "[mischievously]", "נתראה ליד האש 🔥", "medium, LILO walks out of frame past the flames"),
        ],
        "caption_he": "יש מנות שאוכלים. ויש מנות שמסתכלים עליהן נוצרות באש 🔥\nבנגקוק היט — גארליק, קרמל, צ'ילי ומנטה טרייה.\nחריף או חריף-חריף?",
        "cta_he": "תייגו את מי שעומד בחום 👇",
        "hashtags": ["אוכלבתלאביב", "זוזוברה", "אוכלאסייתי", "wok", "foodtok"],
        "trend_or_audio_note": "Original audio: real wok sizzle as the first 2 seconds - no music under the hook",
    },
    {
        "day": "2026-10-19", "weekday_he": "שני", "post_time_local": "19:30", "platforms": ["instagram", "tiktok"],
        "format": "reel", "pillar": "pov_story", "dish_id": "teriyaki_ramen",
        "concept": "POV: יצאת מהמשרד גמור/ה ויש רק דבר אחד שמציל את היום — קערת ראמן",
        "hook_he": "POV: היה לך יום של שבע ישיבות",
        "hook_alternatives_he": ["הטיפול הכי זול בעיר? 🍜", "אם היום שלך היה מבאס, תישאר עד הסוף"],
        "visual": {"scene": "sitting alone at the black marble counter, a steaming bowl of teriyaki chicken ramen in front of her, warm amber light, quiet early evening",
                   "action": "dropping her bag on the stool, exhaling, then lifting noodles with chopsticks and closing her eyes as she tastes",
                   "wardrobe": "oversized black hoodie with copper embroidery",
                   "motion_prompt": "Slow handheld push-in. She drops onto the bar stool, exhales, lifts a bundle of noodles from the steaming broth with chopsticks, blows on them once and eats; noodles sway with weight, broth drips back; steam curls across the frame."},
        "script": [
            L(0, 3, "היה לי יום של שבע ישיבות.", "[sighs]", "POV: יום של 7 ישיבות", "medium, LILO slumps onto the bar stool"),
            L(3, 7, "אני לא צריכה תרפיסטית. אני צריכה ציר.", "[playfully]", "", "medium close-up, LILO to camera"),
            L(7, 11, "ראמן טריאקי. חם, מתקתק, עוטף.", "[softly]", "ראמן טריאקי 🍜", "macro slow noodle pull from steaming broth"),
            L(11, 15, "שלוש כפות, וכל הישיבות נמחקו.", "[laughs]", "", "close-up, LILO eyes closed savoring"),
            L(15, 17.5, "נתראה ליד האש.", "[warmly]", "נתראה ליד האש 🔥", "medium, LILO raises the bowl to camera"),
        ],
        "caption_he": "יש ימים שרק קערה חמה מבינה אותך 🍜\nמה מציל לכם יום גרוע?",
        "cta_he": "שמרו לפעם הבאה שהבוס מבקש \"רק עוד דבר קטן\"",
        "hashtags": ["ראמן", "אוכלבתלאביב", "pov", "comfortfood", "זוזוברה"],
        "trend_or_audio_note": "POV text format; voiceover only, soft lo-fi bed at -20dB",
    },
    {
        "day": "2026-10-20", "weekday_he": "שלישי", "post_time_local": "20:30", "platforms": ["instagram", "tiktok"],
        "format": "reel", "pillar": "challenge", "dish_id": "super_b",
        "concept": "צ'אלנג' חריפות: לילו מנסה את הסופר בי בלי מים לעשר שניות",
        "hook_he": "10 שניות בלי מים. מוכנים?",
        "hook_alternatives_he": ["הטעות הכי טעימה שעשיתי השבוע", "אמרו לי שאני לא אשרוד את זה"],
        "visual": {"scene": "at a dark table with a plate of Super B beef noodles, a full glass of water pushed to the edge of the table, red neon reflections",
                   "action": "taking a big bite with chopsticks, then freezing with wide eyes, fanning her face and laughing",
                   "wardrobe": "",
                   "motion_prompt": "Medium close-up, slight handheld. She takes a big bite of glossy beef noodles, chews, freezes, eyes widen, then she fans her face with one hand and laughs while her eyes water; ponytail swings; the water glass trembles at the table edge."},
        "script": [
            L(0, 2.5, "עשר שניות בלי מים. מוכנים?", "[excited]", "10 שניות בלי מים 💧❌", "medium close-up, LILO to camera pushing the water glass away"),
            L(2.5, 6, "סופר בי. פילה בקר, גארליק-קרמל, הרבה צ'ילי.", "[confidently]", "סופר בי 🥩🌶️", "macro chopsticks lifting beef strips and noodles"),
            L(6, 10, "אחת... שתיים... רגע. רגע רגע רגע.", "[gasps]", "⏱️ 3...", "close-up, LILO eyes widening, fanning face"),
            L(10, 14, "וואלה הפסדתי. אבל איזה הפסד טעים.", "[laughs]", "הפסדתי 😂", "medium, LILO grabbing the water glass laughing"),
            L(14, 17, "תורכם. תייגו מישהו שחושב שהוא חזק.", "[mischievously]", "תורכם 👇", "medium close-up, LILO points chopsticks at camera"),
        ],
        "caption_he": "חשבתי שאני חזקה. הסופר בי חשב אחרת 🌶️😂\nכמה שניות אתם מחזיקים?",
        "cta_he": "תייגו את החבר שבטוח שהוא ינצח",
        "hashtags": ["צאלנגחריף", "אוכלחריף", "spicychallenge", "זוזוברה", "foodtok"],
        "trend_or_audio_note": "Spice-challenge format with a visible on-screen timer; no alcohol in frame",
    },
    {
        "day": "2026-10-21", "weekday_he": "רביעי", "post_time_local": "13:00", "platforms": ["instagram"],
        "format": "carousel", "pillar": "hero_dish", "dish_id": "massaman_curry",
        "concept": "קרוסלה: 5 סיבות שהקארי מסמן הוא הצהריים הכי שווים של האמצע-שבוע",
        "hook_he": "המנה שאף אחד לא מזמין — וכולם צריכים",
        "hook_alternatives_he": ["תפסיקו להזמין את אותו הדבר", "הקארי שישנה לכם את הצהריים"],
        "visual": {"scene": "midday at ZOZOBRA, a bowl of golden chicken massaman curry with pumpkin and peanuts on black marble, soft daylight mixing with copper light",
                   "action": "holding a spoon above the bowl, smiling at camera, steam rising between them",
                   "wardrobe": "white linen shirt",
                   "motion_prompt": "Static macro: golden curry is spooned over jasmine rice, pumpkin chunks glisten, steam rises slowly."},
        "script": [],
        "caption_he": "החלק 1: הדלעת שנמסה 🎃\nחלק 2: הבוטנים שנותנים קראנץ'\nחלק 3: הרוטב שמחכה לאורז\nאתם צוות קארי או צוות נודלס?",
        "cta_he": "שמרו את הפוסט לצהריים של מחר",
        "hashtags": ["קארי", "צהרייםבתלאביב", "אוכלאסייתי", "curry", "זוזוברה"],
        "trend_or_audio_note": "",
    },
    {
        "day": "2026-10-22", "weekday_he": "חמישי", "post_time_local": "21:00", "platforms": ["instagram", "tiktok"],
        "format": "reel", "pillar": "night_vibe", "dish_id": "atmosphere",
        "concept": "חמישי בלילה: ההליכה של לילו דרך הבר החשוך אל המטבח הפתוח — דייט נייט",
        "hook_he": "תביאו את מי שאתם רוצים להרשים",
        "hook_alternatives_he": ["המקום שבו דייט ראשון הופך לשני", "חמישי. 21:00. כאן."],
        "visual": {"scene": "walking through the dark-luxury noodle bar on a busy Thursday night, glowing copper pendants, red neon reflections on black tiles, full tables blurred",
                   "action": "walking toward the open kitchen and glancing back over her shoulder at the camera with a half-smile",
                   "wardrobe": "black satin slip dress and black leather jacket",
                   "motion_prompt": "Smooth gimbal follow from behind. She walks through the dark noodle bar past glowing copper pendants toward the open kitchen, then glances back over her shoulder at the camera with a half-smile; steam and flame light ahead; diners softly blurred."},
        "script": [
            L(0, 3, "תביאו את מי שאתם רוצים להרשים.", "[softly]", "דייט נייט? 🖤", "medium, LILO walking away from camera through the bar"),
            L(3, 7, "אורות נחושת, מוזיקה טובה, והאש במרכז.", "[warmly]", "", "b-roll copper pendant lights and red neon reflections, flame in background"),
            L(7, 11, "שבו על הבר. תסתכלו על הווק. תודו לי אחר כך.", "[playfully]", "שבו על הבר 🔥", "medium close-up, LILO glancing over her shoulder"),
            L(11, 14, "חמישי. כאן. נתראה ליד האש.", "[mischievously]", "נתראה ליד האש", "medium, LILO sitting at the bar facing the open kitchen"),
        ],
        "caption_he": "חמישי בערב צריך מקום עם וייב, לא רק עם אוכל 🖤🔥\nעם מי אתם באים?",
        "cta_he": "שלחו למי שחייב/ת לכם דייט",
        "hashtags": ["דייטנייט", "חמישיבערב", "מסעדותבתלאביב", "זוזוברה", "nightout"],
        "trend_or_audio_note": "Slow-walk 'follow me' format; dark R&B instrumental, beat drop on the over-the-shoulder glance",
    },
    {
        "day": "2026-10-23", "weekday_he": "שישי", "post_time_local": "12:30", "platforms": ["instagram", "tiktok"],
        "format": "reel", "pillar": "hero_dish", "dish_id": "pad_thai",
        "concept": "ASMR של שישי בצהריים: הפאד תאי מהרגע שהוא נכנס לווק עד הביס הראשון",
        "hook_he": "בלי מילים. רק תקשיבו 🎧",
        "hook_alternatives_he": ["הסאונד הכי טוב בתל אביב", "שישי בצהריים, בלי מילים"],
        "visual": {"scene": "the wok station at Friday noon, pad thai being cooked, lime wedges and crushed peanuts on the pass",
                   "action": "squeezing a lime over the plate, then taking the first bite and nodding slowly",
                   "wardrobe": "",
                   "motion_prompt": "Macro sequence: rice noodles hit a smoking wok, tamarind sauce sizzles, a quick flame flares, peanuts rain down, a lime wedge is squeezed with juice droplets; then a medium shot of her taking the first bite and nodding slowly."},
        "script": [
            L(0, 3, "", "", "בלי מילים. רק תקשיבו 🎧", "macro noodles hitting a smoking wok, loud sizzle"),
            L(3, 7, "", "", "", "macro tamarind sauce poured, flame flare"),
            L(7, 10, "", "", "", "macro crushed peanuts raining down, lime squeezed"),
            L(10, 14, "אוקיי. זה היה שווה את השתיקה.", "[whispers]", "פאד תאי ✨", "medium close-up, LILO takes a bite and nods"),
            L(14, 16, "נתראה ליד האש.", "[softly]", "נתראה ליד האש 🔥", "medium, LILO smiling at camera"),
        ],
        "caption_he": "שישי בצהריים, ווק לוהט, ושקט אחד גדול 🎧\nתעלו את הווליום.",
        "cta_he": "שמרו לסופ\"ש הבא",
        "hashtags": ["asmr", "פאדתאי", "שישיבצהריים", "זוזוברה", "foodasmr"],
        "trend_or_audio_note": "Food ASMR - all natural sound, voice only at the end",
    },
    {
        "day": "2026-10-24", "weekday_he": "שבת", "post_time_local": "20:30", "platforms": ["instagram", "tiktok"],
        "format": "reel", "pillar": "community", "dish_id": "spring_rolls",
        "concept": "לילו עונה לתגובות של השבוע תוך כדי ספרינג רולס — ומבקשת מהעוקבים להחליט את המנה של השבוע הבא",
        "hook_he": "שאלתם. אני עונה. עם הפה מלא.",
        "hook_alternatives_he": ["קראתי את כל התגובות שלכם 👀", "אתם בוחרים מה אני אוכלת שבוע הבא"],
        "visual": {"scene": "at the bar with a plate of crispy vegetable spring rolls and a phone propped up showing comments, warm copper light",
                   "action": "reading from the phone, laughing, snapping a spring roll in half toward the camera",
                   "wardrobe": "",
                   "motion_prompt": "Medium shot, slight handheld. She glances at a phone on the bar, laughs, then snaps a crispy spring roll in half toward the camera; steam escapes from the middle; she points at the lens."},
        "script": [
            L(0, 3, "שאלתם. אני עונה. עם הפה מלא.", "[laughs]", "עונה לתגובות 💬", "medium, LILO picking up the phone at the bar"),
            L(3, 7, "\"לילו, את אמיתית?\" אני דמות AI. אבל הקראנץ' פה אמיתי לגמרי.", "[playfully]", "כן, אני AI 🤖", "medium close-up, LILO to camera"),
            L(7, 10, "", "", "", "macro spring roll snapped in half, crunch, steam escaping"),
            L(10, 15, "שבוע הבא אתם בוחרים: סופר בי או קארי מסמן? בתגובות.", "[excited]", "סופר בי 🥩 או קארי 🍛?", "medium close-up, LILO points at camera"),
            L(15, 17, "נתראה ליד האש.", "[warmly]", "נתראה ליד האש 🔥", "medium, LILO waves"),
        ],
        "caption_he": "תודה על כל התגובות השבוע 🧡\nשבוע הבא אתם מחליטים: סופר בי או קארי מסמן?",
        "cta_he": "כתבו בתגובות — הרוב קובע",
        "hashtags": ["זוזוברה", "אוכלבתלאביב", "springrolls", "ai", "קהילה"],
        "trend_or_audio_note": "Reply-to-comment format; post after Shabbat ends",
    },
]

WEEK = {
    "weekly_focus": "בנגקוק היט וסופר בי החריפים + אווירת ערב דארק-לאקשרי",
    "strategy_summary_he": "פותחים חזק עם אש (ראשון), בונים קשר עם POV (שני), מייצרים שיתופים עם צ'אלנג' (שלישי), "
                           "נותנים ערך לשמירה בקרוסלה (רביעי), דוחפים את חמישי בערב כדייט נייט, ASMR לשישי בצהריים, "
                           "ומסיימים בשבת אחרי צאת השבת בקהילה ובהצבעה שמזינה את השבוע הבא.",
    "days": DAYS,
}

if __name__ == "__main__":
    plan = WeekPlan.model_validate(WEEK)
    (ROOT / "examples" / "week_sample.json").write_text(plan.model_dump_json(indent=2), encoding="utf-8")
    print("ok", len(plan.days), "days")
