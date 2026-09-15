import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { detectInitialLang, dirFor, translate, STORAGE_KEY, type Lang } from "./language.js";

interface LanguageContextValue {
  lang: Lang;
  dir: "rtl" | "ltr";
  t: (key: string) => string;
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
  const [lang, setLangState] = useState<Lang>(() => detectInitialLang(readStoredLang()));

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dirFor(lang);
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
    }
  }, [lang]);

  const value: LanguageContextValue = {
    lang,
    dir: dirFor(lang),
    t: (key: string) => translate(lang, key),
    setLang: setLangState,
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
