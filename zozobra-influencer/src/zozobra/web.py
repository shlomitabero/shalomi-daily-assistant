"""Hebrew control panel for LILO - everything from the browser, no command line.

    uvicorn zozobra.web:app --host 0.0.0.0 --port 8000      (or: python -m zozobra.web)

Set PANEL_PASSWORD before exposing it to the internet (HTTP Basic, user: lilo).
"""
from __future__ import annotations

import base64
import html
import json
import secrets
from contextlib import asynccontextmanager
from datetime import date, timedelta
from pathlib import Path

from fastapi import FastAPI, Form, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response

from . import jobs, persona
from .config import ROOT, runtime, save_runtime, settings

def _seed_sample_week() -> None:
    """Fresh install: show the sample week so the panel never opens empty, and install LILO's
    approved anchor face (assets/lilo/R0_anchor.jpg) so the setup wizard starts at step 2."""
    if not any(cal_dir().glob("week_*.json")):
        setup_sample()
    anchor = settings().data_dir / "refs" / "R0_anchor.png"
    bundled = ROOT / "assets" / "lilo" / "R0_anchor.jpg"
    if not anchor.exists() and bundled.exists():
        from PIL import Image

        anchor.parent.mkdir(parents=True, exist_ok=True)
        Image.open(bundled).convert("RGB").save(anchor)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _seed_sample_week()
    scheduler = jobs.Scheduler(_scheduled_publish, _scheduled_metrics, _scheduled_plan)
    scheduler.start()
    yield
    scheduler.stop.set()


app = FastAPI(title="LILO × ZOZOBRA", lifespan=lifespan)
e = lambda v: html.escape(str(v if v is not None else ""))

STATUS_HE = {"pending": "ממתין לאישור", "approved": "מאושר", "published": "פורסם", "rejected": "נדחה",
             "running": "רץ…", "done": "הסתיים", "failed": "נכשל"}
PILLAR_HE = {"hero_dish": "מנת הדגל", "fire_show": "שואו אש", "night_vibe": "וייב ערב", "challenge": "צ'אלנג'",
             "pov_story": "POV / סטוריטיים", "community": "קהילה"}


# ---------- auth ----------
@app.middleware("http")
async def basic_auth(request: Request, call_next):
    pw = settings().panel_password
    if pw and request.url.path != "/healthz" and not request.url.path.startswith("/pub/"):
        header = request.headers.get("authorization", "")
        ok = False
        if header.startswith("Basic "):
            try:
                user, _, given = base64.b64decode(header[6:]).decode().partition(":")
                ok = secrets.compare_digest(given, pw)
            except ValueError:
                ok = False
        if not ok:
            return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="LILO"'})
    return await call_next(request)


@app.get("/healthz")
def healthz():
    return {"ok": True}


# ---------- layout ----------
CSS = """
@font-face{font-family:Heebo;src:url(/fonts/Heebo-Black.ttf);font-weight:900}
:root{--bg:#0b0a09;--card:#15130f;--line:#2a251d;--ink:#f3ede4;--mute:#a59b8c;--cu:#d08a4b;--cu2:#f0a35e;
--red:#e0473b;--ok:#4caf7d;--warn:#e0a83b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,"Segoe UI",Arial,sans-serif}
a{color:var(--cu2)}header{display:flex;gap:18px;align-items:center;flex-wrap:wrap;padding:14px 20px;
border-bottom:1px solid var(--line);background:#0f0d0b;position:sticky;top:0;z-index:5}
.logo{font-family:Heebo;font-weight:900;font-size:22px;letter-spacing:.5px}.logo b{color:var(--cu)}
nav a{color:var(--mute);text-decoration:none;margin-inline-end:14px;white-space:nowrap;display:inline-block}nav a.on,nav a:hover{color:var(--ink)}
main{max-width:1100px;margin:0 auto;padding:22px 16px 80px}h1{font-family:Heebo;font-weight:900;font-size:28px;margin:6px 0 18px}
h2{font-size:19px;margin:26px 0 10px;color:var(--cu2)}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr))}
.btn{display:inline-block;background:var(--cu);color:#120d08;border:0;border-radius:10px;padding:9px 16px;font-weight:700;cursor:pointer;text-decoration:none;font-size:15px}
.btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}.btn.red{background:var(--red);color:#fff}
.btn:disabled{opacity:.4;cursor:not-allowed}
input,textarea,select{width:100%;background:#0f0d0b;color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit}
textarea{min-height:110px}label{display:block;color:var(--mute);font-size:14px;margin:10px 0 4px}
.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:13px;border:1px solid var(--line);color:var(--mute)}
.pill.ok{color:var(--ok);border-color:#24533b}.pill.warn{color:var(--warn);border-color:#5a4520}.pill.bad{color:var(--red);border-color:#5a2420}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.mute{color:var(--mute);font-size:14px}
pre{white-space:pre-wrap;background:#0f0d0b;border:1px solid var(--line);border-radius:10px;padding:10px;font-size:13px;direction:ltr;text-align:left;overflow:auto}
pre.he{direction:rtl;text-align:right;font-family:inherit;font-size:15px}
video,img.media{width:100%;max-width:360px;border-radius:12px;border:1px solid var(--line);background:#000}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:8px;text-align:right;vertical-align:top}
.check{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--line)}.check:last-child{border:0}
.thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}.thumbs img{width:100%;border-radius:10px}
.banner{background:#2a1d10;border:1px solid #5a4520;border-radius:12px;padding:10px 14px;margin-bottom:16px}
"""

