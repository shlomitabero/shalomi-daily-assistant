// A period is a calendar month, written "YYYY-MM" in code and stored as the
// first day of the month (date) in Postgres.

const RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isPeriod(p: string): boolean {
  return RE.test(p);
}

export function assertPeriod(p: string): string {
  if (!isPeriod(p)) throw new Error(`תקופה לא תקינה: ${p}`);
  return p;
}

export function periodToDate(p: string): string {
  return `${assertPeriod(p)}-01`;
}

export function dateToPeriod(d: string): string {
  return d.slice(0, 7);
}

export function daysInPeriod(p: string): number {
  const [y, m] = assertPeriod(p).split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addMonths(p: string, delta: number): string {
  const [y, m] = assertPeriod(p).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Current period in Israel time. */
export function currentPeriod(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const y = parts.find((x) => x.type === "year")!.value;
  const m = parts.find((x) => x.type === "month")!.value;
  return `${y}-${m}`;
}

const HE_MONTHS = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

export function periodLabel(p: string): string {
  const [y, m] = assertPeriod(p).split("-").map(Number);
  return `${HE_MONTHS[m - 1]} ${y}`;
}

/** Payday: bonuses are paid with the salary on the 10th of the next month. */
export function payday(p: string): string {
  return `${addMonths(p, 1)}-10`;
}
