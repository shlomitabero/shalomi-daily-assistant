import type { NextFunction, Request, Response } from "express";
import { getSessionUser, type ForgeDatabase } from "@forge/db";
import { HttpError } from "../httpError.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(db: ForgeDatabase) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
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
    next();
  };
}
