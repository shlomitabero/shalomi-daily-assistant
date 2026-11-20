import { Logo } from "@/components/Logo";

export const dynamic = "force-static";
export const metadata = { title: "אין חיבור" };

export default function Offline() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-6 px-5 text-center">
      <Logo size="lg" />
      <div className="card p-6">
        <h1 className="font-display text-xl font-bold">אין חיבור לאינטרנט</h1>
        <p className="mt-2 text-sm text-muted">הנתונים יוצגו ברגע שהחיבור יחזור.</p>
      </div>
    </main>
  );
}
