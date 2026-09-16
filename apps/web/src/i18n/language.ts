export type Lang = "he" | "en";

export const STORAGE_KEY = "forge.lang";

/**
 * Every screen is now translated (see docs/roadmap.md), so browser-language
 * detection is safe: an explicit stored choice always wins; otherwise a
 * Hebrew browser locale ("he", "he-IL", ...) picks Hebrew and anything else
 * picks English; with no browser info at all (e.g. a non-browser test
 * environment) the default stays Hebrew, matching this product's Hebrew-
 * first origin.
 */
export function detectInitialLang(storedValue: string | null, browserLanguage?: string): Lang {
  if (storedValue === "he" || storedValue === "en") return storedValue;
  if (!browserLanguage) return "he";
  return browserLanguage.toLowerCase().startsWith("he") ? "he" : "en";
}

export function dirFor(lang: Lang): "rtl" | "ltr" {
  return lang === "he" ? "rtl" : "ltr";
}

export interface ApiErrorBody {
  error?: string;
  code?: string;
}

/**
 * Server errors were never localized (see docs/roadmap.md): the API sends a
 * stable `code` (see apps/api/src/httpError.ts) alongside its English
 * `error` message specifically so the client can show a translated string
 * instead. Falls back to the raw `error` text for any code this
 * dictionary doesn't recognize yet, so nothing goes silently blank.
 */
export function resolveErrorMessage(lang: Lang, body: ApiErrorBody): string {
  if (body.code) {
    const key = `error.${body.code}`;
    const translated = translate(lang, key);
    if (translated !== key) return translated;
  }
  return body.error ?? "Request failed";
}

