"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { periodLabel } from "@shared/period.ts";

export function PeriodPicker({ period, periods }: { period: string; periods: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <label className="relative inline-flex">
      <span className="sr-only">חודש</span>
      <select
        className="field !min-h-10 !w-auto appearance-none !py-1.5 !pe-9 text-sm font-medium"
        value={period}
        onChange={(e) => {
          const next = new URLSearchParams(params);
          next.set("period", e.target.value);
          router.push(`${pathname}?${next.toString()}`);
        }}
      >
        {periods.map((p) => (
          <option key={p} value={p}>
            {periodLabel(p)}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs text-gold">▾</span>
    </label>
  );
}
