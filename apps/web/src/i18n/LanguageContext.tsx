import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { detectInitialLang, dirFor, translate, STORAGE_KEY, type Lang } from "./language.js";

interface LanguageContextValue {
  lang: Lang;
  dir: "rtl" | "ltr";
  t: (key: string, params?: Record<string, string | number>) => string;
  setLang: (lang: Lang) => void;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

function readStoredLang(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const storedLang = readStoredLang();
  const [lang, setLangState] = useState<Lang>(() => detectInitialLang(storedLang, navigator.language));
  // language.ts's own contract is "an explicit stored choice always wins;
  // otherwise falls back to the browser locale" -- but this provider used to
  // write every lang, including one it had only just derived from
  // navigator.language, to localStorage on mount. That silently turned "no
  // choice yet" into "an explicit choice" on a person's very first visit, so
  // a later browser-language change (or a different person on a shared
  // profile) could never be auto-detected again on that device. Mirrors
  // ThemeContext.tsx's own hasExplicitChoiceRef fix for the identical bug.
  const hasExplicitChoiceRef = useRef(storedLang === "he" || storedLang === "en");

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dirFor(lang);
  }, [lang]);

  // Mirrors ThemeContext.tsx's own live system-preference listener -- this
  // half of the fix was never actually ported over despite the comment
  // above claiming full parity: without it, a person who never made an
  // explicit language choice (relying on auto-detected navigator.language)
  // had no way to pick up a live OS/browser language change mid-session,
  // unlike dark/light mode, which already follows the system instantly.
  useEffect(() => {
    function handleSystemChange() {
      // Checked here, not just once at effect setup, so a setLang call made
      // after this listener was attached still blocks it -- otherwise an
      // explicit choice made mid-session could still get silently
      // overwritten by the next browser-language change.
      if (hasExplicitChoiceRef.current) return;
      setLangState(detectInitialLang(null, navigator.language));
    }
    window.addEventListener("languagechange", handleSystemChange);
    return () => window.removeEventListener("languagechange", handleSystemChange);
  }, []);

  const value: LanguageContextValue = {
    lang,
    dir: dirFor(lang),
    t: (key: string, params?: Record<string, string | number>) => translate(lang, key, params),
    setLang: (next: Lang) => {
      // Persisted here directly, not in a [lang]-keyed effect (see
      // ThemeContext.tsx's own toggleTheme, which does the same): clicking
      // the button for the language that's ALREADY active (e.g. the
      // auto-detected one, reachable since LanguageSwitcher.tsx has no
      // disabled guard on either button) passes setLangState a value equal
      // to the current state. React bails out of that update since a
      // primitive value hasn't changed, so an effect keyed on [lang] would
      // never re-run and the choice would silently never reach storage --
      // leaving hasExplicitChoiceRef true in memory for this session only,
      // reverting to auto-detection on the next load/reload. toggleTheme
      // never hits this case since it's a binary flip that always changes
      // value; setLang takes an explicit target, so it can collide with
      // the current one.
      hasExplicitChoiceRef.current = true;
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
      }
      setLangState(next);
    },
  };

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useTranslation(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error("useTranslation must be used within a LanguageProvider");
  }
  return ctx;
}
