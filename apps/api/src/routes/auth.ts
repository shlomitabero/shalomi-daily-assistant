import { randomBytes, randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  createSession,
  createUser,
  deleteSession,
  findUserByEmail,
  getPasswordHash,
  updatePasswordHash,
  DuplicateEmailError,
  type ForgeDatabase,
} from "@forge/db";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { extractBearerToken, requireAuth } from "../auth/middleware.js";
import { formatValidationError, HttpError } from "../httpError.js";

const CredentialsSchema = z.object({
  // Emails are case-insensitive in practice (RFC 5321 makes the local part
  // technically case-sensitive, but no mainstream provider treats it that
  // way) -- normalizing here, at the one point every signup/login goes
  // through, keeps uniqueness checks and later logins consistent no matter
  // which casing someone happens to type.
  email: z.string().email().transform((email) => email.toLowerCase()),
  password: z.string().min(8, "password must be at least 8 characters"),
});

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, "currentPassword is required"),
  newPassword: z.string().min(8, "newPassword must be at least 8 characters"),
});

/**
 * verifyPassword's scrypt call costs tens of milliseconds -- login used to
 * only run it when the email matched a real user (`!record ||
 * !verifyPassword(...)` short-circuits before ever calling verifyPassword
 * when `record` is undefined), so a login for an email that doesn't exist
 * at all returned in well under 1ms while a login with the right email but
 * a wrong password took the full scrypt cost. That's a reliable,
 * easily-measured timing side-channel letting an attacker enumerate
 * registered emails without ever seeing a different response body or
 * status code. This dummy hash exists purely so verifyPassword (and its
 * scrypt cost) always runs exactly once per login attempt, whether or not
 * the account exists -- nothing is ever meant to match it. Computed once,
 * at module load, and awaited on first use; every login after the first
 * reuses the already-resolved value.
 */
const dummyPasswordHashPromise: Promise<string> = hashPassword(randomBytes(32).toString("hex"));

function issueSession(db: ForgeDatabase, userId: string): string {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  createSession(db, { token, userId, expiresAt });
  return token;
}

export function createAuthRouter(db: ForgeDatabase): Router {
  const router = Router();

  router.post("/auth/signup", async (req, res, next) => {
    const parsed = CredentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      next(new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR"));
      return;
    }
    try {
      const { email, password } = parsed.data;
      const passwordHash = await hashPassword(password);
      const user = createUser(db, { id: randomUUID(), email, passwordHash });
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

  router.post("/auth/login", async (req, res, next) => {
    const parsed = CredentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      next(new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR"));
      return;
    }
    try {
      const { email, password } = parsed.data;
      const record = findUserByEmail(db, email);
      // Always call verifyPassword, even when no such user exists (against
      // the dummy hash above) -- see dummyPasswordHashPromise's comment for why.
      const passwordMatches = await verifyPassword(password, record?.passwordHash ?? (await dummyPasswordHashPromise));
      if (!record || !passwordMatches) {
        next(new HttpError(401, "Invalid email or password", "INVALID_CREDENTIALS"));
        return;
      }
      const token = issueSession(db, record.id);
      res.json({ user: { id: record.id, email: record.email, createdAt: record.createdAt }, token });
    } catch (err) {
      next(err);
    }
  });

  router.get("/auth/me", requireAuth(db), (req, res) => {
    // requireAuth's own lookup (an INNER JOIN against users) already proved
    // this user row exists on this exact request -- no route in this app
    // ever deletes a user, so re-querying it here would only ever find the
    // same row requireAuth already fetched. Reusing that row instead of a
    // second, always-redundant DB round-trip.
    res.json({ user: req.user! });
  });

  router.post("/auth/logout", requireAuth(db), (req, res) => {
    // requireAuth already validated this exact header on this request, so
    // the token is guaranteed present here.
    deleteSession(db, extractBearerToken(req)!);
    res.status(204).end();
  });

  /**
   * There was previously no way to change a password once an account
   * existed -- a genuine gap for anyone actually using this app day to
   * day. Requires the *current* password (not just the session token) so
   * someone briefly at an already-logged-in device can't silently lock
   * the real owner out; unlike signup/login there's no account to
   * enumerate here (the caller is already proven to be this exact user by
   * requireAuth), so this doesn't need the timing-side-channel defense
   * login uses. Doesn't invalidate any other active session -- this app's
   * session model has no bulk-revoke-by-user mechanism to begin with, and
   * adding one is a bigger change than this route's own scope.
   */
  router.patch("/auth/password", requireAuth(db), async (req, res, next) => {
    const parsed = ChangePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      next(new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR"));
      return;
    }
    try {
      const { currentPassword, newPassword } = parsed.data;
      const storedHash = getPasswordHash(db, req.userId!);
      if (!storedHash || !(await verifyPassword(currentPassword, storedHash))) {
        next(new HttpError(401, "Current password is incorrect", "INVALID_CURRENT_PASSWORD"));
        return;
      }
      const newHash = await hashPassword(newPassword);
      updatePasswordHash(db, req.userId!, newHash);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
