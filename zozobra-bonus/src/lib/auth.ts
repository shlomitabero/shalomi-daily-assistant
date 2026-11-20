import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { JobRole } from "@shared/metrics.ts";

export interface Me {
  userId: string;
  employee: {
    id: string;
    branch_id: string;
    first_name: string;
    last_name: string;
    job_role: JobRole;
    app_role: "employee" | "shift_manager" | "admin";
    tip_based: boolean;
    bonus_eligible: boolean;
  };
}

export const getMe = cache(async (): Promise<Me | null> => {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const { data } = await sb
    .from("employees")
    .select("id, branch_id, first_name, last_name, job_role, app_role, tip_based, bonus_eligible")
    .eq("auth_user_id", user.id)
    .eq("active", true)
    .maybeSingle();
  if (!data) return null;
  return { userId: user.id, employee: data as Me["employee"] };
});

export async function requireMe(): Promise<Me> {
  const me = await getMe();
  if (!me) redirect("/no-access");
  return me;
}

export async function requireManager(): Promise<Me> {
  const me = await requireMe();
  if (me.employee.app_role === "employee") redirect("/");
  return me;
}

export async function requireAdmin(): Promise<Me> {
  const me = await requireMe();
  if (me.employee.app_role !== "admin") redirect("/");
  return me;
}

export function homeFor(me: Me): string {
  if (me.employee.app_role === "admin") return "/admin";
  if (me.employee.app_role === "shift_manager" && !me.employee.bonus_eligible) return "/manager/scores";
  return "/me";
}
