import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  createLoginCode,
  createSession,
  createUser,
  deleteAllSessionsForUser,
  deleteLoginCode,
  deleteLoginCodesForUser,
  deleteOtherSessionsForUser,
  deleteSession,
  deleteUser,
  deleteProject,
  findUserByEmail,
  findUserById,
  getLoginCode,
  getPasswordHash,
  incrementLoginCodeAttempts,
  listOwnedProjectIds,
  removeAllCollaborationsForUser,
  updatePasswordHash,
  DuplicateEmailError,
  type ForgeDatabase,
} from "@forge/db";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { extractBearerToken, requireAuth } from "../auth/middleware.js";
import { formatValidationError, HttpError } from "../httpError.js";
import type { EmailSender } from "../email.js";
import type { WhatsAppWebManager } from "../whatsappWeb.js";

const CredentialsSchema = z.object({
  // Emails are case-insensitive in practice (RFC 5321 makes the local part
  // technically case-sensitive, but no mainstream provider treats it that
  // way) -- normalizing here, at the one point every signup/login goes
  // through, keeps uniqueness checks and later logins consistent no matter
  // which casing someone happens to type.
  email: z.string().email().transform((email) => email.toLowerCase()),
  password: z.string().min(8, "password must be at least 8 characters"),
  // Client-supplied, same convention as POST /projects/from-template's own
  // `lang` param (round 492) -- the server has no other way to know which
  // language the login-code email should be written in.
  lang: z.enum(["he", "en"]).optional(),
});

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, "currentPassword is required"),
  newPassword: z.string().min(8, "newPassword must be at least 8 characters"),
});

const VerifyLoginCodeSchema = z.object({
  loginCodeId: z.string().min(1, "loginCodeId is required"),
  code: z.string().min(1, "code is required"),
});

const LOGIN_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_LOGIN_CODE_ATTEMPTS = 5;

