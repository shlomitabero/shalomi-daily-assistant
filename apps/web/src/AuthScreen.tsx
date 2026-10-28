import { useState } from "react";
import type { User } from "@forge/shared";
import { forgotPassword, login, resetPassword, setToken, signup, verifyLoginCode } from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { LanguageSwitcher } from "./i18n/LanguageSwitcher.js";
import { PasswordInput } from "./PasswordInput.js";
import { ThemeSwitcher } from "./theme/ThemeSwitcher.js";

export function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const { t, lang } = useTranslation();
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set once a correct password gets back `{ requiresCode: true,
  // loginCodeId }` instead of a token (routes/auth.ts's own
  // emailSender.configured check) -- non-null means "show the code-entry
  // step instead of the email/password form". Stays null for every signup,
  // and for every login as long as RESEND_API_KEY isn't configured server-
  // side, so most deployments of this app never see this step at all.
  const [pendingLoginCodeId, setPendingLoginCodeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  // Round 1155: a transactional email's code routinely arrives late or
  // lands in spam, and the only existing recovery before this was clicking
  // "Back" and resubmitting the whole login form from scratch -- email and
  // password are still sitting in state right here, so resending is just
  // re-running the exact same login() call handleSubmit already makes.
  // True only right after a resend actually succeeds; cleared the moment
  // the user submits a code or resends again, so it never lingers as a
  // stale confirmation.
  const [codeResent, setCodeResent] = useState(false);

  // Read once, at mount -- a URL this app itself never otherwise reads any
  // query param from (see routes/auth.ts's own forgot-password route,
  // which builds this exact link from the request's own origin). Cleared
  // to null (and stripped from the URL, see handleBackToLogin below) once
  // the reset actually completes, so a page refresh afterward -- or a
  // second attempt with the same, now-consumed token -- doesn't look like
  // it's still "pending".
  const [resetToken, setResetToken] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("resetToken"),
  );
  const [resetNewPassword, setResetNewPassword] = useState("");
  const [resetConfirmPassword, setResetConfirmPassword] = useState("");
  const [resetDone, setResetDone] = useState(false);

  // Mirrors pendingLoginCodeId's own "non-null means show a different step
  // instead of the login/signup form" shape, one level up: this step comes
  // BEFORE a login code could ever apply (it's requested instead of
  // logging in at all), so it only matters while pendingLoginCodeId is
  // itself null.
  const [forgotPasswordMode, setForgotPasswordMode] = useState(false);
  const [forgotPasswordSent, setForgotPasswordSent] = useState(false);
  // Round 1156: the sibling gap to round 1155's own codeResent -- a
  // password-reset email is exactly as prone to arriving late or landing
  // in spam as a login code is, and the only recovery before this was
  // clicking "Back" and going through "Forgot password?" again from
  // scratch. email is still sitting in state right here, so resending is
  // just re-running the exact same forgotPassword() call
  // handleForgotPasswordSubmit already makes. True only right after a
  // resend actually succeeds; cleared the moment the user resends again,
  // so it never lingers as a stale confirmation.
  const [forgotPasswordResent, setForgotPasswordResent] = useState(false);

  function handleBackToLogin() {
    window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    setResetToken(null);
    setResetDone(false);
    setResetNewPassword("");
    setResetConfirmPassword("");
    setForgotPasswordMode(false);
    setForgotPasswordSent(false);
    setForgotPasswordResent(false);
    setMode("login");
    setError(null);
  }

  async function handleForgotPasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await forgotPassword(email, lang);
      setForgotPasswordSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleResendForgotPasswordEmail() {
    setError(null);
    setForgotPasswordResent(false);
    setBusy(true);
    try {
      await forgotPassword(email, lang);
      setForgotPasswordResent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleResetPasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Mirrors handleSubmit's own signup confirm-check exactly -- caught
    // client-side, before it ever reaches the server.
    if (resetNewPassword !== resetConfirmPassword) {
      setError(t("auth.confirmPassword.mismatch"));
      return;
    }
    setBusy(true);
    try {
      await resetPassword(resetToken!, resetNewPassword);
      // Strips the now-consumed token from the URL immediately, the same
      // one-liner handleBackToLogin uses -- but deliberately WITHOUT also
      // nulling the resetToken state itself, which would flip the
      // `resetToken && resetDone` render-gate below back to the normal
      // login/signup screen and vanish the success message this very call
      // is about to show. A refresh/remount after this point re-reads a
      // clean URL and lands on login instead of re-showing this form for a
      // token the server already deleted on success (single-use by
      // design), which previously surfaced a confusing "expired or
      // invalid" error for someone who had, in fact, already succeeded.
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
      setResetDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Signup is the one place a typo would otherwise go unnoticed until the
    // very next login attempt -- round 716 added a real "forgot password"
    // recovery path for an account locked out this way, but catching the
    // typo right here, before it ever reaches the server, is still better
    // than making someone go through that flow for a mistake made seconds
    // ago. Mirrors ChangePasswordPanel's own confirm-field mismatch check
    // exactly.
    if (mode === "signup" && password !== confirmPassword) {
      setError(t("auth.confirmPassword.mismatch"));
      return;
    }
    setBusy(true);
    try {
      if (mode === "signup") {
        const { user, token } = await signup(email, password);
        setToken(token);
        onAuthenticated(user);
        return;
      }
      const result = await login(email, password, lang);
      if ("requiresCode" in result) {
        setPendingLoginCodeId(result.loginCodeId);
        return;
      }
      setToken(result.token);
      onAuthenticated(result.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCodeResent(false);
    setBusy(true);
    try {
      const { user, token } = await verifyLoginCode(pendingLoginCodeId!, code);
      setToken(token);
      onAuthenticated(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleResendCode() {
    setError(null);
    setCodeResent(false);
    setBusy(true);
    try {
      const result = await login(email, password, lang);
      if ("requiresCode" in result) {
        setPendingLoginCodeId(result.loginCodeId);
        setCode("");
        setCodeResent(true);
        return;
      }
      // Can't actually happen mid-session (emailSender.configured doesn't
      // flip while this screen is open), but if the server ever did return
      // a direct token here, finishing the login is the right response,
      // not silently discarding it.
      setToken(result.token);
      onAuthenticated(result.user);
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
          {resetToken ? (
            resetDone ? (
              <>
                <h1>{t("auth.resetPassword.title")}</h1>
                <p className="success">{t("auth.resetPassword.success")}</p>
                <button type="button" onClick={handleBackToLogin}>
                  {t("auth.resetPassword.goToLogin")}
                </button>
              </>
            ) : (
              <>
                <h1>{t("auth.resetPassword.title")}</h1>
                <p className="muted">{t("auth.resetPassword.subtitle")}</p>
                <form onSubmit={handleResetPasswordSubmit} className="auth-form">
                  <label className="field-row">
                    <span>{t("auth.resetPassword.new")}</span>
                    <PasswordInput
                      value={resetNewPassword}
                      onChange={setResetNewPassword}
                      required
                      minLength={8}
                      autoComplete="new-password"
                      showStrength
                    />
                  </label>
                  <label className="field-row">
                    <span>{t("auth.resetPassword.confirm")}</span>
                    <PasswordInput value={resetConfirmPassword} onChange={setResetConfirmPassword} required minLength={8} autoComplete="new-password" />
                  </label>
                  <button type="submit" disabled={busy}>
                    {busy ? t("auth.submit.busy") : t("auth.resetPassword.submit")}
                  </button>
                </form>
                {error && (
                  <p className="error" role="status">
                    {error}
                  </p>
                )}
                {/* Round 914: an expired/already-consumed/unknown token
                    (RESET_TOKEN_INVALID) rejects this form unconditionally
                    on every resubmission -- retyping the password can
                    never fix it, unlike a transient error. Before this,
                    the only two sibling branches in this component (the
                    resetDone success state two cases above, and
                    forgotPasswordMode's own pre-send state below) both
                    have a back-to-login escape hatch; this was the one
                    branch missing it, leaving a user who followed an
                    emailed link past its TTL with no in-app way back to
                    login at all. Reuses handleBackToLogin (already does
                    the right full reset, including stripping the token
                    from the URL) and the existing "back to login" string
                    the forgotPassword branch's own back button uses. */}
                <button type="button" className="secondary link-button" disabled={busy} onClick={handleBackToLogin}>
                  {t("auth.forgotPassword.back")}
                </button>
              </>
            )
          ) : forgotPasswordMode ? (
            <>
              <h1>{t("auth.forgotPassword.title")}</h1>
              {forgotPasswordSent ? (
                <>
                  <p className="success">{t("auth.forgotPassword.sent")}</p>
                  {forgotPasswordResent && (
                    <p className="success" role="status">
                      {t("auth.forgotPassword.resent")}
                    </p>
                  )}
                  {error && (
                    <p className="error" role="status">
                      {error}
                    </p>
                  )}
                  <button type="button" onClick={handleBackToLogin}>
                    {t("auth.forgotPassword.back")}
                  </button>
                  <button type="button" className="secondary link-button" disabled={busy} onClick={handleResendForgotPasswordEmail}>
                    {busy ? t("auth.submit.busy") : t("auth.forgotPassword.resend")}
                  </button>
                </>
              ) : (
                <>
                  <p className="muted">{t("auth.forgotPassword.subtitle")}</p>
                  <form onSubmit={handleForgotPasswordSubmit} className="auth-form">
                    <label className="field-row">
                      <span>{t("auth.email.label")}</span>
                      <input
                        type="email"
                        autoComplete="username"
                        autoFocus
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                      />
                    </label>
                    <button type="submit" disabled={busy}>
                      {busy ? t("auth.submit.busy") : t("auth.forgotPassword.submit")}
                    </button>
                  </form>
                  {error && (
                    <p className="error" role="status">
                      {error}
                    </p>
                  )}
                  <button
                    type="button"
                    className="secondary link-button"
                    disabled={busy}
                    onClick={() => {
                      setForgotPasswordMode(false);
                      setError(null);
                    }}
                  >
                    {t("auth.forgotPassword.back")}
                  </button>
                </>
              )}
            </>
          ) : pendingLoginCodeId ? (
            <>
              <h1>{t("auth.code.title")}</h1>
              <p className="muted">{t("auth.code.subtitle", { email })}</p>
              <form onSubmit={handleVerifyCode} className="auth-form">
                <label className="field-row">
                  <span>{t("auth.code.label")}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
                <button type="submit" disabled={busy || code.length === 0}>
                  {busy ? t("auth.submit.busy") : t("auth.code.submit")}
                </button>
              </form>
              {codeResent && (
                <p className="success" role="status">
                  {t("auth.code.resent")}
                </p>
              )}
              {error && (
                <p className="error" role="status">
                  {error}
                </p>
              )}
              <button
                type="button"
                className="secondary link-button"
                disabled={busy}
                onClick={() => {
                  setPendingLoginCodeId(null);
                  setCode("");
                  setError(null);
                  setCodeResent(false);
                }}
              >
                {t("auth.code.back")}
              </button>
              <button type="button" className="secondary link-button" disabled={busy} onClick={handleResendCode}>
                {busy ? t("auth.submit.busy") : t("auth.code.resend")}
              </button>
            </>
          ) : (
            <>
              <h1>{mode === "signup" ? t("auth.title.signup") : t("auth.title.login")}</h1>
              <p className="muted">{mode === "signup" ? t("auth.subtitle.signup") : t("auth.subtitle.login")}</p>
              <form onSubmit={handleSubmit} className="auth-form">
                <label className="field-row">
                  <span>{t("auth.email.label")}</span>
                  <input
                    type="email"
                    name="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label className="field-row">
                  <span>{t("auth.password.label")}</span>
                  <PasswordInput
                    value={password}
                    onChange={setPassword}
                    required
                    minLength={8}
                    name="password"
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    showStrength={mode === "signup"}
                  />
                </label>
                {mode === "signup" && (
                  <label className="field-row">
                    <span>{t("auth.confirmPassword.label")}</span>
                    <PasswordInput value={confirmPassword} onChange={setConfirmPassword} required minLength={8} autoComplete="new-password" />
                  </label>
                )}
                <button type="submit" disabled={busy}>
                  {busy ? t("auth.submit.busy") : mode === "signup" ? t("auth.submit.signup") : t("auth.submit.login")}
                </button>
              </form>
              {error && (
                <p className="error" role="status">
                  {error}
                </p>
              )}
              {mode === "login" && (
                <button
                  type="button"
                  className="secondary link-button"
                  disabled={busy}
                  onClick={() => {
                    setForgotPasswordMode(true);
                    setError(null);
                  }}
                >
                  {t("auth.forgotPassword.link")}
                </button>
              )}
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
                  setConfirmPassword("");
                }}
              >
                {mode === "signup" ? t("auth.toggle.toLogin") : t("auth.toggle.toSignup")}
              </button>
            </>
          )}
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
