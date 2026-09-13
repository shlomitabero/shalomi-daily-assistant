import { useState } from "react";
import type { User } from "@forge/shared";
import { login, setToken, signup } from "./api.js";

export function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
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
      <h1>{mode === "signup" ? "בואו נתחיל" : "ברוך שובך"}</h1>
      <p className="muted">
        {mode === "signup"
          ? "פותחים חשבון חינמי — כל מה שתבנו יהיה פרטי ושמור רק אצלך."
          : "מתחברים לחשבון שלך."}
      </p>
      <form onSubmit={handleSubmit} className="auth-form">
        <label className="field-row">
          <span>אימייל</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field-row">
          <span>סיסמה (לפחות 8 תווים)</span>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "רגע…" : mode === "signup" ? "פתיחת חשבון" : "התחברות"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      <button
        type="button"
        className="secondary link-button"
        onClick={() => setMode(mode === "signup" ? "login" : "signup")}
      >
        {mode === "signup" ? "כבר יש לי חשבון" : "אין לי עדיין חשבון"}
      </button>
    </main>
  );
}