NAV = [("/", "לוח בקרה"), ("/plan", "תכנון שבועי"), ("/calendars", "לוחות תוכן"), ("/replies", "תגובות"),
       ("/insights", "ביצועים"), ("/menu", "תפריט"), ("/venue", "המקום"), ("/setup", "הקמה")]


def page(title: str, body: str, path: str = "/", refresh: bool = False) -> HTMLResponse:
    s = settings()
    nav = "".join(f'<a href="{h}" class="{"on" if h == path else ""}">{t}</a>' for h, t in NAV)
    running = any(j["status"] == "running" for j in jobs.JOBS.values())
    meta = '<meta http-equiv="refresh" content="8">' if (refresh or running) else ""
    banner = ('<div class="banner">🧪 מצב בדיקה פעיל (DRY_RUN) — שום דבר לא נשלח לרשתות ולא מחויב קרדיט. '
              'כשהכול ירוק בלשונית "הקמה", הגדר <code>DRY_RUN=false</code>.</div>') if s.dry_run else ""
    job_html = "".join(
        f'<div class="row mute"><span class="pill {"ok" if j["status"]=="done" else "bad" if j["status"]=="failed" else "warn"}">'
        f'{STATUS_HE[j["status"]]}</span> {e(j["title"])} · {e(j["started"])}'
        f'{" — " + e(j["error"]) if j["error"] else ""}{" — " + e(j["result"][:160]) if j["status"]=="done" and j["result"] else ""}</div>'
        for j in jobs.recent(6))
    jobs_box = f'<div class="card"><b>משימות רקע</b>{job_html}</div>' if job_html else ""
    return HTMLResponse(f"""<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">{meta}<title>{e(title)} · LILO</title>
<style>{CSS}</style></head><body><header><div class="logo">LILO <b>×</b> ZOZOBRA</div><nav>{nav}</nav></header>
<main>{banner}<h1>{e(title)}</h1>{jobs_box}{body}</main></body></html>""")


def back(url: str) -> RedirectResponse:
    return RedirectResponse(url, status_code=303)


# ---------- files ----------
@app.get("/fonts/{name}")
def fonts(name: str):
    path = (ROOT / "assets" / "fonts" / name).resolve()
    if path.parent != (ROOT / "assets" / "fonts").resolve() or not path.exists():
        return Response(status_code=404)
    return FileResponse(path)


@app.get("/venue-img/{name}")
def venue_img(name: str):
    from .venue import VENUE_DIR

    path = (VENUE_DIR / name).resolve()
    if path.parent != VENUE_DIR.resolve() or path.suffix.lower() not in {".jpg", ".png"} or not path.exists():
        return Response(status_code=404)
    return FileResponse(path)


@app.get("/pub/{token}/{rel:path}")
def public_media(token: str, rel: str):
    """Token-protected public file URLs for the media APIs (fal fetches inputs from here)."""
    s = settings()
    if not s.media_token or not secrets.compare_digest(token, s.media_token):
        return Response(status_code=404)
    base = s.data_dir.resolve()
    path = (base / rel).resolve()
    if base not in path.parents or not path.is_file():
        return Response(status_code=404)
    return FileResponse(path)


@app.get("/media/{rel:path}")
def media(rel: str):
    base = settings().data_dir.resolve()
    path = (base / rel).resolve()
    if base not in path.parents or not path.is_file():
        return Response(status_code=404)
    return FileResponse(path)


def media_url(path: str | Path) -> str:
    try:
        return "/media/" + str(Path(path).resolve().relative_to(settings().data_dir.resolve()))
    except ValueError:
        return ""


# ---------- queue helpers ----------
def queue_dir() -> Path:
    return settings().data_dir / "queue"


def queue_items() -> list[dict]:
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(queue_dir().glob("*.json"))]


def save_item(item: dict) -> None:
    queue_dir().mkdir(parents=True, exist_ok=True)
    (queue_dir() / f"{item['day']}.json").write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8")


