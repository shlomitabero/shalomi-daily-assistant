import { useState } from "react";
import { useTranslation } from "./i18n/LanguageContext.js";

/**
 * Every password field in the app (signup/login, and all three fields on
 * the change-password form) was a plain `type="password"` input with no
 * way to check what you'd actually typed -- a real, everyday annoyance
 * the moment autocorrect, a sticky key, or a typo-prone symbol is
 * involved, and one every other real auth form solves with a show/hide
 * toggle. A single shared component keeps all four fields' behavior (and
 * the toggle's own icon/label) identical rather than reimplementing this
 * once per form.
 */
export function PasswordInput({
  value,
  onChange,
  required,
  minLength,
  autoComplete,
}: {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  minLength?: number;
  autoComplete?: string;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  return (
    <div className="password-input-wrap">
      <input
        type={visible ? "text" : "password"}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setVisible((prev) => !prev)}
        aria-label={visible ? t("password.hide") : t("password.show")}
        aria-pressed={visible}
      >
        {visible ? "🙈" : "👁️"}
      </button>
    </div>
  );
}
