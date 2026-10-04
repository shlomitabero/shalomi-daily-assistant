import { useTranslation } from "./LanguageContext.js";

export function LanguageSwitcher() {
  const { lang, t, setLang } = useTranslation();
  return (
    <div className="lang-switch" role="group" aria-label="Language / שפה">
      <button
        type="button"
        className={lang === "he" ? "lang-btn lang-btn-active" : "lang-btn"}
        onClick={() => setLang("he")}
      >
        {t("lang.he")}
      </button>
      <button
        type="button"
        className={lang === "en" ? "lang-btn lang-btn-active" : "lang-btn"}
        onClick={() => setLang("en")}
      >
        {t("lang.en")}
      </button>
    </div>
  );
}