def ensure_disclosures(caption: str) -> str:
    """Edits may change wording - never remove the legal labels."""
    for line in (persona.AD_DISCLOSURE_HE, persona.AI_DISCLOSURE_HE):
        if line not in caption:
            caption = caption.rstrip() + "\n" + line
    return caption


def item_card(it: dict, full: bool = False) -> str:
    status = it.get("status", "pending")
    cls = {"approved": "ok", "published": "ok", "rejected": "bad"}.get(status, "warn")
    preview = ""
    if it.get("media_path") and Path(it["media_path"]).exists():
        preview = f'<video src="{media_url(it["media_path"])}" controls playsinline preload="metadata"></video>'
    elif it.get("image_paths"):
        preview = "".join(f'<img class="media" src="{media_url(p)}">' for p in it["image_paths"][:1 if not full else 10])
    else:
        preview = '<div class="mute">עדיין אין מדיה (הופק במצב בדיקה)</div>'
    pub = " · ".join(f"{k}: {v}" for k, v in it.get("published", {}).items())
    return f"""<div class="card"><div class="row"><b>{e(it['day'])} · {e(it['post_time'])}</b>
<span class="pill {cls}">{STATUS_HE.get(status, status)}</span><span class="pill">{e(it['format'])}</span>
<span class="pill">{e(PILLAR_HE.get(it['pillar'], it['pillar']))}</span><span class="pill">{e(' + '.join(it['platforms']))}</span></div>
<p><b>הוק:</b> {e(it['hook'])}</p>{preview}
{'' if full else f'<p><a class="btn ghost" href="/queue/{e(it["day"])}">פתח ואשר ←</a></p>'}
{f'<p class="mute">פורסם: {e(pub)}</p>' if pub else ''}</div>"""


# ---------- dashboard ----------
@app.get("/", response_class=HTMLResponse)
def dashboard():
    from .doctor import run

    checks = run()
    missing = [c for c in checks if c.required and not c.ok]
    items = queue_items()
    upcoming = [i for i in items if i["day"] >= (date.today() - timedelta(days=1)).isoformat()]
    pending = [i for i in upcoming if i.get("status") == "pending"]
    setup = (f'<div class="card">⚙️ חסרים {len(missing)} דברים להפעלה מלאה: '
             f'{e(", ".join(c.title for c in missing))} — <a href="/setup">להשלמה</a></div>') if missing else \
        '<div class="card"><span class="pill ok">✓ כל ההגדרות תקינות</span></div>'
    cards = "".join(item_card(i) for i in upcoming) or \
        '<div class="card">אין עדיין פוסטים בתור. התחל ב-<a href="/plan">תכנון שבועי</a>.</div>'
    hero = ('<div class="card" style="padding:0;overflow:hidden;position:relative;height:180px;'
            'background:url(/venue-img/dining_hall_ribbons.jpg) center/cover">'
            '<div style="position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(11,10,9,.85))"></div>'
            '<div style="position:absolute;right:20px;bottom:16px"><div class="logo">LILO <b>×</b> ZOZOBRA</div>'
            '<div class="mute">נתראה ליד האש 🔥</div></div></div>')
    return page("לוח בקרה", f"""{hero}{setup}
<div class="grid"><div class="card"><div class="mute">ממתינים לאישור שלך</div><h1>{len(pending)}</h1></div>
<div class="card"><div class="mute">בתור (השבוע)</div><h1>{len(upcoming)}</h1></div>
<div class="card"><div class="mute">פורסמו</div><h1>{sum(i.get('status')=='published' for i in items)}</h1></div></div>
<h2>הפוסטים הקרובים</h2><div class="grid">{cards}</div>""")


# ---------- planning ----------
@app.get("/plan", response_class=HTMLResponse)
def plan_form():
    rt = runtime()
    start = (date.today() + timedelta(days=1)).isoformat()
    auto = "checked" if rt.get("auto_plan") else ""
    return page("תכנון שבועי", f"""<form class="card" method="post" action="/plan">
<label>על מה השבוע? (פוקוס)</label>
<textarea name="focus" required placeholder="לדוגמה: בנגקוק היט החריף + אווירת ערב דארק-לאקשרי, יום חמישי = דייט נייט">{e(rt.get('focus', ''))}</textarea>
<label>תאריך התחלה</label><input type="date" name="start" value="{start}">
<label><input type="checkbox" name="auto" value="1" {auto} style="width:auto"> לתכנן אוטומטית כל יום ראשון ב-10:00 עם הפוקוס הזה + הלקחים מהביצועים</label>
<p><button class="btn">✨ צור תוכנית ל-7 ימים</button></p>
<p class="mute">Claude כותב תסריטים בעברית, הוקים, כיתובים, האשטגים ופרומפטים לתמונה/וידאו — רק על מנות שבתפריט. לוקח 1-3 דקות.</p>
</form>""", "/plan")


