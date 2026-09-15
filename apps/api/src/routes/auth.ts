import { randomBytes, randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  createSession,
  createUser,
  deleteSession,
  findUserByEmail,
  findUserById,
  DuplicateEmailError,
  type ForgeDatabase,
} from "@forge/db";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { requireAuth } from "../auth/middleware.js";
import { HttpError } from "../httpError.js";

const CredentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "password must be at least 8 characters"),
});

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function issueSession(db: ForgeDatabase, userId: string): string {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  createSession(db, { token, userId, expiresAt });
  return token;
}

export function createAuthRouter(db: ForgeDatabase): Router {
  const router = Router();

  router.post("/auth/signup", (req, res, next) => {
    const parsed = CredentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      next(new HttpError(400, parsed.error.message, "VALIDATION_ERROR"));
      return;
    }
    try {
      const { email, password } = parsed.data;
      const user = createUser(db, { id: randomUUID(), email, passwordHash: hashPassword(password) });
      const token = issueSession(db, user.id);
      res.status(201).json({ user, token });
    } catch (err) {
      if (err instanceof DuplicateEmailError) {
        next(new HttpError(409, err.message, "EMAIL_TAKEN"));
        return;
      }
      next(err);
    }
  });

  router.post("/auth/login", (req, res, next) => {
    const parsed = CredentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      next(new HttpError(400, parsed.error.message, "VALIDATION_ERROR"));
      return;
    }
    const { email, password } = parsed.data;
    const record = findUserByEmail(db, email);
    if (!record || !verifyPassword(password, record.passwordHash)) {
      next(new HttpError(401, "Invalid email or password", "INVALID_CREDENTIALS"));
      return;
    }
    const token = issueSession(db, record.id);
    res.json({ user: { id: record.id, email: record.email, createdAt: record.createdAt }, token });
  });

  router.get("/auth/me", requireAuth(db), (req, res, next) => {
    const user = findUserById(db, req.userId!);
    if (!user) {
      next(new HttpError(404, "User not found", "USER_NOT_FOUND"));
      return;
    }
    res.json({ user });
  });

  router.post("/auth/logout", requireAuth(db), (req, res) => {
    const header = req.header("authorization") ?? "";
    const token = header.slice("Bearer ".length);
    deleteSession(db, token);
    res.status(204).end();
  });

  return router;
}
