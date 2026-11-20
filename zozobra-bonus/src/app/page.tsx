import { redirect } from "next/navigation";
import { getMe, homeFor } from "@/lib/auth";

export default async function Home() {
  const me = await getMe();
  redirect(me ? homeFor(me) : "/no-access");
}
