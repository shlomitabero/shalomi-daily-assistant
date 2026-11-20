import type { NextRequest } from "next/server";

/**
 * Absolute URL on the public host. Behind a proxy (Railway) the server sees
 * its internal address (localhost:8080), so use the forwarded host/proto.
 */
export function publicUrl(req: NextRequest, pathname: string): URL {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return new URL(pathname, `${proto}://${host}`);
}
