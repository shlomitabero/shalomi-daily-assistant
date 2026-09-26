import { useState } from "react";
import type { User } from "@forge/shared";
import { login, setToken, signup } from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { LanguageSwitcher } from "./i18n/LanguageSwitcher.js";
import { PasswordInput } from "./PasswordInput.js";
import { ThemeSwitcher } from "./theme/ThemeSwitcher.js";

export function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user, token } = mode === "signup" ? await signup(email, password) : await login(email, password);
      setToken(token);
      onAuthenticated(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="home">
      <div className="auth-top-row">
        <div className="brand-row auth-brand">
          <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path
              d="M16 2c1.2 4.4-1.6 6.4-3.4 8.6-2.2 2.7-3.2 5.6-1.8 8.9 1 2.3 3 3.7 5.2 3.7-1.4-2-1.4-3.8-.3-5.6 1-1.6 2.6-2.3 2.9-4.3.9 1.6 1.4 3.2 1.2 5-.2 2.1-1.4 3.7-1.4 3.7 3.6-.6 6.6-3.6 6.6-7.6 0-3.4-2-5.6-3.8-7.6-2.6-2.9-4.4-5.6-5.2-8.8Z"
              fill="var(--accent)"
            />
          </svg>
          <span className="brand">Forge AI</span>
        </div>
        <div className="auth-top-actions">
          <ThemeSwitcher />
          <LanguageSwitcher />
        </div>
      </div>
      <div className="auth-layout">
        <div className="auth-main">
          <h1>{mode === "signup" ? t("auth.title.signup") : t("auth.title.login")}</h1>
          <p className="muted">{mode === "signup" ? t("auth.subtitle.signup") : t("auth.subtitle.login")}</p>
          <form onSubmit={handleSubmit} className="auth-form">
            <label className="field-row">
              <span>{t("auth.email.label")}</span>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field-row">
              <span>{t("auth.password.label")}</span>
              <PasswordInput value={password} onChange={setPassword} required minLength={8} />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? t("auth.submit.busy") : mode === "signup" ? t("auth.submit.signup") : t("auth.submit.login")}
            </button>
          </form>
          {error && <p className="error">{error}</p>}
          <button
            type="button"
            className="secondary link-button"
            disabled={busy}
            onClick={() => {
              // Switching forms mid-request would let an in-flight
              // signup/login silently sign the user in under whichever
              // account they were trying to abandon, once it resolves --
              // so this stays disabled while busy, same as the submit
              // button. A stale error from the form being left also
              // shouldn't bleed into the other form (e.g. "email already
              // taken" showing while the user is trying to log in).
              setMode(mode === "signup" ? "login" : "signup");
              setError(null);
            }}
          >
            {mode === "signup" ? t("auth.toggle.toLogin") : t("auth.toggle.toSignup")}
          </button>
        </div>
        <aside className="auth-highlights">
          <h2>{t("auth.highlights.heading")}</h2>
          <ul>
            <li>{t("auth.highlights.item1")}</li>
            <li>{t("auth.highlights.item2")}</li>
            <li>{t("auth.highlights.item3")}</li>
            <li>{t("auth.highlights.item4")}</li>
          </ul>
        </aside>
      </div>
    </main>
  );
}