def _plan_job(focus: str, start: date) -> str:
    from .analytics import weekly_insights
    from .brain import generate_week, save

    return f"נשמר: {save(generate_week(focus, start, insights=weekly_insights() or None)).name}"


@app.post("/plan")
def plan_submit(focus: str = Form(...), start: str = Form(...), auto: str = Form("")):
    save_runtime(focus=focus, auto_plan=bool(auto))
    jobs.submit("יצירת תוכנית שבועית", _plan_job, focus, date.fromisoformat(start))
    return back("/calendars")


# ---------- calendars ----------
def cal_dir() -> Path:
    return settings().data_dir / "calendars"


@app.get("/calendars", response_class=HTMLResponse)
def calendars():
    files = sorted(cal_dir().glob("week_*.json"), reverse=True)
    rows = "".join(f'<div class="card row"><b>{e(f.stem.replace("week_", "שבוע מ-"))}</b>'
                   f'<a class="btn ghost" href="/calendars/{e(f.stem)}">פתח</a></div>' for f in files)
    return page("לוחות תוכן", rows or '<div class="card">עוד אין. <a href="/plan">צור תוכנית ראשונה</a> '
                '(או טען את הדוגמה בלשונית "הקמה").</div>', "/calendars")


@app.get("/calendars/{stem}", response_class=HTMLResponse)
def calendar_view(stem: str):
    from .brain import full_image_prompt
    from .compliance import finalize_caption
    from .schemas import WeekPlan

    path = cal_dir() / f"{Path(stem).name}.json"
    if not path.exists():
        return page("לא נמצא", "", "/calendars")
    plan = WeekPlan.model_validate_json(path.read_text(encoding="utf-8"))
    queued = {i["day"]: i for i in queue_items()}
    days = []
    for d in plan.days:
        q = queued.get(d.day.isoformat())
        script = "".join(f"<tr><td>{l.t_start:.0f}-{l.t_end:.0f}s</td><td>{e(l.spoken_he)}</td><td>{e(l.voice_direction)}</td>"
                         f"<td>{e(l.on_screen_text_he)}</td><td class='mute'>{e(l.shot)}</td></tr>" for l in d.script)
        action = (f'<a class="btn ghost" href="/queue/{d.day}">בתור: {STATUS_HE.get(q["status"], q["status"])}</a>' if q else "") + \
            f'<form method="post" action="/calendars/{e(stem)}/produce" style="display:inline"><input type="hidden" name="day" value="{d.day}">' \
            f'<button class="btn">🎬 הפק {"מחדש" if q else ""}</button></form>'
        days.append(f"""<div class="card"><div class="row"><b>{e(d.weekday_he)} {d.day} · {e(d.post_time_local)}</b>
<span class="pill">{e(d.format.value)}</span><span class="pill">{e(PILLAR_HE.get(d.pillar.value, d.pillar.value))}</span>
<span class="pill">{e(d.dish_id)}</span></div>
{venue_thumb(d.visual.venue_plate)}<p><b>{e(d.concept)}</b></p><p>🎣 <b>הוק:</b> {e(d.hook_he)} <span class="mute">| A/B: {e(' | '.join(d.hook_alternatives_he))}</span></p>
<table><tr><th>זמן</th><th>מה היא אומרת</th><th>קול</th><th>טקסט על המסך</th><th>שוט</th></tr>{script}</table>
<details><summary class="mute">פרומפטים (תמונה / תנועה)</summary><pre>{e(full_image_prompt(d))}</pre><pre>{e(d.visual.motion_prompt)}</pre></details>
<label>כיתוב (כולל גילוי נאות אוטומטי)</label><pre class="he">{e(finalize_caption(d))}</pre>
<div class="row">{action}</div></div>""")
    return page(f"שבוע {plan.days[0].day}", f"""<div class="card"><b>{e(plan.weekly_focus)}</b><p>{e(plan.strategy_summary_he)}</p>
<form method="post" action="/calendars/{e(stem)}/produce"><button class="btn">🎬 הפק את כל השבוע</button></form></div>{''.join(days)}""", "/calendars")


def venue_thumb(plate_id: str) -> str:
    from .venue import plate, plate_ids

    if plate_id not in plate_ids():
        return ""
    p = plate(plate_id)
    return (f'<div class="row mute" style="margin:8px 0"><img src="/venue-img/{e(p["file"])}" '
            f'style="height:56px;border-radius:8px;border:1px solid var(--line)"> 📍 {e(p["zone_he"])}</div>')


def _produce_job(stem: str, day: str | None) -> str:
    from .brain import load_menu
    from .pipeline import produce_day
    from .schemas import WeekPlan

    s = settings()
    plan = WeekPlan.model_validate_json((cal_dir() / f"{stem}.json").read_text(encoding="utf-8"))
    menu, done = load_menu(), []
    for d in plan.days:
        if day and d.day.isoformat() != day:
            continue
        produce_day(d, menu, s.data_dir / "renders" / d.day.isoformat(), s.dry_run)
        done.append(d.day.isoformat())
    return "הופקו: " + ", ".join(done)


