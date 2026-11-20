"use client";

import { useActionState, useState } from "react";
import { buttonClass } from "@/components/ui";
import { sendSurvey } from "./actions";

function Stars({ name, label, value, onChange }: { name: string; label: string; value: number; onChange: (v: number) => void }) {
  return (
    <fieldset className="text-center">
      <legend className="mb-3 w-full text-center font-medium">{label}</legend>
      <input type="hidden" name={name} value={value || ""} />
      <div className="flex justify-center gap-2" dir="ltr">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`${n} מתוך 5`}
            onClick={() => onChange(n)}
            className={`grid h-12 w-12 place-items-center rounded-xl border text-2xl transition ${
              n <= value ? "border-gold bg-gold/15 text-gold" : "border-line text-faint"
            }`}
          >
            ★
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function SurveyForm({ code, name }: { code: string; name: string }) {
  const [state, run, pending] = useActionState(sendSurvey, null);
  const [overall, setOverall] = useState(0);
  const [service, setService] = useState(0);

  if (state?.done) {
    return (
      <div className="card p-8 text-center">
        <div className="text-4xl">🙏</div>
        <h2 className="mt-3 font-display text-xl font-bold">תודה רבה!</h2>
        <p className="mt-2 text-sm text-muted">הדירוג שלך נשמר. נשמח לראות אותך שוב בזוזוברה.</p>
      </div>
    );
  }
  return (
    <form action={run} className="card space-y-7 p-6">
      <input type="hidden" name="code" value={code} />
      <Stars name="overall" label="איך הייתה החוויה שלך היום?" value={overall} onChange={setOverall} />
      <Stars name="service" label={`איך היה השירות של ${name}?`} value={service} onChange={setService} />
      <div>
        <label className="label" htmlFor="comment">רוצה להוסיף משהו? (לא חובה)</label>
        <textarea id="comment" name="comment" rows={3} maxLength={500} className="field" />
      </div>
      {state?.error ? <p className="text-center text-sm text-bad">{state.error}</p> : null}
      <button className={buttonClass("primary") + " w-full"} disabled={pending || !overall || !service}>
        {pending ? "שולח…" : "שליחה"}
      </button>
    </form>
  );
}
