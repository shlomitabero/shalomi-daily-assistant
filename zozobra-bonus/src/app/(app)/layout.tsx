import { requireMe } from "@/lib/auth";
import { BottomNav, type NavItem } from "@/components/BottomNav";
import { Logo } from "@/components/Logo";
import { SignOutButton } from "@/components/SignOutButton";
import { ROLE_LABELS } from "@shared/metrics.ts";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await requireMe();
  const { app_role, bonus_eligible } = me.employee;

  let nav: NavItem[];
  if (app_role === "admin") {
    nav = [
      { href: "/admin", label: "בקרה", icon: "gauge" },
      { href: "/admin/targets", label: "יעדים", icon: "target" },
      { href: "/admin/approvals", label: "אישורים", icon: "check" },
      { href: "/admin/integrations", label: "חיבורים", icon: "plug" },
      { href: "/admin/more", label: "עוד", icon: "dots" },
    ];
  } else if (app_role === "shift_manager") {
    nav = [
      ...(bonus_eligible ? [{ href: "/me", label: "הבונוס שלי", icon: "wallet" } as NavItem] : []),
      { href: "/manager/scores", label: "הזנת ציונים", icon: "pencil" },
      { href: "/leaderboard", label: "מובילים", icon: "trophy" },
    ];
  } else {
    nav = [
      { href: "/me", label: "הבונוס שלי", icon: "wallet" },
      { href: "/leaderboard", label: "מובילים", icon: "trophy" },
    ];
  }

  return (
    <div className="min-h-dvh">
      <header
        className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur-xl"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-4">
          <div className="min-w-0 text-sm">
            <div className="truncate font-medium">{me.employee.first_name}</div>
            <div className="truncate text-[0.7rem] text-muted">
              {app_role === "admin" ? "בעלים / מנהל" : ROLE_LABELS[me.employee.job_role]}
            </div>
          </div>
          <Logo />
          <SignOutButton compact />
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 pt-5 pb-32">{children}</main>
      <BottomNav items={nav} />
    </div>
  );
}
