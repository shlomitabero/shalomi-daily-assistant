import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
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
  const [theme, setTheme] = useState<Theme>(() => detectInitialTheme(readStoredTheme(), prefersDarkFromSystem()));

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
    }
  }, [theme]);

  const value: ThemeContextValue = {
    theme,
    toggleTheme: () => setTheme((current) => (current === "dark" ? "light" : "dark")),
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
