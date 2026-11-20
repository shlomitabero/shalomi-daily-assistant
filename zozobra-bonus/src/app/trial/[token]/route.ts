// Private trial login (no SMS needed). Enabled only while TRIAL_LOGIN_TOKEN
// and TRIAL_LOGIN_EMAIL are set on the server; remove them to switch it off.
// The server creates a one-time sign-in for that single email and sets the
// session cookie directly — nothing is emailed.
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { publicUrl } from "@/lib/public-url";

export const dynamic = "force-dynamic";

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const expected = process.env.TRIAL_LOGIN_TOKEN ?? "";
  const email = process.env.TRIAL_LOGIN_EMAIL ?? "";
  const { token } = await params;
  if (expected.length < 32 || !email || !same(token, expected)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const admin = createAdminClient();
  // create the login if it does not exist yet (ignore "already registered")
  await admin.auth.admin.createUser({ email, email_confirm: true }).catch(() => null);
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data?.properties?.hashed_token) {
    return new NextResponse(`שגיאה ביצירת כניסה: ${error?.message ?? "unknown"}`, { status: 500 });
  }

  const sb = await createClient();
  const { error: vErr } = await sb.auth.verifyOtp({ type: "magiclink", token_hash: data.properties.hashed_token });
  if (vErr) return new NextResponse(`שגיאה בכניסה: ${vErr.message}`, { status: 500 });

  return NextResponse.redirect(publicUrl(req, "/"));
}
