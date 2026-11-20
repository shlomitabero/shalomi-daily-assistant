"use client";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { buttonClass } from "./ui";

export function SignOutButton({ compact }: { compact?: boolean }) {
  const router = useRouter();
  return (
    <button
      className={compact ? "text-xs text-muted hover:text-ink" : buttonClass("secondary")}
      onClick={async () => {
        await createClient().auth.signOut();
        router.replace("/login");
        router.refresh();
      }}
    >
      יציאה
    </button>
  );
}
