import type { NextFunction, Request, Response } from "express";
import type { User } from "@forge/shared";
import { getSessionUser, type ForgeDatabase } from "@forge/db";
import { HttpError } from "../httpError.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      user?: User;
    }
  }
}

/**
 * The "Bearer" scheme name is case-insensitive per RFC 7235 (only the
 * token value after it is taken as-is), and this is the one place that
 * extraction happens -- logout (routes/auth.ts) reuses it too, instead of
 * re-parsing the header itself and silently drifting out of sync with
 * whatever requireAuth already validated on the same request.
 */
export function extractBearerToken(req: Request): string | undefined {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

export function requireAuth(db: ForgeDatabase) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);
    if (!token) {
      next(new HttpError(401, "Missing Authorization header", "AUTH_REQUIRED"));
      return;
    }
    const user = getSessionUser(db, token);
    if (!user) {
      next(new HttpError(401, "Invalid or expired session", "SESSION_EXPIRED"));
      return;
    }
    req.userId = user.id;
    req.user = user;
    next();
  };
}