function generateLoginCode(): string {
  // randomInt, not Math.random -- this gates a real login, so it needs a
  // cryptographically secure source the same way the session token
  // (randomBytes) already does.
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * The code itself is never stored -- only this hash -- so a DB leak alone
 * can't be replayed into a login the way a leaked session token could.
 * Deliberately a fast hash, not hashPassword's scrypt: a 6-digit code's
 * real defense is MAX_LOGIN_CODE_ATTEMPTS + the short TTL, not hash cost
 * (unlike a password, which has no attempt limit of its own and must resist
 * offline brute force on a leaked hash by itself).
 */
function hashLoginCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function loginCodeMatches(input: string, storedHash: string): boolean {
  const inputHash = Buffer.from(hashLoginCode(input), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (inputHash.length !== stored.length) return false;
  return timingSafeEqual(inputHash, stored);
}

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

export function createAuthRouter(db: ForgeDatabase, whatsapp: WhatsAppWebManager, emailSender: EmailSender): Router {
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
      const { email, password, lang } = parsed.data;
      const record = findUserByEmail(db, email);
      // Always call verifyPassword, even when no such user exists (against
      // the dummy hash above) -- see dummyPasswordHashPromise's comment for why.
      const passwordMatches = await verifyPassword(password, record?.passwordHash ?? (await dummyPasswordHashPromise));
      if (!record || !passwordMatches) {
        next(new HttpError(401, "Invalid email or password", "INVALID_CREDENTIALS"));
        return;
      }
      // emailSender.configured is false whenever RESEND_API_KEY hasn't been
      // set -- a deployment that never set up an email provider logs in
      // exactly like before this feature existed. Setting that one
      // environment variable is what turns the code step on at all.
      if (!emailSender.configured) {
        const token = issueSession(db, record.id);
        res.json({ user: { id: record.id, email: record.email, createdAt: record.createdAt }, token });
        return;
      }
      // At most one pending code per account at a time -- see
      // deleteLoginCodesForUser's own doc comment.
      deleteLoginCodesForUser(db, record.id);
      const code = generateLoginCode();
      const loginCodeId = randomUUID();
      createLoginCode(db, {
        id: loginCodeId,
        userId: record.id,
        codeHash: hashLoginCode(code),
        expiresAt: new Date(Date.now() + LOGIN_CODE_TTL_MS).toISOString(),
      });
      const isHebrew = lang !== "en";
      const subject = isHebrew ? `קוד ההתחברות שלך: ${code}` : `Your login code: ${code}`;
      const body = isHebrew
        ? `קוד ההתחברות שלך ל-Forge AI הוא: ${code}\n\nהקוד בתוקף ל-10 דקות. אם לא ניסית להתחבר, אפשר להתעלם מהודעה זו.`
        : `Your Forge AI login code is: ${code}\n\nThis code expires in 10 minutes. If you didn't try to log in, you can ignore this email.`;
      try {
        await emailSender.send(record.email, subject, body);
      } catch (err) {
        // No code is valid without a successful send -- delete the row
        // rather than leave a row around nobody can ever satisfy.
        deleteLoginCode(db, loginCodeId);
        next(new HttpError(502, `Failed to send the login code email: ${(err as Error).message}`, "EMAIL_SEND_FAILED"));
        return;
      }
      res.json({ requiresCode: true, loginCodeId });
    } catch (err) {
      next(err);
    }
  });

  /**
   * The second step of the email-login-code flow above: the code itself was
   * never sent back in the first response, only the opaque loginCodeId, so
   * this is the one place that can actually complete a login once the code
   * step is active.
   */
  router.post("/auth/login/verify-code", async (req, res, next) => {
    const parsed = VerifyLoginCodeSchema.safeParse(req.body);
    if (!parsed.success) {
      next(new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR"));
      return;
    }
    try {
      const { loginCodeId, code } = parsed.data;
      const pending = getLoginCode(db, loginCodeId);
      const expired = !pending || new Date(pending.expiresAt).getTime() < Date.now() || pending.attempts >= MAX_LOGIN_CODE_ATTEMPTS;
      if (expired) {
        if (pending) deleteLoginCode(db, loginCodeId);
        next(new HttpError(401, "This login code has expired. Please log in again.", "LOGIN_CODE_EXPIRED"));
        return;
      }
      if (!loginCodeMatches(code, pending.codeHash)) {
        incrementLoginCodeAttempts(db, loginCodeId);
        next(new HttpError(401, "Incorrect code. Please try again.", "INVALID_LOGIN_CODE"));
        return;
      }
      deleteLoginCode(db, loginCodeId);
      const user = findUserById(db, pending.userId);
      if (!user) {
        next(new HttpError(401, "This account no longer exists", "USER_NOT_FOUND"));
        return;
      }
      const token = issueSession(db, user.id);
      res.json({ user, token });
    } catch (err) {
      next(err);
    }
  });

  router.get("/auth/me", requireAuth(db), (req, res) => {
    // requireAuth's own lookup (an INNER JOIN against users) already proved
    // this user row exists on this exact request -- reusing that row
    // instead of a second, always-redundant DB round-trip. (The only route
    // that ever deletes a user, DELETE /auth/account below, always ends
    // that user's own session first, so requireAuth would already reject
    // any request from them before this route could ever run against a
    // now-deleted row.)
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
   * login uses. Also revokes every one of this user's OTHER sessions
   * (deleteOtherSessionsForUser) -- the standard security purpose of a
   * password change, e.g. kicking out a lost laptop or a leaked token --
   * while deliberately keeping this exact request's own session alive, so
   * the 204 response below still has a valid session to return against.
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
      deleteOtherSessionsForUser(db, req.userId!, extractBearerToken(req)!);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  /**
   * Real, permanent self-service account deletion -- until now there was no
   * way for someone to actually leave: their data just sat here forever.
   * Follows the exact same cascade deleteProject already uses for a single
   * project, just for every project this user owns, then cleans up the two
   * other places a user id can still appear afterward: collaborator grants
   * on OTHER people's projects, and their own sessions (so this exact
   * request's token, and every other device they're logged in on, stops
   * working immediately). Only ever acts on req.userId! -- the id
   * requireAuth itself proved this session belongs to -- never a
   * client-supplied id, so there's no cross-user deletion surface here at all.
   *
   * Uses listOwnedProjectIds, not listProjectsForUser: the latter silently
   * excludes any project whose stored spec fails to re-parse against
   * today's (stricter) ProductSpecSchema (tryRowToProject's own comment --
   * a real, expected case for an older project). This cleanup can't afford
   * that: a project this route fails to see is never passed to
   * deleteProject, so its tables/checkpoints/WhatsApp data (and the
   * project row itself) outlive the user row this request is about to
   * delete -- permanently orphaned, with the request still reporting
   * success. listOwnedProjectIds never parses spec_json at all, so it
   * can't miss a project this way.
   */
  router.delete("/auth/account", requireAuth(db), async (req, res, next) => {
    try {
      // Revokes every session -- including this very request's own token --
      // as the first thing this handler does, synchronously, before any of
      // the real async I/O below. whatsapp.disconnect() awaits a genuine
      // network round-trip (session.sock.logout(), see whatsappWeb.ts's own
      // comment) whenever a project has a live WhatsApp connection, and that
      // used to run while this account's token was still valid. Round 424:
      // while suspended on that await, an unrelated POST /projects using
      // the same still-valid token could create a brand-new project whose
      // id was never in listOwnedProjectIds' own snapshot below (taken once,
      // up front) -- and since projects.ownerId carries no foreign-key
      // constraint to users.id, deleteUser further down still succeeded,
      // permanently orphaning that project under a user id that no longer
      // exists anywhere, reachable by no route ever again. Revoking first
      // closes the window: any request racing this one now fails
      // requireAuth before it can do anything, for the same reason the
      // existing "the deleted user's own session token must stop working
      // immediately" check below already expects.
      deleteAllSessionsForUser(db, req.userId!);
      const ownedProjectIds = listOwnedProjectIds(db, req.userId!);
      for (const projectId of ownedProjectIds) {
        await whatsapp.disconnect(projectId).catch(() => {});
        deleteProject(db, projectId);
      }
      removeAllCollaborationsForUser(db, req.userId!);
      deleteUser(db, req.userId!);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
