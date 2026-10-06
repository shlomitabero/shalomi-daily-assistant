export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "forge.theme";

/**
 * An explicit stored choice always wins; otherwise falls back to the
 * system's `prefers-color-scheme`, and light when there's no signal at all
 * (e.g. a non-browser test environment) -- mirrors detectInitialLang in
 * ../i18n/language.ts.
 */
export function detectInitialTheme(storedValue: string | null, prefersDark?: boolean): Theme {
  if (storedValue === "light" || storedValue === "dark") return storedValue;
  return prefersDark ? "dark" : "light";
}
