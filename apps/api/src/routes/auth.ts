import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  createLoginCode,
  createPasswordResetToken,
  createSession,
  createUser,
  deleteAllSessionsForUser,
  deleteLoginCode,
  deleteLoginCodesForUser,
  deleteOtherSessionsForUser,
  deletePasswordResetToken,
  deletePasswordResetTokensForUser,
  deleteSession,
  deleteUser,
  deleteProject,
  findUserByEmail,
  findUserById,
  getLoginCode,
  getPasswordHash,
  getPasswordResetTokenByHash,
  incrementLoginCodeAttempts,
  listOwnedProjectIds,
  removeAllCollaborationsForUser,
  updatePasswordHash,
  DuplicateEmailError,
  type ForgeDatabase,
} from "@forge/db";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { extractBearerToken, requireAuth } from "../auth/middleware.js";
import { createRateLimiter } from "../auth/rateLimit.js";
import { formatValidationError, HttpError } from "../httpError.js";
import type { EmailSender } from "../email.js";
import type { WhatsAppWebManager } from "../whatsappWeb.js";
import { deleteProjectUploads } from "./projects.js";

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

const ForgotPasswordSchema = z.object({
  email: z.string().email().transform((email) => email.toLowerCase()),
  lang: z.enum(["he", "en"]).optional(),
});

const ResetPasswordSchema = z.object({
  token: z.string().min(1, "token is required"),
  newPassword: z.string().min(8, "newPassword must be at least 8 characters"),
});

const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * The token itself is never stored -- only this hash -- so a DB leak alone
 * can't be replayed into a password reset the same way a leaked session
 * token could. Deliberately the same fast sha256 hashLoginCode above
 * already uses, not hashPassword's scrypt: this token's real defense is
 * its own 256 bits of randomness + the TTL, not hash cost (see
 * passwordResetTokens.ts's own doc comment for why no attempts-counter is
 * needed either).
 */
function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

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

