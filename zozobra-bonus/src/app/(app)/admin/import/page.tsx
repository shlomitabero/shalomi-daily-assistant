import { requireAdmin } from "@/lib/auth";
import { adminPeriods } from "@/lib/periods";
import { PageHeader } from "@/components/ui";
import { ImportWizard } from "./ImportWizard";

export const metadata = { title: "ייבוא CSV" };

export default async function ImportPage() {
  await requireAdmin();
  const { period, periods } = await adminPeriods();
  return (
    <>
      <PageHeader title="ייבוא תוצאות מ־CSV" subtitle="מיפוי עמודות, בדיקה מקדימה, ואז ייבוא וחישוב מחדש" />
      <ImportWizard periods={periods} defaultPeriod={period} />
    </>
  );
}
