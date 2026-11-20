import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "עוד" };

const LINKS = [
  { href: "/admin/results", title: "תוצאות מדדים", desc: "צפייה ותיקון ידני של כל התוצאות לחודש" },
  { href: "/admin/qr", title: "קודי QR לסקר לקוחות", desc: "קוד אישי לכל עובד — הסקרים והשירות נכנסים לבד" },
  { href: "/manager/scores", title: "הזנת ציונים", desc: "תיקון ידני של ציוני שירות, סקרים ושירות טלפוני" },
  { href: "/admin/import", title: "ייבוא CSV", desc: "העלאת קובץ תוצאות עם מיפוי עמודות ותצוגה מקדימה" },
  { href: "/admin/mapping", title: "שיוך עובדים", desc: "שמות ממערכות חיצוניות שלא זוהו אוטומטית" },
  { href: "/admin/employees", title: "עובדים", desc: "הוספה, עריכה, תפקידים ומזהים במערכות" },
  { href: "/admin/sync-log", title: "יומן סנכרון", desc: "כל הרצות הסנכרון והייבוא" },
  { href: "/admin/audit", title: "יומן שינויים", desc: "מי שינה מה ומתי" },
  { href: "/leaderboard", title: "טבלת מובילים", desc: "כפי שהעובדים רואים אותה" },
];

export default async function More() {
  await requireAdmin();
  return (
    <>
      <PageHeader title="עוד" />
      <ul className="space-y-2">
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="card flex items-center justify-between gap-3 px-4 py-3.5 hover:border-line-strong">
              <div>
                <div className="font-medium">{l.title}</div>
                <div className="text-xs text-muted">{l.desc}</div>
              </div>
              <span className="text-gold">‹</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