@app.post("/calendars/{stem}/produce")
def produce(stem: str, day: str = Form("")):
    stem = Path(stem).name
    jobs.submit(f"הפקה {day or 'כל השבוע'}", _produce_job, stem, day or None)
    return back(f"/calendars/{stem}")


# ---------- queue / approval ----------
@app.get("/queue/{day}", response_class=HTMLResponse)
def queue_view(day: str):
    path = queue_dir() / f"{Path(day).name}.json"
    if not path.exists():
        return page("לא נמצא", "", "/")
    it = json.loads(path.read_text(encoding="utf-8"))
    locked = it.get("status") == "published"
    return page(f"פוסט {day}", item_card(it, full=True) + f"""
<form class="card" method="post" action="/queue/{e(day)}/save">
<label>כיתוב (אפשר לערוך — שורות הגילוי הנאות יישמרו תמיד)</label>
<textarea name="caption" style="min-height:220px" {'disabled' if locked else ''}>{e(it['caption'])}</textarea>
<label>שעת פרסום</label><input name="post_time" value="{e(it['post_time'])}" pattern="[0-2][0-9]:[0-5][0-9]" {'disabled' if locked else ''}>
<div class="row" style="margin-top:12px">
<button class="btn" name="action" value="approve" {'disabled' if locked else ''}>✅ שמור ואשר לפרסום</button>
<button class="btn ghost" name="action" value="save" {'disabled' if locked else ''}>שמור בלי לאשר</button>
<button class="btn red" name="action" value="reject" {'disabled' if locked else ''}>דחה</button></div>
<p class="mute">צפה בסרטון עד הסוף לפני אישור: שם מנה נכון, אין טקסט שגוי, הפנים שלה עקביים.</p></form>
<details class="card"><summary>פרטים טכניים</summary><pre>{e(json.dumps(it.get('steps', {}), ensure_ascii=False, indent=2))}</pre></details>""")


@app.post("/queue/{day}/save")
def queue_save(day: str, caption: str = Form(...), post_time: str = Form(...), action: str = Form("save")):
    path = queue_dir() / f"{Path(day).name}.json"
    it = json.loads(path.read_text(encoding="utf-8"))
    if it.get("status") != "published":
        it["caption"] = ensure_disclosures(caption.replace("\r\n", "\n"))
        it["post_time"] = post_time
        it["status"] = {"approve": "approved", "reject": "rejected"}.get(action, it.get("status", "pending"))
        save_item(it)
    return back(f"/queue/{day}")


# ---------- replies ----------
def reply_path() -> Path:
    return settings().data_dir / "reply_queue.jsonl"


def load_replies() -> list[dict]:
    p = reply_path()
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()] if p.exists() else []


def save_replies(rows: list[dict]) -> None:
    reply_path().write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


@app.get("/replies", response_class=HTMLResponse)
def replies():
    rows = load_replies()
    act = {"reply": "לענות", "escalate": "⚠️ להעביר לאדם", "hide_suggest": "🚫 להסתיר?", "ignore": "להתעלם"}
    cards = "".join(f"""<form class="card" method="post" action="/replies/{i}">
<div class="row"><span class="pill {'bad' if r['action']=='escalate' else ''}">{act.get(r['action'], r['action'])}</span>
<span class="pill">{STATUS_HE.get(r['status'], r['status'])}</span><span class="mute">{e(r.get('reason', ''))}</span></div>
<p class="mute">תגובה {e(r['comment_id'])}{(': ' + e(r['text'])) if r.get('text') else ''}</p>
<textarea name="text" style="min-height:60px">{e(r['reply_he'])}</textarea>
<div class="row" style="margin-top:8px"><button class="btn" name="do" value="send" {'disabled' if r['status']!='pending' else ''}>שלח תשובה</button>
<button class="btn ghost" name="do" value="dismiss" {'disabled' if r['status']!='pending' else ''}>בטל</button></div></form>"""
                    for i, r in enumerate(rows) if r["status"] == "pending")
    published = [i for i in queue_items() if i.get("published", {}).get("instagram")]
    options = "".join(f'<option value="{e(i["published"]["instagram"])}|{e(i["hook"])}">{e(i["day"])} — {e(i["hook"])}</option>' for i in published)
    return page("תגובות", f"""<form class="card" method="post" action="/replies/fetch"><label>משוך תגובות מפוסט אינסטגרם וטיוט תשובות</label>
<select name="media">{options or '<option value="">אין עדיין פוסטים שפורסמו</option>'}</select>
<p><button class="btn" {'disabled' if not options else ''}>📥 משוך ונסח</button></p>
<p class="mute">לילו עונה בקצרה ובקול שלה. תלונות, אלרגיות, כשרות והזמנות — מסומנים להעברה לצוות ולא נענים אוטומטית.</p></form>
{cards or '<div class="card mute">אין תגובות שממתינות.</div>'}""", "/replies")


