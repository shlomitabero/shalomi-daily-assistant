export function shekels(agorot: number | null | undefined, opts: { decimals?: boolean } = {}): string {
  const v = (agorot ?? 0) / 100;
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency: "ILS",
    minimumFractionDigits: opts.decimals ? 2 : 0,
    maximumFractionDigits: opts.decimals ? 2 : 0,
  }).format(v);
}

export function pct(ratio: number | null | undefined, digits = 0): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function num(v: number | null | undefined, unit = ""): string {
  if (v === null || v === undefined) return "—";
  const s = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 2 }).format(v);
  if (unit === "₪") return `₪${s}`;
  if (unit === "%") return `${s}%`;
  return s;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function dateShort(iso: string): string {
  return new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "numeric", month: "numeric", year: "numeric" }).format(
    new Date(`${iso}T12:00:00Z`),
  );
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "טיוטה",
  approved: "מאושר",
  paid: "שולם",
};

export const LINE_STATUS_LABEL: Record<string, string> = {
  ok: "",
  below_threshold: "מתחת לסף",
  missing: "חסר נתון",
  invalid_target: "יעד לא תקין",
};