export const translations: Record<Lang, Record<string, string>> = {
  he: {
    "brand.tagline": "מתארים עסק במילים שלכם — ומקבלים אפליקציה עובדת.",
    "topbar.logout": "יציאה",
    "app.loading": "טוען…",
    "app.waking": "🔥 מעירים את השרת... אחרי חוסר פעילות זה יכול לקחת עד דקה בפעם הראשונה. נא להמתין, לא צריך לרענן.",
    "error.VALIDATION_ERROR": "הנתונים שנשלחו לא תקינים. בדקו את הטופס ונסו שוב.",
    "error.EMAIL_TAKEN": "כבר קיים חשבון עם כתובת האימייל הזו.",
    "error.INVALID_CREDENTIALS": "אימייל או סיסמה שגויים.",
    "error.USER_NOT_FOUND": "המשתמש לא נמצא. נסו להתחבר שוב.",
    "error.AUTH_REQUIRED": "צריך להתחבר כדי להמשיך.",
    "error.SESSION_EXPIRED": "ההתחברות שלכם פגה. התחברו שוב.",
    "error.ENTITY_NOT_FOUND": "הישות הזו לא קיימת באפליקציה.",
    "error.PROJECT_NOT_FOUND": "הפרויקט לא נמצא.",
    "error.BUILD_REQUIRED": "צריך לבנות את הפרויקט קודם.",
    "error.CHECKPOINT_NOT_FOUND": "נקודת השחזור הזו לא נמצאה.",
    "error.NOT_FOUND": "הפריט המבוקש לא נמצא.",
    "error.INTERNAL_ERROR": "קרתה תקלה בשרת. נסו שוב בעוד רגע.",
    "error.NETWORK_ERROR": "לא הצלחנו להתחבר לשרת. בדקו את החיבור לאינטרנט ונסו שוב.",
    "lang.he": "עברית",
    "lang.en": "EN",
    "theme.switchToDark": "מעבר למצב כהה",
    "theme.switchToLight": "מעבר למצב בהיר",
    "auth.title.signup": "בואו נתחיל",
    "auth.title.login": "ברוך שובך",
    "auth.subtitle.signup": "פותחים חשבון חינמי — כל מה שתבנו יהיה פרטי ושמור רק אצלך.",
    "auth.subtitle.login": "מתחברים לחשבון שלך.",
    "auth.email.label": "אימייל",
    "auth.password.label": "סיסמה (לפחות 8 תווים)",
    "auth.submit.busy": "רגע…",
    "auth.submit.signup": "פתיחת חשבון",
    "auth.submit.login": "התחברות",
    "auth.toggle.toLogin": "כבר יש לי חשבון",
    "auth.toggle.toSignup": "אין לי עדיין חשבון",
    "auth.highlights.heading": "מה מקבלים",
    "auth.highlights.item1": "מתארים את העסק במילים שלכם — ה-AI בונה סכימת נתונים אמיתית, API עובד ומסכי ניהול מלאים.",
    "auth.highlights.item2": "כל שינוי אפשר לבטל: ה-Time Machine שומר נקודות שחזור אמיתיות של האפליקציה שלכם.",
    "auth.highlights.item3": "עברית או אנגלית — כל המסכים, כולל הודעות שגיאה, מותאמים לשפה שבחרתם.",
    "auth.highlights.item4": "כשמוכנים, מורידים קוד React אמיתי שרץ גם מחוץ ל-Forge AI.",
    "home.title": "מה תרצו לבנות?",
    "home.placeholder": "לדוגמה: אפליקציה לניהול תורים למספרה, עם לקוחות, עובדים ושירותים, ולוח בקרה למנהל/ת.",
    "home.submit.busy": "חושבים על זה…",
    "home.submit": "בואו נתחיל",
    "home.enhance": "✨ שפר ובנה עם AI",
    "home.enhance.busy": "כותבים פרומפט מושלם…",
    "home.enhance.hint": "ה-AI יכתוב לרעיון שלך פרומפט מפורט יותר, ואז יבנה אותו ישירות — תוכלו לראות ולערוך את מה שנכתב.",
    "spec.title": "ככה הבנו את זה",
    "spec.roles.heading": "מי ישתמש באפליקציה",
    "spec.entities.heading": "המסכים שנבנה",
    "spec.assumptions.heading": "הנחות שעשינו",
    "spec.openQuestions.heading": "כדאי שתחליטו",
    "spec.answerInput.placeholder": "או כתבו תשובה משלכם…",
    "spec.recommendation": "ההמלצה שלנו: ",
    "spec.additionalRequest.heading": "יש עוד משהו שתרצו לבקש?",
    "spec.additionalRequest.description":
      "לא חייבים לחכות לשאלה מוכנה — אפשר לכתוב כל בקשה במילים שלכם, והיא תיכנס לתכנון לפני שמתחילים לבנות.",
    "spec.additionalRequest.placeholder": 'לדוגמה: "רוצה לעקוב גם אחרי ספקים" או "תוסיפו שדה הערות לכל לקוח"',
    "spec.build.busy": "מיישמים את הבקשות שלכם…",
    "spec.build.submit": "🔥 לבנות את האפליקציה",
    "build.title.build": "צוות ה-AI בונה את האפליקציה שלכם",
    "build.subtitle": "צוות ה-AI עובד עכשיו, בזמן אמת. שלב {current} מתוך {total}.",
    "build.footer": "כל שלב פה קורה באמת עכשיו על הנתונים שלכם — לא רק אנימציה.",
    "build.failed.banner": "הבנייה נעצרה כדי לא לפרסם משהו שלא עובד כמו שצריך.",
    "build.back": "חזרה",
    "build.status.pending": "ממתין/ה בתור…",
    "build.status.failedPrefix": "נתקלנו בבעיה: ",
    "build.detail.show": "מה בדיוק נעשה?",
    "build.detail.hide": "הסתרת פרטים",
    "build.agent.Architect.title": "מתכנן/ת המוצר",
    "build.agent.Architect.running": "מתכנן/ת איך המסכים והנתונים מתחברים…",
    "build.agent.Architect.success": "התכנון מוכן.",
    "build.agent.Database.title": "מהנדס/ת בסיס הנתונים",
    "build.agent.Database.running": "בונה את מקום האחסון של המידע שלכם…",
    "build.agent.Database.success": "בסיס הנתונים מוכן ועובד.",
    "build.agent.Debug.title": "סוכן/ת הדיבוג",
    "build.agent.Debug.running": "מנתח/ת מה השתבש ומנסה למצוא תיקון…",
    "build.agent.Debug.success": "הבעיה תוקנה אוטומטית והבנייה ממשיכה.",
    "build.agent.SeedData.title": "ממלא/ת דוגמאות",
    "build.agent.SeedData.running": "מוסיף/ה כמה רשומות לדוגמה, כדי שלא תתחילו מדף ריק…",
    "build.agent.SeedData.success": "נתוני דוגמה נוספו.",
    "build.agent.QA.title": "בודק/ת האיכות",
    "build.agent.QA.running": "בודק/ת שהכל באמת עובד כמו שצריך…",
    "build.agent.QA.success": "כל הבדיקות עברו בהצלחה.",
    "build.agent.Security.title": "מומחה/ית האבטחה",
    "build.agent.Security.running": "סורק/ת אחר בעיות אבטחה נפוצות…",
    "build.agent.Security.success": "נסרק ואושר.",
    "build.agent.Forge.title": "סגירת הבנייה",
    "build.agent.Forge.running": "שומר/ת הכל ומכין/ה נקודת שחזור…",
    "build.agent.Forge.success": "הכל מוכן!",
    "build.detail.architect.noChange": "אין שינוי במבנה — הכל כבר קיים.",
    "build.detail.architect.newScreen": "מסך חדש: ",
    "build.detail.architect.gainedFields": " קיבל שדות חדשים: ",
    "build.detail.database.noChange": "לא היה צורך בשינוי בבסיס הנתונים.",
    "build.detail.database.newTable": "טבלה חדשה נוצרה: ",
    "build.detail.database.newColumn": "עמודה חדשה נוספה: ",
    "build.detail.seed.none": "לא נוספו נתוני דוגמה (אין מסכים חדשים).",
    "build.detail.seed.summary": "{count} רשומות דוגמה נוספו ב: {entities}.",
    "build.detail.security.none": "לא נמצאו אזהרות.",
    "preview.twin": "🧠 תמונת העסק",
    "preview.export": "⬇️ ייצוא קוד",
    "preview.export.busy": "מייצא…",
    "preview.history": "🕘 ציר זמן",
    "preview.refine.placeholder": 'לדוגמה: "להוסיף מעקב חשבוניות"',
    "preview.refine.submit": "שיפור האפליקציה",
    "preview.refineHistory.heading": "היסטוריית שיפורים",
    "preview.refineHistory.noChange": "לא היה שינוי במבנה.",
    "preview.refineHistory.noSummary": "בוצע.",
    "entity.select": "לבחור…",
    "entity.relation.placeholder": "מספר מזהה",
    "entity.empty": "—",
    "entity.save": "שמירה",
    "entity.add": "הוספה",
    "entity.cancel": "ביטול",
    "entity.edit": "עריכה",
    "entity.delete": "מחיקה",
    "entity.loading": "טוען…",
    "entity.noRecords": "אין עדיין רשומות — אפשר להוסיף את הראשונה למעלה.",
    "entity.search.placeholder": "🔍 חיפוש…",
    "entity.noResults": "אין תוצאות תואמות לחיפוש.",
    "history.title": "🕘 ציר זמן",
    "history.close": "סגירה",
    "history.description": "כל בנייה או שיפור נשמר כאן כנקודת שחזור. חוזרים אחורה בלי לאבד מידע — אף פעולה כאן לא מוחקת נתונים קיימים.",
    "history.empty": "אין עדיין נקודות שמורות.",
    "history.screenCount": "{count} מסכים",
    "history.restore.busy": "משחזר…",
    "history.restore": "שחזור",
    "twin.title": "🧠 תמונת העסק",
    "twin.description": "זו תמונת מצב אמיתית, מבוססת על הנתונים שבפועל נמצאים באפליקציה שלך — לא ניתוח עסקי מלא.",
    "twin.loading": "טוען…",
    "twin.observations": "מה שמתי לב אליו",
  },
  en: {
    "brand.tagline": "Describe your business in your own words — get a working app.",
    "topbar.logout": "Log out",
    "app.loading": "Loading…",
    "app.waking": "🔥 Waking up the server... after inactivity this can take up to a minute the first time. Please wait, no need to refresh.",
    "error.VALIDATION_ERROR": "The submitted data isn't valid. Please check the form and try again.",
    "error.EMAIL_TAKEN": "An account with this email already exists.",
    "error.INVALID_CREDENTIALS": "Incorrect email or password.",
    "error.USER_NOT_FOUND": "User not found. Please sign in again.",
    "error.AUTH_REQUIRED": "You need to sign in to continue.",
    "error.SESSION_EXPIRED": "Your session has expired. Please sign in again.",
    "error.ENTITY_NOT_FOUND": "This entity doesn't exist in the app.",
    "error.PROJECT_NOT_FOUND": "Project not found.",
    "error.BUILD_REQUIRED": "You need to build the project first.",
    "error.CHECKPOINT_NOT_FOUND": "This checkpoint wasn't found.",
    "error.NOT_FOUND": "The requested item wasn't found.",
    "error.INTERNAL_ERROR": "Something went wrong on the server. Please try again shortly.",
    "error.NETWORK_ERROR": "Couldn't reach the server. Check your connection and try again.",
    "lang.he": "עברית",
    "lang.en": "EN",
    "theme.switchToDark": "Switch to dark mode",
    "theme.switchToLight": "Switch to light mode",
    "auth.title.signup": "Let's get started",
    "auth.title.login": "Welcome back",
    "auth.subtitle.signup": "Open a free account — everything you build stays private to you.",
    "auth.subtitle.login": "Sign in to your account.",
    "auth.email.label": "Email",
    "auth.password.label": "Password (8+ characters)",
    "auth.submit.busy": "One sec…",
    "auth.submit.signup": "Create account",
    "auth.submit.login": "Sign in",
    "auth.toggle.toLogin": "I already have an account",
    "auth.toggle.toSignup": "I don't have an account yet",
    "auth.highlights.heading": "What you get",
    "auth.highlights.item1": "Describe your business in your own words — AI builds a real data schema, a working API, and full management screens.",
    "auth.highlights.item2": "Every change is reversible: the Time Machine keeps real checkpoints of your app.",
    "auth.highlights.item3": "Hebrew or English — every screen, including error messages, matches your chosen language.",
    "auth.highlights.item4": "When you're ready, download real React code that runs outside Forge AI too.",
    "home.title": "What do you want to build?",
    "home.placeholder":
      "e.g. An appointment-management app for a hair salon, with customers, staff and services, and an admin dashboard.",
    "home.submit.busy": "Thinking it over…",
    "home.submit": "Let's get started",
    "home.enhance": "✨ Enhance & build with AI",
    "home.enhance.busy": "Writing the perfect prompt…",
    "home.enhance.hint":
      "AI will rewrite your idea into a more detailed prompt, then build it right away — you'll see exactly what it wrote and can edit it.",
    "spec.title": "Here's what we understood",
    "spec.roles.heading": "Who will use the app",
    "spec.entities.heading": "The screens we'll build",
    "spec.assumptions.heading": "Assumptions we made",
    "spec.openQuestions.heading": "Worth deciding",
    "spec.answerInput.placeholder": "Or write your own answer…",
    "spec.recommendation": "Our recommendation: ",
    "spec.additionalRequest.heading": "Anything else you'd like to request?",
    "spec.additionalRequest.description":
      "You don't have to wait for a specific question — write any request in your own words, and it'll be factored into the plan before building starts.",
    "spec.additionalRequest.placeholder":
      'e.g. "I also want to track suppliers" or "add a notes field to every customer"',
    "spec.build.busy": "Applying your requests…",
    "spec.build.submit": "🔥 Build the app",
    "build.title.build": "The AI Team is building your app",
    "build.subtitle": "The AI Team is working now, in real time. Step {current} of {total}.",
    "build.footer": "Every step here is really happening on your data right now — not just an animation.",
    "build.failed.banner": "The build stopped so we don't publish something that doesn't work properly.",
    "build.back": "Back",
    "build.status.pending": "Waiting in line…",
    "build.status.failedPrefix": "We hit a problem: ",
    "build.detail.show": "What exactly happened?",
    "build.detail.hide": "Hide details",
    "build.agent.Architect.title": "Product Planner",
    "build.agent.Architect.running": "Planning how the screens and data connect…",
    "build.agent.Architect.success": "The plan is ready.",
    "build.agent.Database.title": "Database Engineer",
    "build.agent.Database.running": "Building the place where your data is stored…",
    "build.agent.Database.success": "The database is ready and working.",
    "build.agent.Debug.title": "Debug Agent",
    "build.agent.Debug.running": "Analyzing what went wrong and trying to find a fix…",
    "build.agent.Debug.success": "The issue was fixed automatically and the build continues.",
    "build.agent.SeedData.title": "Sample Data Filler",
    "build.agent.SeedData.running": "Adding a few sample records so you don't start from a blank page…",
    "build.agent.SeedData.success": "Sample data added.",
    "build.agent.QA.title": "Quality Checker",
    "build.agent.QA.running": "Checking that everything really works as it should…",
    "build.agent.QA.success": "All checks passed.",
    "build.agent.Security.title": "Security Expert",
    "build.agent.Security.running": "Scanning for common security issues…",
    "build.agent.Security.success": "Scanned and approved.",
    "build.agent.Forge.title": "Finishing the build",
    "build.agent.Forge.running": "Saving everything and preparing a restore point…",
    "build.agent.Forge.success": "All done!",
    "build.detail.architect.noChange": "No structural change — everything already exists.",
    "build.detail.architect.newScreen": "New screen: ",
    "build.detail.architect.gainedFields": " gained new fields: ",
    "build.detail.database.noChange": "No database change was needed.",
    "build.detail.database.newTable": "New table created: ",
    "build.detail.database.newColumn": "New column added: ",
    "build.detail.seed.none": "No sample data was added (no new screens).",
    "build.detail.seed.summary": "{count} sample records were added to: {entities}.",
    "build.detail.security.none": "No warnings found.",
    "preview.twin": "🧠 Business Twin",
    "preview.export": "⬇️ Export Code",
    "preview.export.busy": "Exporting…",
    "preview.history": "🕘 Time Machine",
    "preview.refine.placeholder": 'e.g. "add invoice tracking"',
    "preview.refine.submit": "Improve the app",
    "preview.refineHistory.heading": "Improvement history",
    "preview.refineHistory.noChange": "No structural change.",
    "preview.refineHistory.noSummary": "Done.",
    "entity.select": "Choose…",
    "entity.relation.placeholder": "ID number",
    "entity.empty": "—",
    "entity.save": "Save",
    "entity.add": "Add",
    "entity.cancel": "Cancel",
    "entity.edit": "Edit",
    "entity.delete": "Delete",
    "entity.loading": "Loading…",
    "entity.noRecords": "No records yet — add the first one above.",
    "entity.search.placeholder": "🔍 Search…",
    "entity.noResults": "No results match your search.",
    "history.title": "🕘 Time Machine",
    "history.close": "Close",
    "history.description":
      "Every build or improvement is saved here as a restore point. Go back without losing data — nothing here deletes existing data.",
    "history.empty": "No saved points yet.",
    "history.screenCount": "{count} screens",
    "history.restore.busy": "Restoring…",
    "history.restore": "Restore",
    "twin.title": "🧠 Business Twin",
    "twin.description": "This is a real snapshot, based on the data actually in your app — not a full business analysis.",
    "twin.loading": "Loading…",
    "twin.observations": "What we noticed",
  },
};

/**
 * Falls back to Hebrew, then to the raw key, rather than ever throwing on
 * a missing translation. `params` fills in `{placeholders}` in the
 * string (e.g. "Step {current} of {total}") -- deliberately minimal
 * (no plural rules, no date/number formatting) since nothing in this
 * product needs more yet; a real i18n library remains the right move if
 * that changes.
 */
export function translate(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const raw = translations[lang][key] ?? translations.he[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}
