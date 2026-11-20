import { Logo } from "@/components/Logo";
import { SignOutButton } from "@/components/SignOutButton";

export default function NoAccess() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-6 px-5 text-center">
      <Logo size="lg" />
      <div className="card p-6">
        <h1 className="font-display text-xl font-bold">המספר אינו רשום במערכת</h1>
        <p className="mt-2 text-sm text-muted">
          נכנסת עם מספר טלפון שלא משויך לעובד פעיל. פנה/י למנהל/ת כדי שיוסיף את המספר שלך.
        </p>
        <div className="mt-5">
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
