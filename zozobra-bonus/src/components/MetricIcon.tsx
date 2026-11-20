// Icons from the approved prototype, one per metric.
const PATHS: Record<string, React.ReactNode> = {
  survey: <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" strokeLinejoin="round" />,
  service: <path d="M4 17h16M6 17a6 6 0 0112 0M12 8V6M3 20h18" strokeLinecap="round" />,
  food: <path d="M3 11h18a9 9 0 01-18 0zM8 4l2 5M15 3l-1 6" strokeLinecap="round" />,
  labor: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" />
    </>
  ),
  upsell: <path d="M4 17l6-6 4 4 6-7M14 8h6v6" strokeLinecap="round" strokeLinejoin="round" />,
  promo: (
    <>
      <path d="M3 12V4h8l10 10-8 8z" strokeLinejoin="round" />
      <circle cx="7.5" cy="8.5" r="1.3" />
    </>
  ),
  revenue: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" />
    </>
  ),
  answer: (
    <>
      <path d="M4 14v-2a8 8 0 0116 0v2" strokeLinecap="round" />
      <rect x="3" y="13" width="4" height="6" rx="1.5" />
      <rect x="17" y="13" width="4" height="6" rx="1.5" />
    </>
  ),
  phone: <path d="M5 3h4l2 5-2.5 1.5a11 11 0 006 6L16 13l5 2v4a2 2 0 01-2 2A17 17 0 013 5a2 2 0 012-2z" strokeLinejoin="round" />,
};

export function MetricIcon({ id }: { id: string }) {
  return (
    <div className="grid h-9 w-9 flex-none place-items-center rounded-[11px] bg-surface-2 text-gold">
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
        {PATHS[id]}
      </svg>
    </div>
  );
}

export function ProgressRing({ value, size = 104 }: { value: number; size?: number }) {
  const r = 48;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(1, Math.max(0, value)));
  return (
    <div className="relative flex-none" style={{ width: size, height: size }}>
      <svg viewBox="0 0 110 110" width={size} height={size} style={{ transform: "rotate(-90deg)" }} aria-hidden>
        <defs>
          <linearGradient id="ring" x1="0" x2="1">
            <stop offset="0" stopColor="#e0452b" />
            <stop offset="1" stopColor="#c9a45c" />
          </linearGradient>
        </defs>
        <circle cx="55" cy="55" r={r} fill="none" stroke="#2a2622" strokeWidth="8" />
        <circle cx="55" cy="55" r={r} fill="none" stroke="url(#ring)" strokeWidth="8" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div className="num text-[1.3rem] leading-none font-extrabold">
          {Math.round(value * 100)}%<div className="mt-1 text-[0.62rem] font-normal text-muted">מימוש</div>
        </div>
      </div>
    </div>
  );
}
