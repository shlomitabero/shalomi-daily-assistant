import { useState } from "react";
import type { User } from "@forge/shared";
import { login, setToken, signup } from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { LanguageSwitcher } from "./i18n/LanguageSwitcher.js";

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
        <LanguageSwitcher />
      </div>
      <h1>{mode === "signup" ? t("auth.title.signup") : t("auth.title.login")}</h1>
      <p className="muted">{mode === "signup" ? t("auth.subtitle.signup") : t("auth.subtitle.login")}</p>
      <form onSubmit={handleSubmit} className="auth-form">
        <label className="field-row">
          <span>{t("auth.email.label")}</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field-row">
          <span>{t("auth.password.label")}</span>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? t("auth.submit.busy") : mode === "signup" ? t("auth.submit.signup") : t("auth.submit.login")}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      <button
        type="button"
        className="secondary link-button"
        onClick={() => setMode(mode === "signup" ? "login" : "signup")}
      >
        {mode === "signup" ? t("auth.toggle.toLogin") : t("auth.toggle.toSignup")}
      </button>
    </main>
  );
}