export function createAuthRouter(
  db: ForgeDatabase,
  whatsapp: WhatsAppWebManager,
  emailSender: EmailSender,
  activePipelines: Set<string>,
  uploadsDir: string,
): Router {
  const router = Router();

  /**
   * There was previously no limit at all on how many times any of these
   * routes could be called -- verifyPassword's scrypt cost (see
   * dummyPasswordHashPromise's own comment) is real attacker-side CPU, not
   * a server-enforced limit, so an unbounded /auth/login loop could
   * brute-force a password at whatever rate the attacker's own hardware
   * allows; an unbounded /auth/signup loop could mass-create
   * accounts/rows; and an unbounded /auth/forgot-password loop against a
   * known victim email sends that victim a real reset email on every
   * single call with no throttle at all (email-bombing their inbox, and
   * burning this deployment's Resend quota). Keyed by IP for
   * signup/login/verify-code/reset-password -- the realistic attack there
   * is one machine iterating quickly -- but by the target *email* for
   * forgot-password, since the actual harm (spamming one inbox) doesn't
   * depend on which IP the request comes from, and by the authenticated
   * *user id* for change-password (round 896), since that route's own
   * identity is already established by requireAuth before it ever runs.
   * Created fresh per
   * createAuthRouter() call, the same convention app.ts's own
   * `activePipelines` already follows, so app.test.ts's withServer (which
   * calls createApp() fresh per test) never leaks rate-limit state between
   * unrelated tests.
   */
  const signupRateLimiter = createRateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: 20,
    keyGenerator: (req) => req.ip ?? "unknown",
    message: "Too many signup attempts. Please try again later.",
  });
  const loginRateLimiter = createRateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: 30,
    keyGenerator: (req) => req.ip ?? "unknown",
    message: "Too many login attempts. Please try again later.",
  });
  const forgotPasswordRateLimiter = createRateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: 5,
    keyGenerator: (req) => String(req.body?.email ?? "").toLowerCase(),
    message: "Too many password reset requests for this email. Please try again later.",
  });
  /**
   * Round 857: every other unauthenticated POST route in this exact login
   * flow (above) already has a volumetric throttle; this one, the literal
   * second half of /auth/login's own email-code flow, had none. This is
   * NOT a code-guessing defense -- that's already fully handled by
   * MAX_LOGIN_CODE_ATTEMPTS, a permanent per-row cap (5 wrong guesses and
   * the row is deleted, regardless of request rate or time window) that a
   * sliding-window limiter can't improve on and would be redundant with if
   * keyed the same way. Keyed by IP instead, same rationale as
   * signup/login above, this closes the separate, previously-unguarded gap
   * of unbounded REQUEST VOLUME against the cheapest unauthenticated POST
   * endpoint in the whole API (sha256 + timingSafeEqual, no scrypt) --
   * flooding it with garbage loginCodeId values costs this server a DB
   * lookup per request with no throttle at all, unlike every sibling route.
   */
  const verifyLoginCodeRateLimiter = createRateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: 30,
    keyGenerator: (req) => req.ip ?? "unknown",
    message: "Too many login code attempts. Please try again later.",
  });
  /**
   * Round 894: the one unauthenticated POST route in this exact file that
   * was missed when the comment above added throttles to its four
   * siblings. Not a token-guessing defense -- the reset token is a
   * high-entropy random value (see hashResetToken/getPasswordResetToken
   * ByHash), so brute-forcing it is already infeasible regardless of any
   * rate limit. This closes the same separate gap verifyLoginCodeRateLimiter
   * above closed for its own route: unbounded REQUEST VOLUME against the
   * cheapest unauthenticated POST endpoint in the whole API (sha256 +
   * timingSafeEqual, no scrypt) -- flooding it with garbage tokens costs
   * this server a real DB lookup per request with no throttle at all,
   * unlike every sibling route. Keyed by IP, same rationale as
   * signup/login/verify-code above (the realistic attack is one machine
   * iterating quickly, not a targeted-victim attack the way forgot-
   * password's own email-keyed limiter defends against).
   */
  const resetPasswordRateLimiter = createRateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: 30,
    keyGenerator: (req) => req.ip ?? "unknown",
    message: "Too many password reset attempts. Please try again later.",
  });
  /**
   * Round 896: the one credential-CHECKING route in this exact file that
   * stayed unthrottled -- every sibling that calls verifyPassword/compares
   * a secret (login, verify-code, now reset-password's own lookup) got a
   * rate limiter in rounds 857/894; this one, PATCH /auth/password's own
   * `currentPassword` check, was missed. Unlike those routes, the caller
   * here already holds a valid session token (requireAuth ran first) --
   * the realistic attacker is someone who stole or is sharing that token
   * but doesn't know the real password, using it to brute-force the
   * account's actual credential at whatever rate their own hardware
   * allows (scrypt's own cost is real but attacker-side, not a
   * server-enforced limit -- the same rationale this file's very first
   * rate-limiter comment above gives for /auth/login). Keyed by the
   * authenticated user's own id (requireAuth runs first in the chain
   * below, so req.userId is already set) rather than IP, since the
   * identity is already established here and the harm is scoped to this
   * one account regardless of which IP the stolen token is used from.
   */
  const changePasswordRateLimiter = createRateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: 30,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many password change attempts. Please try again later.",
  });

  router.post("/auth/signup", signupRateLimiter, async (req, res, next) => {
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

  router.post("/auth/login", loginRateLimiter, async (req, res, next) => {
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
      const code = generateLoginCode();
      const loginCodeId = randomUUID();
      const isHebrew = lang !== "en";
      const subject = isHebrew ? `קוד ההתחברות שלך: ${code}` : `Your login code: ${code}`;
      const body = isHebrew
        ? `קוד ההתחברות שלך ל-Forge AI הוא: ${code}\n\nהקוד בתוקף ל-10 דקות. אם לא ניסית להתחבר, אפשר להתעלם מהודעה זו.`
        : `Your Forge AI login code is: ${code}\n\nThis code expires in 10 minutes. If you didn't try to log in, you can ignore this email.`;
      try {
        await emailSender.send(record.email, subject, body);
      } catch (err) {
        // Nothing was ever written, so there's no row to clean up here --
        // unlike before this fix (round 538), the DB write now happens only
        // after send() succeeds (see below), precisely to avoid needing
        // this kind of compensating delete.
        next(new HttpError(502, `Failed to send the login code email: ${(err as Error).message}`, "EMAIL_SEND_FAILED"));
        return;
      }
      // The insert (and the invalidation of any older pending code for this
      // account -- see deleteLoginCodesForUser's own doc comment) happens
      // only now, after the genuine network await above, with no further
      // await before the response: two concurrent logins for the same
      // account used to both run their insert *before* their own send()
      // call, so whichever one's send() resolved first could invalidate the
      // other's already-inserted row while that other request was still
      // parked on its own send() -- that other request would then respond
      // with a loginCodeId already deleted out from under it (round 538).
      // Doing the write+respond here instead, synchronously, means nothing
      // can interleave between this exact request minting its row and
      // naming it in the response it sends -- the same "no await = no
      // race" guarantee the rest of this codebase already relies on.
      deleteLoginCodesForUser(db, record.id);
      createLoginCode(db, {
        id: loginCodeId,
        userId: record.id,
        codeHash: hashLoginCode(code),
        expiresAt: new Date(Date.now() + LOGIN_CODE_TTL_MS).toISOString(),
      });
      res.json({ requiresCode: true, loginCodeId });
    } catch (err) {
      next(err);
    }
  });

  /**
   * The second step of the email-login-code flow above: the code itself was
   * never sent back in the first response, only the opaque loginCodeId, so
   * this is the one place that can actually complete a login once the code
   * step is active. See verifyLoginCodeRateLimiter's own comment above for
   * why this route needed the same volumetric throttle as its siblings.
   */
  router.post("/auth/login/verify-code", verifyLoginCodeRateLimiter, async (req, res, next) => {
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

  /**
   * The one place a forgotten (not just mistyped-at-signup) password was
   * previously unrecoverable at all -- see AuthScreen.tsx's own comment on
   * this exact gap. Always responds with the same generic `{ sent: true }`
   * regardless of whether `email` matches a real account -- the defense
   * against account enumeration via this route, mirroring /auth/login's own
   * "never a different status/body for a nonexistent account" rule.
   * Deliberately does NOT also chase /auth/login's RESPONSE-TIMING defense
   * (dummyPasswordHashPromise): the gap here is a genuine network
   * email-send await with no cheap, risk-free dummy equivalent, a smaller
   * and harder-to-exploit residual risk than a differing status code or
   * body would be.
   */
  router.post("/auth/forgot-password", forgotPasswordRateLimiter, async (req, res, next) => {
    const parsed = ForgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      next(new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR"));
      return;
    }
    try {
      const { email, lang } = parsed.data;
      // Unlike the login-code step (which simply skips itself when email
      // isn't configured, since logging in with just a password still
      // works fine without it), there is no fallback path for a password
      // reset with no way to deliver the link -- so this responds with a
      // clear, honest error instead of a silent, permanent no-op. This
      // check runs before looking up the account at all: whether email is
      // configured is a deployment-wide fact, not something tied to any
      // specific address, so returning it early here isn't an enumeration
      // vector the way a per-account difference would be.
      if (!emailSender.configured) {
        next(
          new HttpError(
            503,
            "Password reset isn't available on this deployment yet -- no email provider is configured",
            "EMAIL_NOT_CONFIGURED",
          ),
        );
        return;
      }
      const record = findUserByEmail(db, email);
      if (record) {
        const token = randomBytes(32).toString("hex");
        // req.protocol/req.get("host") reflect the real public-facing
        // scheme/host here (see app.ts's own "trust proxy" comment) --
        // this app serves its own frontend from the exact same origin as
        // this API, so there's no separate "frontend URL" to configure.
        const resetUrl = `${req.protocol}://${req.get("host")}/?resetToken=${token}`;
        const isHebrew = lang !== "en";
        const subject = isHebrew ? "איפוס סיסמה ל-Forge AI" : "Reset your Forge AI password";
        const body = isHebrew
          ? `קיבלנו בקשה לאפס את הסיסמה שלך. לחצו על הקישור הבא כדי לבחור סיסמה חדשה:\n\n${resetUrl}\n\nהקישור בתוקף לשעה אחת. אם לא בקשתם זאת, אפשר להתעלם מהודעה זו -- הסיסמה שלכם לא תשתנה.`
          : `We received a request to reset your password. Click the link below to choose a new one:\n\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email -- your password won't change.`;
        try {
          await emailSender.send(record.email, subject, body);
        } catch {
          // Swallowed, deliberately -- unlike the login-code email (where a
          // failed send leaves the user visibly stuck mid-login and needs
          // to be reported), surfacing this one would mean "account exists
          // but the email failed" responds differently than "no such
          // account", which is itself an enumeration oracle. The response
          // below stays identical either way.
        }
        deletePasswordResetTokensForUser(db, record.id);
        createPasswordResetToken(db, {
          id: randomUUID(),
          userId: record.id,
          tokenHash: hashResetToken(token),
          expiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS).toISOString(),
        });
      }
      res.json({ sent: true });
    } catch (err) {
      next(err);
    }
  });

  /**
   * The second half of the flow above: the link emailed by /auth/forgot-
   * password carries this exact token. A reset is the "I may have lost
   * control of this account" case, unlike PATCH /auth/password below
   * (which requires knowing the *current* password and so keeps this
   * exact request's own session alive) -- there is no prior session of
   * this request's own to preserve, so every existing session is revoked,
   * forcing a fresh login with the new password on every device.
   */
  router.post("/auth/reset-password", resetPasswordRateLimiter, async (req, res, next) => {
    const parsed = ResetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      next(new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR"));
      return;
    }
    try {
      const { token, newPassword } = parsed.data;
      const pending = getPasswordResetTokenByHash(db, hashResetToken(token));
      const expired = !pending || new Date(pending.expiresAt).getTime() < Date.now();
      if (expired) {
        if (pending) deletePasswordResetToken(db, pending.id);
        next(new HttpError(401, "This reset link has expired or is invalid. Please request a new one.", "RESET_TOKEN_INVALID"));
        return;
      }
      deletePasswordResetToken(db, pending.id);
      const user = findUserById(db, pending.userId);
      if (!user) {
        next(new HttpError(401, "This account no longer exists", "USER_NOT_FOUND"));
        return;
      }
      const newHash = await hashPassword(newPassword);
      updatePasswordHash(db, user.id, newHash);
      deleteAllSessionsForUser(db, user.id);
      res.status(204).end();
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
  router.patch("/auth/password", requireAuth(db), changePasswordRateLimiter, async (req, res, next) => {
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
      // Round 539: both scrypt calls above are genuine awaits (offloaded to
      // libuv's threadpool -- see this file's own doc comment on
      // hashPassword/verifyPassword), long enough for a concurrent DELETE
      // /auth/account using this same still-valid token to run to
      // completion and delete this user row entirely before either resolves.
      // Without this re-check, the writes below would both silently affect
      // zero rows and this handler would still report 204, as if the
      // password change succeeded on an account that no longer exists.
      if (!findUserById(db, req.userId!)) {
        next(new HttpError(401, "This account no longer exists", "USER_NOT_FOUND"));
        return;
      }
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
   *
   * Round 535: the per-project loop below now also guards itself with the
   * same `activePipelines` Set routes/projects.ts's own routes use (shared
   * via app.ts, not declared separately here) -- this loop's own
   * whatsapp.disconnect() await is the same reverse-direction hazard
   * DELETE /projects/:id's own comment already documents, except here a
   * COLLABORATOR's own still-valid session (never revoked by
   * deleteAllSessionsForUser above, which only ever touches the account
   * being deleted) is the one who could otherwise race it.
   */
  router.delete("/auth/account", requireAuth(db), async (req, res, next) => {
    try {
      const ownedProjectIds = listOwnedProjectIds(db, req.userId!);
      // Round 537: the per-project loop below is destructive and
      // irreversible one project at a time -- checking activePipelines
      // only as each project is reached (as round 535 originally did)
      // meant a LATER project's in-flight pipeline aborted the whole
      // handler (409) only after every EARLIER project in the loop had
      // already been permanently deleted, while deleteAllSessionsForUser
      // (below) had already logged the owner out everywhere and
      // removeAllCollaborationsForUser/deleteUser never ran -- a
      // non-atomic "partial delete reported as failure" with no recovery
      // and no account actually removed. Checking every owned project's
      // activePipelines status up front, then reserving all of them in
      // the same synchronous pass (no await in between, so nothing else
      // on this single-threaded process can interleave), makes the whole
      // operation all-or-nothing: either every owned project is free to
      // delete and gets reserved before anything destructive starts, or
      // the request fails immediately with nothing touched at all --
      // sessions still valid, every project still intact.
      if (ownedProjectIds.some((id) => activePipelines.has(id))) {
        throw new HttpError(409, "A build or refine is already running for one of your projects", "PIPELINE_IN_PROGRESS");
      }
      for (const id of ownedProjectIds) activePipelines.add(id);
      try {
        // Revokes every session -- including this very request's own token --
        // as the first thing this handler does once the check above has
        // passed, synchronously, before any of the real async I/O below.
        // whatsapp.disconnect() awaits a genuine network round-trip
        // (session.sock.logout(), see whatsappWeb.ts's own comment)
        // whenever a project has a live WhatsApp connection, and that used
        // to run while this account's token was still valid. Round 424:
        // while suspended on that await, an unrelated POST /projects using
        // the same still-valid token could create a brand-new project whose
        // id was never in listOwnedProjectIds' own snapshot above (taken
        // once, up front) -- and since projects.ownerId carries no
        // foreign-key constraint to users.id, deleteUser further down still
        // succeeded, permanently orphaning that project under a user id
        // that no longer exists anywhere, reachable by no route ever again.
        // Revoking first closes the window: any request racing this one
        // now fails requireAuth before it can do anything, for the same
        // reason the existing "the deleted user's own session token must
        // stop working immediately" check below already expects.
        deleteAllSessionsForUser(db, req.userId!);
        for (const projectId of ownedProjectIds) {
          // Round 535: same activePipelines guard DELETE /projects/:id
          // (routes/projects.ts) already sets around this exact await, for
          // the exact same reason -- this loop's own whatsapp.disconnect()
          // is a genuine network round-trip whenever that project has a
          // live WhatsApp Web connection, and every ordinary quick mutation
          // route in routes/projects.ts only *checks* activePipelines, never
          // sets it. A collaborator on this project (whose own session this
          // route never touches -- deleteAllSessionsForUser above only ever
          // revokes the ACCOUNT BEING DELETED's own sessions) could use
          // their own still-valid token to read the still-present project
          // row during this window, run an edit to completion, and get back
          // a 200 for a change that deleteProject() below erases moments
          // later with no error ever reaching them. Already reserved for
          // every owned project id above, so this loop never needs to
          // re-check or re-add/remove per iteration.
          await whatsapp.disconnect(projectId).catch(() => {});
          deleteProject(db, projectId);
          await deleteProjectUploads(uploadsDir, projectId);
        }
        removeAllCollaborationsForUser(db, req.userId!);
        deleteUser(db, req.userId!);
      } finally {
        for (const id of ownedProjectIds) activePipelines.delete(id);
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
