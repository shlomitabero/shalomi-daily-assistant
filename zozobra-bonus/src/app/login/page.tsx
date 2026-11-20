"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { Logo } from "@/components/Logo";
import { buttonClass } from "@/components/ui";

/** 050-1234567 / 0501234567 / +972501234567 → +972501234567 */
function toE164(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  if (/^05\d{8}$/.test(d)) return `+972${d.slice(1)}`;
  if (/^9725\d{8}$/.test(d)) return `+${d}`;
  return null;
}

export default function LoginPage() {
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const e164 = toE164(phone);
    if (!e164) return setError("מספר טלפון נייד לא תקין");
    setBusy(true);
    const { error } = await createClient().auth.signInWithOtp({ phone: e164 });
    setBusy(false);
    if (error) return setError(error.status === 429 ? "נשלחו יותר מדי קודים. נסו שוב בעוד דקה." : "שליחת הקוד נכשלה. נסו שוב.");
    setStep("code");
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error } = await createClient().auth.verifyOtp({ phone: toE164(phone)!, token: code.trim(), type: "sms" });
    setBusy(false);
    if (error) return setError("הקוד שגוי או שפג תוקפו");
    // full navigation so the server sees the fresh session cookie
    window.location.assign("/");
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5 py-10">
      <div className="mb-10">
        <Logo size="lg" />
      </div>
      <div className="card p-6">
        <h1 className="font-display text-2xl font-bold">כניסה לצוות</h1>
        <p className="mt-1 text-sm text-muted">
          {step === "phone" ? "נשלח אליך קוד חד־פעמי ב־SMS" : `שלחנו קוד בן 6 ספרות ל־${phone}`}
        </p>

        {step === "phone" ? (
          <form onSubmit={sendCode} className="mt-6 space-y-4">
            <div>
              <label className="label" htmlFor="phone">
                מספר טלפון נייד
              </label>
              <input
                id="phone"
                className="field num text-lg tracking-wider text-end"
                inputMode="tel"
                autoComplete="tel"
                placeholder="050-0000000"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
            </div>
            <button className={buttonClass("primary") + " w-full"} disabled={busy}>
              {busy ? "שולח…" : "שליחת קוד"}
            </button>
          </form>
        ) : (
          <form onSubmit={verify} className="mt-6 space-y-4">
            <div>
              <label className="label" htmlFor="code">
                קוד אימות
              </label>
              <input
                id="code"
                className="field num text-center text-2xl tracking-[0.5em]"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="\d{6}"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                autoFocus
                required
              />
            </div>
            <button className={buttonClass("primary") + " w-full"} disabled={busy || code.length !== 6}>
              {busy ? "מאמת…" : "כניסה"}
            </button>
            <button type="button" className={buttonClass("ghost") + " w-full"} onClick={() => setStep("phone")}>
              החלפת מספר
            </button>
          </form>
        )}
        {error ? <p className="mt-4 text-center text-sm text-bad">{error}</p> : null}
      </div>
      <p className="mt-6 text-center text-xs text-faint">הכניסה מיועדת לעובדי ZOZOBRA בלבד</p>
    </main>
  );
}
