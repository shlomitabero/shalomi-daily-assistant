import Link from "next/link";
import type { ReactNode } from "react";
import { CAP } from "@shared/payout.ts";

export function cx(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(" ");
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-[1.7rem] leading-tight font-bold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("card p-4", className)}>{children}</section>;
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-[0.95rem] font-semibold text-ink">{children}</h2>
      {aside}
    </div>
  );
}

type Tone = "gold" | "ok" | "warn" | "bad" | "muted";
const TONES: Record<Tone, string> = {
  gold: "text-gold border-gold/40 bg-gold/10",
  ok: "text-ok border-ok/40 bg-ok/10",
  warn: "text-warn border-warn/40 bg-warn/10",
  bad: "text-bad border-bad/40 bg-bad/10",
  muted: "text-muted border-line bg-surface-2",
};

export function Badge({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", TONES[tone])}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [Tone, string]> = {
    draft: ["warn", "טיוטה"],
    approved: ["ok", "מאושר"],
    paid: ["gold", "שולם"],
    success: ["ok", "הצליח"],
    partial: ["warn", "חלקי"],
    failed: ["bad", "נכשל"],
    running: ["muted", "רץ"],
    active: ["ok", "פעיל"],
    paused: ["muted", "מושהה"],
    error: ["bad", "שגיאה"],
    not_configured: ["muted", "לא מוגדר"],
    awaiting_credentials: ["warn", "ממתין לפרטי גישה"],
  };
  const [tone, label] = map[status] ?? ["muted", status];
  return <Badge tone={tone}>{label}</Badge>;
}

const BTN = {
  primary: "bg-red border border-red text-white font-medium hover:brightness-110",
  secondary: "border border-line text-ink bg-surface-2 hover:border-line-strong",
  ghost: "text-muted hover:text-ink",
  danger: "border border-bad/40 text-bad bg-bad/10 hover:bg-bad/15",
};

export function buttonClass(variant: keyof typeof BTN = "primary", size: "md" | "sm" = "md") {
  return cx(
    "inline-flex items-center justify-center gap-2 rounded-xl transition disabled:opacity-50 disabled:pointer-events-none",
    size === "md" ? "min-h-11 px-4 text-sm" : "min-h-9 px-3 text-xs",
    BTN[variant],
  );
}

export function LinkButton({
  href,
  children,
  variant = "secondary",
  size = "md",
  download,
}: {
  href: string;
  children: ReactNode;
  variant?: keyof typeof BTN;
  size?: "md" | "sm";
  download?: boolean;
}) {
  if (download) {
    return (
      <a href={href} download className={buttonClass(variant, size)}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={buttonClass(variant, size)}>
      {children}
    </Link>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "gold" }) {
  return (
    <div className="card p-3.5">
      <div className="text-xs text-muted">{label}</div>
      <div className={cx("num mt-1 text-xl font-bold text-end", tone === "gold" && "gold-text")}>{value}</div>
      {hint ? <div className="mt-0.5 text-[0.7rem] text-faint">{hint}</div> : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-2 px-6 py-10 text-center">
      <div className="text-3xl opacity-60">◌</div>
      <div className="font-semibold">{title}</div>
      {children ? <div className="max-w-sm text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export function Notice({ tone = "warn", children }: { tone?: "warn" | "ok" | "bad" | "gold"; children: ReactNode }) {
  return <div className={cx("rounded-xl border px-3.5 py-2.5 text-sm", TONES[tone])}>{children}</div>;
}

/** Status chip as in the prototype: on target / close / below / no data. */
export function achievementStatus(a: number | null): { tone: "ok" | "warn" | "bad" | "muted"; label: string } {
  if (a === null) return { tone: "muted", label: "אין נתון" };
  if (a + 1e-9 >= 1) return { tone: "ok", label: "ביעד" };
  if (a >= 0.95) return { tone: "warn", label: "קרוב" };
  return { tone: "bad", label: "מתחת" };
}

/**
 * Achievement bar on a 0–120% scale with a target tick (prototype style).
 * Fills from the start edge (right, in RTL).
 */
export function AchievementMeter({ achievement }: { achievement: number | null; thresholdPct?: number }) {
  const a = achievement;
  const w = a === null ? 0 : Math.min(1, a / CAP);
  const color = a === null ? "var(--color-faint)" : a + 1e-9 >= 1 ? "var(--color-ok)" : a >= 0.95 ? "var(--color-warn)" : "var(--color-red)";
  return (
    <div className="relative h-2 rounded-full bg-surface-2" aria-hidden>
      <i className="absolute inset-y-0 start-0 rounded-full transition-[width] duration-700" style={{ width: `${w * 100}%`, background: color }} />
      <span className="absolute -top-[3px] -bottom-[3px] w-0.5 rounded bg-ink/50" style={{ insetInlineStart: `${(1 / CAP) * 100}%` }} />
    </div>
  );
}
