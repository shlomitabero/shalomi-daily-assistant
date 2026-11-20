import { Logo } from "@/components/Logo";
import { findSurveyTarget } from "@/lib/survey";
import { SurveyForm } from "./SurveyForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "דרגו את השירות" };

export default async function Survey({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const t = await findSurveyTarget(code);
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-8 px-5 py-10">
      <Logo size="lg" subtitle={false} />
      {t ? (
        <SurveyForm code={code} name={t.firstName} />
      ) : (
        <div className="card p-6 text-center text-sm text-muted">הקישור אינו פעיל.</div>
      )}
      <p className="text-center text-xs text-faint">הדירוג אנונימי ועוזר לנו לתגמל את הצוות</p>
    </main>
  );
}
