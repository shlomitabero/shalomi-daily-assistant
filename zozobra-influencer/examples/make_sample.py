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
        "concept": "פותחים את השבוע ליד הפס של המטבח הפתוח: הבנגקוק היט נולד בווק, בשלושים שניות על אש גבוהה",
        "hook_he": "ככה מתחיל שבוע 🔥",
        "hook_alternatives_he": ["שלושים שניות בווק. זה כל הסוד.", "המנה שהמטבח הפתוח בנוי בשבילה"],
        "visual": {"venue_plate": "open_kitchen", "scene": "at the stainless-steel pass of the open kitchen, the cooking line behind her under the angular metal hood where a cook tosses a wok and a flame bursts, the glowing paper-panel canopy of the bar at the edge of frame",
                   "action": "turning to camera with a confident half-smile, one hand on the pass counter, flame light on her face",
                   "wardrobe": "",
                   "motion_prompt": "Static low angle at the kitchen pass. On the stainless cooking line behind her a cook tosses glossy caramel-chili noodles and a flame bursts up from the wok, lighting her face orange from the side; she turns her head toward the camera and smirks; sparks drift upward; copper lights glow in the bokeh."},
        "script": [
            L(0, 2.5, "תקשיבו לווק.", "[whispers]", "", "macro flame burst in the wok, sizzling sound"),
            L(2.5, 7, "בנגקוק היט. נודלס בקרמל שום וצ'ילי, ונענע טרייה.", "[excited]", "בנגקוק היט 🔥", "medium, LILO to camera at the kitchen pass"),
            L(7, 11, "שלושים שניות על אש גבוהה. זה כל הסוד.", "[confidently]", "30 שניות על אש גבוהה", "macro noodles tossed mid-air, slow motion"),
            L(11, 15.5, "חריף, מתקתק, ומעושן בדיוק במידה.", "[warmly]", "חריף · מתקתק · מעושן 🌶️", "medium close-up, LILO laughing to camera"),
            L(15.5, 18, "זוזוברה. אוכלים, שותים, נשארים.", "[warmly]", "EAT. DRINK. STAY.", "medium, LILO smiles to camera at the kitchen pass"),
        ],
        "caption_he": "שלושים שניות על אש גבוהה. זה כל הסוד 🔥\nבנגקוק היט: נודלס בקרמל שום וצ'ילי, נענע טרייה וסלט מלפפונים.\nחריף רגיל, או חריף באמת?",
        "cta_he": "שמרו לערב הבא שלכם בחוץ",
        "hashtags": ["אוכלבחיפה", "זוזוברה", "אוכלאסייתי", "wok", "foodtok"],
        "trend_or_audio_note": "Original audio: real wok sizzle as the first 2 seconds - no music under the hook",
    },
    {
        "day": "2026-10-19", "weekday_he": "שני", "post_time_local": "19:30", "platforms": ["instagram", "tiktok"],
        "format": "reel", "pillar": "pov_story", "dish_id": "teriyaki_ramen",
        "concept": "POV: יצאת מהמשרד גמור/ה ויש רק דבר אחד שמציל את היום — קערת ראמן",
        "hook_he": "יום ארוך? יש לזה תשובה.",
        "hook_alternatives_he": ["הקערה שמסדרת יום שלם 🍜", "אחרי יום כזה, רק דבר אחד עובד"],
        "visual": {"venue_plate": "booth_row_ribbon", "scene": "the front booth of the booth row, black bolster armchair, candle and a steaming bowl of teriyaki chicken ramen on the wooden table, crimson ribbon sweeping down behind her",
                   "action": "dropping her bag on the stool, exhaling, then lifting noodles with chopsticks and closing her eyes as she tastes",
                   "wardrobe": "oversized black hoodie with copper embroidery",
                   "motion_prompt": "Slow handheld push-in. She drops into the booth armchair, exhales, lifts a bundle of noodles from the steaming broth with chopsticks, blows on them once and eats; noodles sway with weight, broth drips back; steam curls across the frame."},
        "script": [
            L(0, 3, "יום ארוך. באמת ארוך.", "[sighs]", "POV: יום ארוך", "medium, LILO slumps into the booth armchair"),
            L(3, 7, "יש ימים שרק קערה חמה מבינה.", "[playfully]", "", "medium close-up, LILO to camera"),
            L(7, 11, "ראמן טריאקי. ציר עמוק, עוף מזוגג.", "[softly]", "ראמן טריאקי 🍜", "macro slow noodle pull from steaming broth"),
            L(11, 15, "שלוש כפות, והיום מתחיל מחדש.", "[softly]", "", "close-up, LILO eyes closed savoring"),
            L(15, 17.5, "זוזוברה. אוכלים, שותים, נשארים.", "[warmly]", "EAT. DRINK. STAY.", "medium, LILO raises the bowl to camera"),
        ],
        "caption_he": "יש ימים שרק קערה חמה מבינה 🍜\nראמן טריאקי: ציר עמוק, עוף מזוגג ואטריות שנמשכות.\nמה מציל לכם יום ארוך?",
        "cta_he": "תייגו את מי שצריך את זה היום",
        "hashtags": ["ראמן", "אוכלבחיפה", "pov", "comfortfood", "זוזוברה"],
        "trend_or_audio_note": "POV text format; voiceover only, soft lo-fi bed at -20dB",
    },
    {
        "day": "2026-10-20", "weekday_he": "שלישי", "post_time_local": "20:30", "platforms": ["instagram", "tiktok"],
        "format": "reel", "pillar": "challenge", "dish_id": "super_b",
        "concept": "צ'אלנג' חריפות: לילו מנסה את הסופר בי בלי מים לעשר שניות",
        "hook_he": "עשר שניות בלי מים.",
        "hook_alternatives_he": ["הטעות הכי טעימה שעשיתי השבוע", "אמרו לי שאני לא אשרוד את זה"],
        "visual": {"venue_plate": "bar_stools_ribbons", "scene": "on the nearest bar stool at the curved bar, a plate of Super B beef noodles on the stone counter, a full glass of water pushed to the edge, crimson ribbons on the wall behind",
                   "action": "taking a big bite with chopsticks, then freezing with wide eyes, fanning her face and laughing",
                   "wardrobe": "",
                   "motion_prompt": "Medium close-up, slight handheld. She takes a big bite of glossy beef noodles, chews, freezes, eyes widen, then she fans her face with one hand and laughs while her eyes water; ponytail swings; the water glass trembles at the table edge."},
        "script": [
            L(0, 2.5, "עשר שניות בלי מים. מתחילים.", "[excited]", "10 שניות בלי מים 💧❌", "medium close-up, LILO to camera pushing the water glass away"),
            L(2.5, 6, "סופר בי. פילה בקר, קרמל שום, והרבה צ'ילי.", "[confidently]", "סופר בי 🥩🌶️", "macro chopsticks lifting beef strips and noodles"),
            L(6, 10, "אחת... שתיים... שלוש... רגע.", "[gasps]", "⏱️ 3...", "close-up, LILO eyes widening, fanning face"),
            L(10, 14, "הפסדתי. ואני מזמינה את זה שוב.", "[laughs]", "הפסדתי 😂", "medium, LILO grabbing the water glass laughing"),
            L(14, 17, "תייגו את מי שבטוח שהוא מחזיק.", "[mischievously]", "תורכם 👇", "medium close-up, LILO points chopsticks at camera"),
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
        "hook_he": "המנה שכדאי להכיר",
        "hook_alternatives_he": ["תפסיקו להזמין את אותו הדבר", "הקארי שישנה לכם את הצהריים"],
        "visual": {"venue_plate": "dining_hall_ribbons", "scene": "head of the long communal table in the main dining hall, a bowl of golden chicken massaman curry with pumpkin and peanuts, crimson silk fabric ribbons and rust-copper pendants overhead",
                   "action": "holding a spoon above the bowl, smiling at camera, steam rising between them",
                   "wardrobe": "white linen shirt",
                   "motion_prompt": "Static macro: golden curry is spooned over jasmine rice, pumpkin chunks glisten, steam rises slowly."},
        "script": [],
        "caption_he": "קארי מסמן עוף, בשלוש שכבות 🍛\nדלעת שנמסה ברוטב. בוטנים שנותנים קראנץ'. רוטב שמחכה לאורז.\nצוות קארי או צוות נודלס?",
        "cta_he": "שמרו את הפוסט לצהריים של מחר",
        "hashtags": ["קארי", "צהרייםבחיפה", "אוכלאסייתי", "curry", "זוזוברה"],
        "trend_or_audio_note": "",
    },
    {
        "day": "2026-10-22", "weekday_he": "חמישי", "post_time_local": "21:00", "platforms": ["instagram", "tiktok"],
        "format": "reel", "pillar": "night_vibe", "dish_id": "atmosphere",
        "concept": "חמישי בערב: לילו מגיעה לבר, מול המטבח הפתוח. הזמנה לדייט נייט",
        "hook_he": "חמישי בערב. יש לכם תוכניות?",
        "hook_alternatives_he": ["המקום שבו דייט ראשון הופך לשני", "חמישי. 21:00. כאן."],
        "visual": {"venue_plate": "bar_tower_vertical", "scene": "walking between the black slatted screens toward the circular bar under the towering glowing paper-panel canopy, crimson ribbons overhead, reflective concrete floor",
                   "action": "walking toward the open kitchen and glancing back over her shoulder at the camera with a half-smile",
                   "wardrobe": "tailored black blazer over a high-neck black top, black wide-leg trousers, thin gold chain",
                   "motion_prompt": "Smooth gimbal follow from behind. She walks between the black slatted screens toward the glowing tiered backlit paper-panel canopy over the circular bar, then glances back over her shoulder at the camera with a half-smile; warm warm canopy light ahead; diners softly blurred."},
        "script": [
            L(0, 3, "חמישי בערב. יש לכם תוכניות?", "[softly]", "דייט נייט 🖤", "medium, LILO walking between the slatted screens toward the bar"),
            L(3, 7, "קוקטייל ביד, ווקים על האש.", "[warmly]", "", "venue establishing: slow tilt up from the glossy floor to the glowing paper-panel canopy, crimson ribbons drifting"),
            L(7, 11, "תשבו על הבר, מול המטבח. תודו לי אחר כך.", "[playfully]", "שבו על הבר", "medium close-up, LILO glancing over her shoulder"),
            L(11, 14, "זוזוברה. אוכלים, שותים, נשארים.", "[warmly]", "EAT. DRINK. STAY.", "medium, LILO sitting at the bar facing the open kitchen"),
        ],
        "caption_he": "חמישי בערב, על הבר, מול המטבח הפתוח 🖤\nעם מי אתם באים?",
        "cta_he": "שלחו למי שאתם רוצים לקחת",
        "hashtags": ["דייטנייט", "חמישיבערב", "מסעדותבחיפה", "זוזוברה", "nightout"],
        "trend_or_audio_note": "Slow-walk 'follow me' format; dark R&B instrumental, beat drop on the over-the-shoulder glance",
    },
    {
        "day": "2026-10-23", "weekday_he": "שישי", "post_time_local": "12:30", "platforms": ["instagram", "tiktok"],
        "format": "reel", "pillar": "hero_dish", "dish_id": "pad_thai",
        "concept": "ASMR של שישי בצהריים: הפאד תאי מהרגע שהוא נכנס לווק עד הביס הראשון",
        "hook_he": "בלי מילים. רק תקשיבו 🎧",
        "hook_alternatives_he": ["הסאונד הכי טוב בעיר", "שישי בצהריים, בלי מילים"],
        "visual": {"venue_plate": "booth_wall_bar_view", "scene": "the banquette along the hammered wall with black cylinder pendants, a plate of pad thai with lime and crushed peanuts on the table, open kitchen glowing in the back",
                   "action": "squeezing a lime over the plate, then taking the first bite and nodding slowly",
                   "wardrobe": "",
                   "motion_prompt": "Macro sequence: rice noodles hit a smoking wok, tamarind sauce sizzles, a quick flame flares, peanuts rain down, a lime wedge is squeezed with juice droplets; then a medium shot of her taking the first bite and nodding slowly."},
        "script": [
            L(0, 3, "", "", "בלי מילים. רק תקשיבו 🎧", "macro noodles hitting a smoking wok, loud sizzle"),
            L(3, 7, "", "", "", "macro tamarind sauce poured into a smoking wok"),
            L(7, 10, "", "", "", "macro crushed peanuts raining down, lime squeezed"),
            L(10, 14, "זה הסאונד של שישי בצהריים.", "[whispers]", "פאד תאי ✨", "medium close-up, LILO takes a bite and nods"),
            L(14, 16, "זוזוברה. אוכלים, שותים, נשארים.", "[warmly]", "EAT. DRINK. STAY.", "medium, LILO smiling at camera"),
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
        "hook_he": "שאלתם. אני עונה.",
        "hook_alternatives_he": ["קראתי את כל התגובות שלכם 👀", "אתם בוחרים מה אני אוכלת שבוע הבא"],
        "visual": {"venue_plate": "screens_bamboo_square", "scene": "seated in the booth between the black slatted screens, a plate of crispy vegetable spring rolls and a phone propped up showing comments, candlelight, bamboo beside her",
                   "action": "reading from the phone, laughing, snapping a spring roll in half toward the camera",
                   "wardrobe": "",
                   "motion_prompt": "Medium shot, slight handheld. She glances at a phone on the bar, laughs, then snaps a crispy spring roll in half toward the camera; steam escapes from the middle; she points at the lens."},
        "script": [
            L(0, 3, "שאלתם השבוע. אני עונה.", "[laughs]", "עונה לתגובות 💬", "medium, LILO picking up the phone at the bar"),
            L(3, 7, "\"לילו, את אמיתית?\" אני דמות AI. הקראנץ' אמיתי לגמרי.", "[playfully]", "כן, אני AI 🤖", "medium close-up, LILO to camera"),
            L(7, 10, "", "", "", "macro spring roll snapped in half, crunch, steam escaping"),
            L(10, 15, "שבוע הבא אתם בוחרים: סופר בי או קארי מסמן?", "[excited]", "סופר בי 🥩 או קארי 🍛?", "medium close-up, LILO points at camera"),
            L(15, 17, "זוזוברה. אוכלים, שותים, נשארים.", "[warmly]", "EAT. DRINK. STAY.", "medium, LILO smiles and waves"),
        ],
        "caption_he": "תודה על כל התגובות השבוע 🧡\nשבוע הבא אתם מחליטים: סופר בי או קארי מסמן?",
        "cta_he": "כתבו בתגובות — הרוב קובע",
        "hashtags": ["זוזוברה", "אוכלבחיפה", "springrolls", "ai", "קהילה"],
        "trend_or_audio_note": "Reply-to-comment format; post after Shabbat ends",
    },
]

WEEK = {
    "weekly_focus": "בנגקוק היט וסופר בי מהווק + ערב בזוזוברה: EAT. DRINK. STAY.",
    "strategy_summary_he": "פותחים חזק עם אש (ראשון), בונים קשר עם POV (שני), מייצרים שיתופים עם צ'אלנג' (שלישי), "
                           "נותנים ערך לשמירה בקרוסלה (רביעי), דוחפים את חמישי בערב כדייט נייט, ASMR לשישי בצהריים, "
                           "ומסיימים בשבת אחרי צאת השבת בקהילה ובהצבעה שמזינה את השבוע הבא.",
    "days": DAYS,
}

if __name__ == "__main__":
    plan = WeekPlan.model_validate(WEEK)
    (ROOT / "examples" / "week_sample.json").write_text(plan.model_dump_json(indent=2), encoding="utf-8")
    print("ok", len(plan.days), "days")
