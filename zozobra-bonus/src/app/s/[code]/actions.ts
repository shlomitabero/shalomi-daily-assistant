"use server";

import { headers } from "next/headers";
import { clientHash, findSurveyTarget, submitSurvey } from "@/lib/survey";

export async function sendSurvey(_: unknown, form: FormData): Promise<{ done?: boolean; error?: string }> {
  const t = await findSurveyTarget(String(form.get("code") ?? ""));
  if (!t) return { error: "הקישור אינו פעיל" };
  const overall = Number(form.get("overall"));
  const service = Number(form.get("service"));
  if (![1, 2, 3, 4, 5].includes(overall) || ![1, 2, 3, 4, 5].includes(service)) {
    return { error: "נא לבחור דירוג בשתי השאלות" };
  }
  const comment = String(form.get("comment") ?? "").trim().slice(0, 500) || null;
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "unknown";
  const r = await submitSurvey(t, overall, service, comment, clientHash(ip, h.get("user-agent") ?? ""));
  if (!r.ok) return { error: r.reason === "already" ? "כבר דירגת היום — תודה!" : "נשלחו יותר מדי דירוגים מהמכשיר הזה" };
  return { done: true };
}
