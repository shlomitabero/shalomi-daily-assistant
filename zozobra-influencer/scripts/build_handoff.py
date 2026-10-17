"""Builds the publishing handoff page: python scripts/build_handoff.py <out_dir with media/>. Edit STATUS, re-run, republish to the same artifact URL."""
import html, json, sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))
from zozobra.schemas import WeekPlan, Format
from zozobra.compliance import finalize_caption
P = Path(sys.argv[1]); e = html.escape
plan = WeekPlan.model_validate_json((REPO / "examples/week_sample.json").read_text())
venue = {p["id"]: p for p in json.loads((REPO / "assets/venue/venue.json").read_text())["plates"]}
KEY = {"2026-10-18": "sun", "2026-10-19": "mon", "2026-10-20": "tue", "2026-10-21": "wed",
       "2026-10-22": "thu", "2026-10-23": "fri", "2026-10-24": "sat"}
# Status per post: (state, note). state: hold | draft | ready | published
STATUS = {
    "2026-10-18": ("draft", "טיוטה: תמונות סטילס בזום, בלי קול. ממתין להפקה מלאה."),
    "2026-10-19": ("draft", "טיוטה: תמונות סטילס בזום, בלי קול. ממתין להפקה מלאה."),
    "2026-10-20": ("hold", "לא לפרסם: הפנים של לילו בסרטון הזה לא תואמים לפנים המאושרות. ייוצר מחדש."),
    "2026-10-21": ("draft", "קרוסלה: אפשר להכין מראש. התמונות סופיות רק אחרי אימון הפנים."),
    "2026-10-22": ("draft", "טיוטה: תמונות סטילס בזום, בלי קול. ממתין להפקה מלאה."),
    "2026-10-23": ("hold", "לא לפרסם: הפנים של לילו בסרטון הזה לא תואמים לפנים המאושרות. ייוצר מחדש."),
    "2026-10-24": ("draft", "טיוטה. לפרסם רק אחרי צאת השבת."),
}
STATE = {"hold": ("לא לפרסם", "hold"), "draft": ("טיוטה", "draft"), "ready": ("מוכן לפרסום", "ready"), "published": ("פורסם", "done")}
PIL = {"hero_dish": "מנת הדגל", "fire_show": "שואו אש", "night_vibe": "וייב ערב", "challenge": "צ'אלנג'", "pov_story": "POV", "community": "קהילה"}
PLAT = {"instagram": "אינסטגרם", "tiktok": "טיקטוק"}
media = {f.stem: f.name for f in (P / "media").glob("*.mp4")}
files = {}
cards = []
counts = {k: 0 for k in STATE}
for d in plan.days:
    ds = str(d.day); key = KEY[ds]; st, note = STATUS[ds]; counts[st] += 1
    label, cls = STATE[st]
    cap = finalize_caption(d)
    vid = next((v for k, v in media.items() if k.startswith(ds)), None)
    if d.format is Format.reel and vid:
        poster = vid.replace(".mp4", "_poster.jpg")
        files[f"media/{vid}"] = f"media/{vid}"; files[f"media/{poster}"] = f"media/{poster}"
        mediahtml = f'<video controls playsinline preload="none" poster="media/{poster}" src="media/{vid}"></video>'
    else:
        slides = sorted((P / "media").glob("slide_*.jpg"))
        for s in slides: files[f"media/{s.name}"] = f"media/{s.name}"
        mediahtml = '<div class="slides">' + "".join(f'<img src="media/{s.name}" alt="שקופית {i}" loading="lazy">' for i, s in enumerate(slides, 1)) + "</div>"
    zone = venue.get(d.visual.venue_plate, {}).get("zone_he", "")
    plats = " + ".join(PLAT[p] for p in d.platforms)
    cards.append(f"""<article class="post {cls}" id="p{ds}">
<div class="m">{mediahtml}</div>
<div class="b">
<div class="top"><span class="st {cls}">{label}</span><b>{e(d.weekday_he)} {d.day.strftime('%d/%m')} · {e(d.post_time_local)}</b></div>
<div class="chips"><span>{plats}</span><span>{'רילס' if d.format is Format.reel else 'קרוסלה'}</span><span>{PIL[d.pillar.value]}</span>{f'<span>📍 {e(zone)}</span>' if zone else ''}</div>
<p class="note">{e(note)}</p>
<h3>{e(d.hook_he)}</h3>
<div class="caphead"><span>הכיתוב לפרסום (כולל האשטגים וגילוי נאות)</span><button type="button" class="copy" data-target="c{ds}">העתק כיתוב</button></div>
<pre id="c{ds}">{e(cap)}</pre>
<ul class="check">
<li>לסמן <b>"תוכן שנוצר ב-AI"</b> {'(אינסטגרם: הגדרות מתקדמות → תווית AI)' if 'instagram' in d.platforms else ''}{' · (טיקטוק: AI-generated content)' if 'tiktok' in d.platforms else ''}</li>
<li>לסמן <b>שיתוף פעולה בתשלום</b> עם ZOZOBRA (Paid partnership / Branded content)</li>
<li>לא למחוק את השורות "#פרסומת" ו"דמות וירטואלית AI"</li>
<li>לפרסם בשעה {e(d.post_time_local)} ולענות לתגובות בשעה הראשונה</li>
</ul></div></article>""")
now = datetime.now(ZoneInfo("Asia/Jerusalem")).strftime("%d/%m/%Y %H:%M")
page = f"""<title>LILO × ZOZOBRA</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;900&family=Assistant:wght@400;600&display=swap">
<style>
/* Layout: one dark column per post (media | details), restaurant-at-night palette; status colors are semantic */
:root{{--bg:#0d0b09;--panel:#171410;--line:#2b251d;--ink:#f2ebe0;--mute:#a69a89;--amber:#e3a35c;--amber-ink:#1a1006;
--hold:#e0564e;--draft:#d9a441;--ready:#5fb98a;--display:"Heebo",Arial,sans-serif;--body:"Assistant","Heebo",Arial,sans-serif;color-scheme:dark}}
body{{background:var(--bg);color:var(--ink);font:16px/1.6 var(--body);direction:rtl}}
.wrap{{max-width:1080px;margin:0 auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:24px 64px}}
header h1{{font:900 clamp(30px,6vw,52px)/1.05 var(--display);margin:0}} header h1 span{{color:var(--amber)}}
.sub{{color:var(--mute);margin:8px 0 0;max-width:68ch}}
.upd{{display:inline-block;margin-top:12px;font-size:14px;border:1px solid var(--line);border-radius:99px;padding:3px 12px;color:var(--mute);font-variant-numeric:tabular-nums}}
.summary{{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0}}
.summary div{{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 16px;min-width:120px}}
.summary b{{display:block;font:900 26px var(--display)}} .summary span{{color:var(--mute);font-size:14px}}
.rules{{background:var(--panel);border:1px solid var(--line);border-inline-start:3px solid var(--amber);border-radius:10px;padding:12px 16px;max-width:80ch}}
.rules h2{{font:700 18px var(--display);margin:0 0 6px}} .rules ul{{margin:0;padding-inline-start:20px}}
.posts{{display:flex;flex-direction:column;gap:18px;margin-top:26px}}
.post{{display:grid;grid-template-columns:300px minmax(0,1fr);border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--panel)}}
.post.hold{{border-color:color-mix(in srgb,var(--hold) 55%,var(--line))}}
.m{{background:#000;display:flex;align-items:flex-start;justify-content:center}} .m video{{width:100%;aspect-ratio:9/16;display:block;background:#000}}
.slides{{display:flex;flex-direction:column;gap:2px;width:100%}} .slides img{{width:100%;display:block}}
.b{{padding:16px 18px;min-width:0}}
.top{{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:17px}}
.st{{font:700 13px var(--display);padding:2px 10px;border-radius:99px;color:var(--amber-ink)}} .st.hold{{background:var(--hold);color:#fff}} .st.draft{{background:var(--draft)}} .st.ready,.st.done{{background:var(--ready)}}
.chips{{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}} .chips span{{border:1px solid var(--line);border-radius:99px;padding:1px 10px;font-size:13px;color:var(--mute)}}
.note{{margin:6px 0;font-size:14px;color:var(--mute)}} .post.hold .note{{color:var(--hold);font-weight:600}}
h3{{font:800 19px/1.35 var(--display);margin:8px 0;text-wrap:balance}}
.caphead{{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--mute);margin-top:10px}}
pre{{white-space:pre-wrap;font:15px/1.6 var(--body);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:6px 0 0;user-select:all}}
button{{font:700 14px var(--display);background:var(--amber);color:var(--amber-ink);border:0;border-radius:9px;padding:7px 14px;cursor:pointer}}
button:focus-visible{{outline:2px solid var(--ink);outline-offset:2px}}
.check{{margin:12px 0 0;padding-inline-start:20px;font-size:14px;color:var(--mute)}} .check b{{color:var(--ink)}}
footer{{color:var(--mute);font-size:13px;margin-top:36px;max-width:75ch}}
@media (max-width:760px){{.post{{grid-template-columns:1fr}} .m video{{max-height:80vh;width:auto;max-width:100%}}}}
</style>
<div class="wrap">
<header><h1>LILO <span>×</span> ZOZOBRA</h1>
<p class="sub">תיק פרסום שבועי למי שמפרסם: כל פוסט עם הסרטון, הכיתוב המוכן להעתקה, השעה והסטטוס. הדף מתעדכן כל פעם שיש שינוי, ותמיד באותו קישור.</p>
<span class="upd">עודכן לאחרונה: {now}</span></header>
<div class="summary"><div><b>{counts['ready']}</b><span>מוכנים לפרסום</span></div><div><b>{counts['draft']}</b><span>טיוטות</span></div><div><b>{counts['hold']}</b><span>לא לפרסם</span></div><div><b>{counts['published']}</b><span>פורסמו</span></div></div>
<section class="rules"><h2>כללים לכל פוסט</h2><ul>
<li>מפרסמים רק פוסט במצב <b>"מוכן לפרסום"</b>. טיוטה נועדה רק להכנה.</li>
<li>תמיד מסמנים "תוכן שנוצר ב-AI" ו"שיתוף פעולה בתשלום" עם ZOZOBRA.</li>
<li>לא מוחקים מהכיתוב את "#פרסומת" ואת "דמות וירטואלית AI". זו חובה לפי החוק ולפי כללי הרשתות.</li>
<li>תלונות, שאלות על אלרגיות או כשרות והזמנות מעבירים לצוות המסעדה. לא עונים עליהן בשם לילו.</li>
<li>אם שואלים "את אמיתית?", התשובה היא שלילו היא דמות וירטואלית.</li></ul></section>
<div class="posts">{''.join(cards)}</div>
<footer>כרגע כל הסרטונים הם טיוטות: תמונות סטילס בתנועת מצלמה עם כתוביות, בלי קול. ההפקה המלאה, עם תנועה, קול ופנים קבועות, תחליף אותם כאן באותו קישור. התפריט מבוסס על הדפים הציבוריים של ZOZOBRA בוולט, ויש לאמת אותו מול המסעדה.</footer>
</div>
<script>
document.querySelectorAll("button.copy").forEach(function(b){{
  b.addEventListener("click",function(){{
    var el=document.getElementById(b.dataset.target), t=el.textContent, done=function(){{b.textContent="הועתק ✓";setTimeout(function(){{b.textContent="העתק כיתוב"}},1800)}};
    try{{navigator.clipboard.writeText(t).then(done,function(){{sel(el);b.textContent="מסומן — העתק ידנית"}})}}catch(err){{sel(el);b.textContent="מסומן — העתק ידנית"}}
  }});
}});
function sel(el){{var r=document.createRange();r.selectNodeContents(el);var s=window.getSelection();s.removeAllRanges();s.addRange(r)}}
</script>"""
(P / "lilo_preview.html").write_text(page, encoding="utf-8")
(P / "files.json").write_text(json.dumps(files, ensure_ascii=False))
print(len(page), len(files))
