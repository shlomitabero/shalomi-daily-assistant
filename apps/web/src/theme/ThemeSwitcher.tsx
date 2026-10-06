import { useTranslation } from "../i18n/LanguageContext.js";
import { useTheme } from "./ThemeContext.js";

export function ThemeSwitcher() {
  const { t } = useTranslation();
  const { theme, toggleTheme } = useTheme();
  const label = theme === "dark" ? t("theme.switchToLight") : t("theme.switchToDark");
  return (
    <button type="button" className="theme-switch" onClick={toggleTheme} aria-label={label} title={label}>
      {theme === "dark" ? "☀️" : "🌙"}
    </button>
  );
}
