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
  primary:
    "bg-gradient-to-b from-gold-2 to-gold text-[#1a140a] font-semibold shadow-[0_6px_20px_-8px_rgb(207_169_95/0.6)] hover:brightness-105",
  secondary: "border border-line-strong text-ink bg-surface-2 hover:bg-surface-3",
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

/**
 * Achievement meter on a 0–120% scale with threshold and target markers.
 * Fills from the start edge (right, in RTL).
 */
export function AchievementMeter({
  achievement,
  thresholdPct,
  showLegend,
}: {
  achievement: number | null;
  thresholdPct: number;
  showLegend?: boolean;
}) {
  const scale = (x: number) => `${(Math.min(Math.max(x, 0), CAP) / CAP) * 100}%`;
  const a = achievement ?? 0;
  const t = thresholdPct / 100;
  const tone =
    achievement === null ? "bg-faint" : a + 1e-9 < t ? "bg-bad" : a < 1 ? "bg-warn" : "bg-gradient-to-l from-gold to-gold-2";
  return (
    <div>
      <div className="relative mt-3 h-2 rounded-full bg-surface-3" aria-hidden>
        <div className={cx("absolute inset-y-0 start-0 rounded-full transition-all", tone)} style={{ width: scale(a) }} />
        <div className="absolute -top-1 h-4 w-px bg-muted/70" style={{ insetInlineStart: scale(t) }} />
        <div className="absolute -top-1.5 h-5 w-0.5 rounded bg-ink" style={{ insetInlineStart: scale(1) }} />
      </div>
      {showLegend ? (
        <p className="mt-2 text-[0.68rem] text-faint">
          50% מהבונוס בסף ({thresholdPct}%) · 100% ביעד <span className="text-ink/70">┃</span> · עד 120% מעל היעד
        </p>
      ) : null}
    </div>
  );
}
