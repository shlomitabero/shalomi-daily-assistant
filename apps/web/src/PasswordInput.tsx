import { useState } from "react";
import { useTranslation } from "./i18n/LanguageContext.js";
import { getPasswordStrength } from "./passwordStrength.js";

/**
 * Every password field in the app (signup/login, and all three fields on
 * the change-password form) was a plain `type="password"` input with no
 * way to check what you'd actually typed -- a real, everyday annoyance
 * the moment autocorrect, a sticky key, or a typo-prone symbol is
 * involved, and one every other real auth form solves with a show/hide
 * toggle. A single shared component keeps all four fields' behavior (and
 * the toggle's own icon/label) identical rather than reimplementing this
 * once per form.
 *
 * `showStrength` opts a field into a live strength meter (passwordStrength.ts) --
 * only worth showing where a *new* password is being chosen (signup,
 * change-password's "new" field), never for a current/login password where
 * there's nothing left to choose.
 */
export function PasswordInput({
  value,
  onChange,
  required,
  minLength,
  autoComplete,
  name,
  showStrength,
}: {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  minLength?: number;
  autoComplete?: string;
  name?: string;
  showStrength?: boolean;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const strength = showStrength ? getPasswordStrength(value) : null;

  /**
   * A password field is the one input where "what you typed doesn't match
   * what you meant" is invisible by design (the toggle above helps, but
   * only once you think to use it) -- Caps Lock silently being on is the
   * single most common real cause, and every other real auth form warns
   * for it. `getModifierState` only reflects reality while a key event is
   * actually firing, so this can only ever answer "as of the last
   * keystroke" -- it clears on blur rather than showing a warning that
   * could go stale the moment focus moves elsewhere.
   */
  function checkCapsLock(e: React.KeyboardEvent<HTMLInputElement>) {
    setCapsLockOn(e.getModifierState("CapsLock"));
  }

  return (
    <div className="password-input-wrap-outer">
      <div className="password-input-wrap">
        <input
          type={visible ? "text" : "password"}
          required={required}
          minLength={minLength}
          autoComplete={autoComplete}
          name={name}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={checkCapsLock}
          onKeyUp={checkCapsLock}
          onBlur={() => setCapsLockOn(false)}
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
      {capsLockOn && (
        <p className="password-caps-warning" role="alert">
          {t("password.capsLockWarning")}
        </p>
      )}
      {strength && (
        <div className="password-strength" data-strength={strength}>
          <div className="password-strength-bars">
            <span className="password-strength-bar" />
            <span className="password-strength-bar" />
            <span className="password-strength-bar" />
          </div>
          <span className="password-strength-label">{t(`password.strength.${strength}`)}</span>
        </div>
      )}
    </div>
  );
}
