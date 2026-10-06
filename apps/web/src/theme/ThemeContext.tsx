import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { detectInitialTheme, THEME_STORAGE_KEY, type Theme } from "./theme.js";

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function prefersDarkFromSystem(): boolean | undefined {
  if (typeof window === "undefined" || !window.matchMedia) return undefined;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const storedTheme = readStoredTheme();
  const [theme, setTheme] = useState<Theme>(() => detectInitialTheme(storedTheme, prefersDarkFromSystem()));
  // theme.ts's own contract is "an explicit stored choice always wins;
  // otherwise falls back to the system preference" -- but the old version of
  // this provider wrote every theme, including one it had only just derived
  // from the system, to localStorage on mount. That silently turned "no
  // choice yet" into "an explicit choice" on a person's very first visit, so
  // neither a later system light/dark switch nor a fresh reload could ever
  // follow the system again on that device. This ref tracks whether a real
  // explicit choice (found in storage at mount, or made via toggleTheme)
  // exists, and only *that* gets persisted or blocks the listener below.
  const hasExplicitChoiceRef = useRef(storedTheme === "light" || storedTheme === "dark");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    function handleSystemChange(e: MediaQueryListEvent) {
      // Checked here, not just once at effect setup, so a toggleTheme call
      // made after this listener was attached still blocks it -- otherwise
      // an explicit choice made mid-session could still get silently
      // overwritten by the next system-level light/dark switch.
      if (hasExplicitChoiceRef.current) return;
      setTheme(e.matches ? "dark" : "light");
    }
    mediaQuery.addEventListener("change", handleSystemChange);
    return () => mediaQuery.removeEventListener("change", handleSystemChange);
  }, []);

  const value: ThemeContextValue = {
    theme,
    toggleTheme: () => {
      const next: Theme = theme === "dark" ? "light" : "dark";
      hasExplicitChoiceRef.current = true;
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
      }
      setTheme(next);
    },
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}