def _fetch_replies(media_id: str, context: str) -> str:
    from .engagement import draft_replies, ig_comments

    comments = ig_comments(media_id)
    known = {r["comment_id"] for r in load_replies()}
    fresh = [c for c in comments if c["id"] not in known]
    texts = {c["id"]: c["text"] for c in fresh}
    rows = load_replies() + [{**d, "media_id": media_id, "status": "pending", "text": texts.get(d["comment_id"], "")}
                             for d in draft_replies(fresh, context)]
    save_replies(rows)
    return f"{len(fresh)} תגובות חדשות"


@app.post("/replies/fetch")
def replies_fetch(media: str = Form("")):
    if media:
        media_id, _, context = media.partition("|")
        jobs.submit("משיכת תגובות", _fetch_replies, media_id, context)
    return back("/replies")


@app.post("/replies/{idx}")
def reply_action(idx: int, text: str = Form(""), do: str = Form("dismiss")):
    rows = load_replies()
    r = rows[idx]
    if r["status"] == "pending":
        if do == "send" and text.strip():
            if settings().dry_run:
                r["status"], r["reply_he"] = "done", text
            else:
                from .engagement import send_ig_reply

                send_ig_reply(r["comment_id"], text)
                r["status"], r["reply_he"] = "done", text
        else:
            r["status"] = "rejected"
        save_replies(rows)
    return back("/replies")


# ---------- insights ----------
@app.get("/insights", response_class=HTMLResponse)
def insights():
    from .analytics import LATEST, db, score, weekly_insights

    conn = db()
    rows = [dict(r) for r in conn.execute(LATEST).fetchall()]
    rows.sort(key=lambda r: score(r["views"], r["likes"], r["comments"], r["shares"], r["saves"]), reverse=True)
    table = "".join(f"<tr><td>{e(r['day'])}</td><td>{e(r['platform'])}</td><td>{e(PILLAR_HE.get(r['pillar'], r['pillar']))}</td>"
                    f"<td>{e(r['hook'])}</td><td>{r['views']:,}</td><td>{r['likes']:,}</td><td>{r['comments']:,}</td>"
                    f"<td>{r['shares']:,}</td><td>{r['saves']:,}</td><td><b>{score(r['views'], r['likes'], r['comments'], r['shares'], r['saves']):.3f}</b></td></tr>"
                    for r in rows)
    return page("ביצועים", f"""<form method="post" action="/insights/refresh" class="card row"><button class="btn">🔄 רענן נתונים עכשיו</button>
<span class="mute">מתרענן אוטומטית כל לילה ב-02:30. הציון = (לייקים + 2×תגובות + 4×שיתופים + 3×שמירות) / צפיות</span></form>
<div class="card"><table><tr><th>יום</th><th>רשת</th><th>עמוד תוכן</th><th>הוק</th><th>צפיות</th><th>לייקים</th><th>תגובות</th><th>שיתופים</th><th>שמירות</th><th>ציון</th></tr>
{table or '<tr><td colspan=10 class="mute">אין עדיין נתונים — יופיעו אחרי הפרסומים הראשונים.</td></tr>'}</table></div>
<h2>מה המוח לומד לשבוע הבא</h2><pre>{e(weekly_insights(conn) or '—')}</pre>""", "/insights")


def _metrics_job() -> str:
    from .analytics import db, refresh

    return f"עודכנו {refresh(db())} פוסטים"


@app.post("/insights/refresh")
def insights_refresh():
    jobs.submit("רענון נתונים", _metrics_job)
    return back("/insights")


# ---------- menu ----------
@app.get("/menu", response_class=HTMLResponse)
def menu_view(error: str = ""):
    from .brain import load_menu

    menu = load_menu()
    rows = "".join(f"<tr><td><b>{e(d['name_he'])}</b><div class='mute'>{e(d['id'])}</div></td><td>{e(d.get('desc', ''))}</td>"
                   f"<td>{'🌶️' * int(d.get('spice', 0))}</td></tr>" for d in menu.get("dishes", []))
    return page("תפריט", f"""{f'<div class="banner">{e(error)}</div>' if error else ''}
<div class="card"><p class="mute">לילו מורשית להזכיר רק מנות שמופיעות כאן. המחירים לא נכתבים בכוונה. לפני עלייה לאוויר — לאמת מול המסעדה.</p>
<table><tr><th>מנה</th><th>תיאור</th><th>חריפות</th></tr>{rows}</table></div>
<form class="card" method="post" action="/menu"><label>עריכה מתקדמת (JSON)</label>
<textarea name="menu" style="min-height:420px;direction:ltr;text-align:left;font-family:monospace;font-size:13px">{e(json.dumps(menu, ensure_ascii=False, indent=2))}</textarea>
<p><button class="btn">שמור תפריט</button></p></form>""", "/menu")


