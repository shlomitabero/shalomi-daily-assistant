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
    if (!hasExplicitChoiceRef.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
    }
  }, [lang]);

  const value: LanguageContextValue = {
    lang,
    dir: dirFor(lang),
    t: (key: string, params?: Record<string, string | number>) => translate(lang, key, params),
    setLang: (next: Lang) => {
      hasExplicitChoiceRef.current = true;
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
