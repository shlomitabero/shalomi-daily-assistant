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
      <h1>{mode === "signup" ? "Create your Forge AI workspace" : "Welcome back"}</h1>
      <form onSubmit={handleSubmit} className="auth-form">
        <label className="field-row">
          <span>Email</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field-row">
          <span>Password</span>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Log in"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      <button
        type="button"
        className="secondary link-button"
        onClick={() => setMode(mode === "signup" ? "login" : "signup")}
      >
        {mode === "signup" ? "Already have an account? Log in" : "Need an account? Sign up"}
      </button>
      <p className="muted small">
        Every project is private to your account — see docs/security.md for exactly what this
        single-workspace-per-user auth does and doesn't cover yet.
      </p>
    </main>
  );
}