@app.post("/menu")
def menu_save(menu: str = Form(...)):
    try:
        data = json.loads(menu)
        assert isinstance(data.get("dishes"), list) and all("id" in d and "name_he" in d for d in data["dishes"])
    except (ValueError, AssertionError):
        return menu_view(error="JSON לא תקין — כל מנה צריכה id ו-name_he. לא נשמר.")
    (settings().data_dir / "menu.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return back("/menu")


# ---------- venue ----------
@app.get("/venue", response_class=HTMLResponse)
def venue_view():
    from .venue import catalog

    c = catalog()
    cards = "".join(f"""<div class="card"><img class="media" style="max-width:100%" src="/venue-img/{e(p['file'])}" loading="lazy">
<div class="row" style="margin-top:8px"><b>{e(p['zone_he'])}</b><span class="pill">{e(p['id'])}</span><span class="pill">{e(p['orientation'])}</span>
{'<span class="pill">+ גרסת לילה</span>' if p.get('night_variant') else ''}</div>
<p class="mute">לילו כאן: {e(p['lilo_spots'])}</p><p class="mute">מתאים ל: {e(', '.join(PILLAR_HE.get(b, b) for b in p['best_for']))}</p></div>"""
                    for p in c["plates"])
    stage_he = {"open": "פתוח — תוכן רגיל", "coming_soon": "בקרוב — תוכן טיזר"}
    options = "".join(f'<option value="{k}" {"selected" if c["stage"] == k else ""}>{v}</option>' for k, v in stage_he.items())
    return page("המקום — ZOZOBRA", f"""<form class="card" method="post" action="/venue">
<p>אלה ההדמיות של החלל. כל פוסט שמתרחש במסעדה נבנה מתוכן: לילו "מצוירת" לתוך החדר האמיתי,
וצילומי האווירה הם ההדמיה עצמה בתנועה — כך שבסושיאל רואים את העיצוב של ZOZOBRA ולא מסעדה מומצאת.</p>
<label>סטטוס המקום</label><select name="stage">{options}</select>
<p><button class="btn">שמור</button></p></form><div class="grid">{cards}</div>""", "/venue")


@app.post("/venue")
def venue_save(stage: str = Form(...)):
    from .venue import VENUE_DIR, catalog

    if stage in {"open", "coming_soon"}:
        data = dict(catalog())
        data["stage"] = stage
        (VENUE_DIR / "venue.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        catalog.cache_clear()
    return back("/venue")


# ---------- setup wizard ----------
@app.get("/setup", response_class=HTMLResponse)
def setup(online: int = 0):
    from .doctor import run

    s = settings()
    checks = run(online=bool(online))
    rows = "".join(f'<div class="check"><span>{"✅" if c.ok else ("❌" if c.required else "⚠️")}</span>'
                   f'<div><b>{e(c.title)}</b> <span class="mute">— {e(c.detail)}</span>'
                   f'{"" if c.ok else f"<div class=mute>→ {e(c.fix)}</div>"}</div></div>' for c in checks)
    refs = s.data_dir / "refs"
    cands = sorted((refs / "candidates" / "R0").glob("*.png"))
    anchor = refs / "R0_anchor.png"
    dataset = sorted((refs / "dataset").glob("*.png"))
    cand_html = "".join(f'<form method="post" action="/setup/pick"><input type="hidden" name="path" value="{e(c)}">'
                        f'<img src="{media_url(c)}"><button class="btn ghost" style="width:100%;margin-top:6px">זו היא</button></form>'
                        for c in cands)
    has_fal = bool(s.fal_key)
    has_eleven = bool(s.elevenlabs_api_key)
    return page("הקמה", f"""<div class="card">{rows}
<p class="row"><a class="btn ghost" href="/setup?online=1">🔌 בדוק חיבור אמיתי לכל השירותים</a></p>
<p class="mute">מפתחות מוגדרים כמשתני סביבה (קובץ <code>.env</code> או בהגדרות השרת). אף מפתח לא מוצג או נשמר בדף.</p></div>

<h2>שלב 1 — הפנים של לילו (עוגן)</h2>
<div class="card"><p>יוצרים 8 מועמדות מהפרומפט הראשי ובוחרים את ה"היא". זו התמונה שכל השאר נבנה ממנה.</p>
<form method="post" action="/setup/anchor"><button class="btn" {'disabled' if not has_fal else ''}>🎨 צור 8 מועמדות</button></form>
<div class="thumbs" style="margin-top:12px">{cand_html}</div>
{f'<p><b>העוגן הנבחר:</b></p><img class="media" style="max-width:220px" src="{media_url(anchor)}">' if anchor.exists() else ''}</div>

<h2>שלב 2 — גיליון דמות (30 תמונות)</h2>
<div class="card"><p>מייצר את כל הזוויות, ההבעות והסצנות עם אותם פנים (PuLID) + כיתובים לאימון.
אחרי היצירה — עבור עליהן ומחק תמונות עם ידיים שבורות או פנים שזזו (מהתיקייה data/refs/dataset).</p>
<form method="post" action="/setup/sheet"><button class="btn" {'disabled' if not (has_fal and anchor.exists()) else ''}>📸 צור גיליון</button></form>
<div class="thumbs" style="margin-top:12px">{''.join(f'<img src="{media_url(p)}" title="{e(p.stem)}">' for p in dataset)}</div></div>

<h2>שלב 3 — אימון מודל הפנים (LoRA)</h2>
<div class="card"><p>כ-5-10 דקות ב-fal.ai. בסוף הקישור נשמר אוטומטית ומשמש בכל תמונה.</p>
<form method="post" action="/setup/train"><button class="btn" {'disabled' if not (has_fal and len(dataset) >= 15) else ''}>🧠 אמן ({len(dataset)} תמונות)</button></form>
<p class="mute">{'✓ מודל קיים: ' + e(s.lora_url[:70]) if s.lora_url else ''}</p></div>

<h2>שלב 4 — הקול של לילו</h2>
<div class="card"><p>ElevenLabs מעצב קול מהתיאור שלה (לא משבט אדם אמיתי). הקול נשמר אוטומטית.</p>
<form method="post" action="/setup/voice"><button class="btn" {'disabled' if not has_eleven else ''}>🎙️ צור קול</button></form>
{''.join(f'<audio controls src="{media_url(p)}" style="width:100%;margin-top:8px"></audio>' for p in sorted((s.data_dir / "voice_previews").glob("*.mp3")))}
<p class="mute">{'✓ קול פעיל: ' + e(s.elevenlabs_voice_id) if s.elevenlabs_voice_id else ''}</p></div>

<h2>דוגמה מוכנה</h2>
<div class="card"><p>רוצה לראות איך שבוע נראה לפני שמחברים מפתחות? טען לוח תוכן לדוגמה (בנגקוק היט + וייב ערב).</p>
<form method="post" action="/setup/sample"><button class="btn ghost">📅 טען שבוע לדוגמה</button></form></div>""", "/setup")


def _train_job() -> str:
    from .fal_provider import train_lora

    url = train_lora(settings().data_dir / "refs" / "dataset")
    save_runtime(lora_url=url)
    return "המודל אומן ונשמר"


def _voice_job() -> str:
    from .voice import design_voice

    vid = design_voice()
    save_runtime(voice_id=vid)
    return f"קול נוצר: {vid}"


@app.post("/setup/anchor")
def setup_anchor():
    from .refsheet import anchor_candidates

    jobs.submit("מועמדות לעוגן", anchor_candidates)
    return back("/setup")


@app.post("/setup/pick")
def setup_pick(path: str = Form(...)):
    from .refsheet import pick_anchor

    p = Path(path).resolve()
    if (settings().data_dir / "refs" / "candidates").resolve() in p.parents and p.exists():
        pick_anchor(p)
    return back("/setup")


@app.post("/setup/sheet")
def setup_sheet():
    from .refsheet import build_sheet

    jobs.submit("גיליון דמות (30 תמונות)", build_sheet)
    return back("/setup")


@app.post("/setup/train")
def setup_train():
    jobs.submit("אימון LoRA", _train_job)
    return back("/setup")


@app.post("/setup/voice")
def setup_voice():
    jobs.submit("עיצוב קול", _voice_job)
    return back("/setup")


@app.post("/setup/sample")
def setup_sample():
    src = ROOT / "examples" / "week_sample.json"
    cal_dir().mkdir(parents=True, exist_ok=True)
    data = json.loads(src.read_text(encoding="utf-8"))
    (cal_dir() / f"week_{data['days'][0]['day']}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return back("/calendars")


# ---------- scheduler ----------
def _scheduled_publish() -> str:
    from .pipeline import publish_due

    return " | ".join(publish_due()) or "אין מה לפרסם"


def _scheduled_plan() -> str:
    rt = runtime()
    if not (rt.get("auto_plan") and rt.get("focus")):
        return "תכנון אוטומטי כבוי"
    return _plan_job(rt["focus"], date.today() + timedelta(days=1))


def _scheduled_metrics() -> str:
    if not (settings().ig_access_token or settings().tiktok_access_token):
        return "אין חשבונות מחוברים"
    return _metrics_job()


def main() -> None:
    import os

    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))


if __name__ == "__main__":
    main()
