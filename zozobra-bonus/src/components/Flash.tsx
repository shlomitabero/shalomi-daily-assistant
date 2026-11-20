import { Notice } from "./ui";

/** Shows ?ok= / ?err= messages set by server actions after redirect. */
export function Flash({ ok, err }: { ok?: string; err?: string }) {
  if (err) return <div className="mb-4"><Notice tone="bad">{err}</Notice></div>;
  if (ok) return <div className="mb-4"><Notice tone="ok">{ok}</Notice></div>;
  return null;
}
