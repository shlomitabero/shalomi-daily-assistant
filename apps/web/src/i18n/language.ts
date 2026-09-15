export type Lang = "he" | "en";

export const STORAGE_KEY = "forge.lang";

/**
 * Only Hebrew and the topbar chrome are converted so far (see
 * docs/product-quality-audit.md) -- switching to English on an
 * unconverted screen would show a mix of English chrome and Hebrew
 * content, which is worse than staying consistently Hebrew. So for now
 * the default is always Hebrew regardless of browser language, and
 * English is an explicit choice via the language switcher, never an
 * automatic one. Browser-language auto-detection is deferred until more
 * screens are converted (tracked in docs/roadmap.md).
 */
export function detectInitialLang(storedValue: string | null): Lang {
  return storedValue === "he" || storedValue === "en" ? storedValue : "he";
}

export function dirFor(lang: Lang): "rtl" | "ltr" {
  return lang === "he" ? "rtl" : "ltr";
}

export const translations: Record<Lang, Record<string, string>> = {
  he: {
    "brand.tagline": "מתארים עסק במילים שלכם — ומקבלים אפליקציה עובדת.",
    "topbar.logout": "יציאה",
    "app.loading": "טוען…",
    "lang.he": "עברית",
    "lang.en": "EN",
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
  },
  en: {
    "brand.tagline": "Describe your business in your own words — get a working app.",
    "topbar.logout": "Log out",
    "app.loading": "Loading…",
    "lang.he": "עברית",
    "lang.en": "EN",
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
  },
};

/** Falls back to Hebrew, then to the raw key, rather than ever throwing on a missing translation. */
export function translate(lang: Lang, key: string): string {
  return translations[lang][key] ?? translations.he[key] ?? key;
}
