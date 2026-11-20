"use client";

import { useActionState } from "react";
import { buttonClass } from "./ui";

export function RotateSecret({
  id,
  action,
  hasSecret,
}: {
  id: string;
  action: (prev: { secret?: string; error?: string } | null, form: FormData) => Promise<{ secret?: string; error?: string }>;
  hasSecret: boolean;
}) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form action={run} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      {state?.secret ? (
        <div className="rounded-xl border border-gold/40 bg-gold/10 p-3 text-sm">
          <div className="mb-1 text-gold">מפתח החתימה החדש — העתיקו עכשיו, הוא לא יוצג שוב:</div>
          <code dir="ltr" className="block break-all select-all text-xs text-ink">{state.secret}</code>
        </div>
      ) : null}
      {state?.error ? <div className="text-sm text-bad">{state.error}</div> : null}
      <button
        className={buttonClass("secondary", "sm")}
        disabled={pending}
        onClick={(e) => {
          if (hasSecret && !confirm("ליצור מפתח חדש? המפתח הקודם יפסיק לעבוד מיד.")) e.preventDefault();
        }}
      >
        {pending ? "יוצר…" : hasSecret ? "יצירת מפתח חתימה חדש" : "יצירת מפתח חתימה"}
      </button>
    </form>
  );
}
