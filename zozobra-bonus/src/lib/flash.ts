import { redirect } from "next/navigation";

export function back(path: string, params: Record<string, string | undefined>): never {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  redirect(`${path}${q.size ? `?${q}` : ""}`);
}
