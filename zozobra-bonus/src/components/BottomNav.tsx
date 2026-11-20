"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
}

const ICONS = {
  wallet: "M3 7h15a3 3 0 0 1 3 3v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 0V6a2 2 0 0 1 2-2h11v3M16 14h2",
  trophy: "M8 4h8v5a4 4 0 0 1-8 0V4Zm0 2H5a3 3 0 0 0 3 4m8-4h3a3 3 0 0 1-3 4m-4 3v4m-4 3h8",
  pencil: "M4 20h4L19 9l-4-4L4 16v4Zm11-15 4 4",
  gauge: "M4 18a8 8 0 1 1 16 0M12 18l4-6",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-4a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-4a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
  check: "M4 12.5 9 17.5 20 6.5",
  plug: "M9 3v5m6-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
};

export function BottomNav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/90 backdrop-blur-xl"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex max-w-2xl">
        {items.map((it) => {
          const active = path === it.href || (it.href !== "/admin" && path.startsWith(`${it.href}/`)) || (it.href === "/admin/more" && isMoreChild(path, items));
          return (
            <li key={it.href} className="flex-1">
              <Link
                href={it.href}
                className={`flex min-h-16 flex-col items-center justify-center gap-1 text-[0.68rem] transition ${active ? "text-gold" : "text-muted hover:text-ink"}`}
                aria-current={active ? "page" : undefined}
              >
                <svg viewBox="0 0 24 24" className="h-[1.35rem] w-[1.35rem]" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d={ICONS[it.icon]} />
                </svg>
                {it.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function isMoreChild(path: string, items: NavItem[]) {
  if (!path.startsWith("/admin/")) return false;
  return !items.some((i) => i.href !== "/admin/more" && (path === i.href || path.startsWith(`${i.href}/`)));
}
