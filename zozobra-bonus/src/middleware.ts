import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { publicUrl } from "@/lib/public-url";

const PUBLIC = ["/login", "/manifest.webmanifest", "/sw.js", "/offline", "/no-access", "/trial"];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC.some((p) => path === p || path.startsWith(`${p}/`));

  if (!user && !isPublic) {
    return redirectWithCookies(publicUrl(request, "/login"), response);
  }
  if (user && path === "/login") {
    return redirectWithCookies(publicUrl(request, "/"), response);
  }
  return response;
}

// keep any refreshed session cookies on the redirect
function redirectWithCookies(url: URL, from: NextResponse) {
  const res = NextResponse.redirect(url);
  for (const c of from.cookies.getAll()) res.cookies.set(c);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icons/|templates/|.*\\.(?:png|svg|ico|webp)$).*)"],
};
