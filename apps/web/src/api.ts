import type { AgentStepEvent, CollaboratorRole, Checkpoint, EntityRecord, Field, Project, ProjectCollaborator, User } from "@forge/shared";

export type { CollaboratorRole };
import {
  detectInitialLang,
  resolveErrorMessage as resolveErrorMessageForLang,
  STORAGE_KEY as LANG_STORAGE_KEY,
} from "./i18n/language.js";
import { fetchWithWakeRetry } from "./wakeRetry.js";

const TOKEN_KEY = "forge.token";

type WakeListener = (waking: boolean) => void;
const wakeListeners = new Set<WakeListener>();

/** Lets App.tsx show a "waking up the server" message during a cold-start retry, without api.ts depending on React. */
export function subscribeWakeStatus(listener: WakeListener): () => void {
  wakeListeners.add(listener);
  return () => wakeListeners.delete(listener);
}

function notifyWaking(waking: boolean): void {
  for (const listener of wakeListeners) listener(waking);
}

/**
 * Wraps a waking(true/false) notifier with reference counting. Several
 * fetchApi() calls can be in flight at once during a real cold start (e.g.
 * a background status poll landing alongside a user action) -- each one
 * runs its own independent fetchWithWakeRetry retry loop and calls
 * onWaking(false) the moment *its own* retries finish, with no idea
 * whether a sibling request is still retrying. Without this wrapper,
 * whichever concurrent request's retry loop happens to finish first would
 * hide the "waking up" banner while another request is still genuinely
 * failing against a server that hasn't woken up yet. This makes the
 * notifier only fire false once every concurrent caller has released it.
 */
export function createWakeRefCounter(notify: (waking: boolean) => void): (waking: boolean) => void {
  let active = 0;
  return (waking: boolean) => {
    if (waking) {
      active += 1;
      if (active === 1) notify(true);
    } else if (active > 0) {
      active -= 1;
      if (active === 0) notify(false);
    }
  };
}

const notifyWakingRefCounted = createWakeRefCounter(notifyWaking);

type AuthExpiredListener = () => void;
const authExpiredListeners = new Set<AuthExpiredListener>();

/**
 * Lets App.tsx force a sign-out (back to the login screen) the moment ANY
 * request reports the session is gone -- a 401 SESSION_EXPIRED/AUTH_REQUIRED
 * previously only ever surfaced as that one request's own translated
 * inline error text (requireAuth already attaches the code, and
 * i18n/language.ts already carries the translated copy for it -- neither
 * was ever read past the point of building that one message). `user`
 * state stayed set and the rest of the authenticated UI kept rendering
 * with a now-useless stored token, so a session revoked from another
 * device/tab (password change, "sign out everywhere") or one that simply
 * expired left the person stuck until they happened to notice and
 * manually hit Logout.
 */
export function subscribeAuthExpired(listener: AuthExpiredListener): () => void {
  authExpiredListeners.add(listener);
  return () => authExpiredListeners.delete(listener);
}

function notifyAuthExpired(): void {
  for (const listener of authExpiredListeners) listener();
}

type ProjectGoneListener = (projectId: string, message: string) => void;
const projectGoneListeners = new Set<ProjectGoneListener>();

/**
 * Lets App.tsx reset to the home screen (same mechanism as
 * subscribeAuthExpired above) the moment a request reports the
 * currently-open project is gone -- requireProjectAccess/requireProjectOwner
 * (apps/api/src/routes/projects.ts) throw this exact, unambiguous code
 * whenever the project was deleted OR this account's own collaborator
 * access to it was just revoked, and every mutating/reading route on a
 * project goes through one of those two. Previously this surfaced only as
 * that one request's own translated inline error text ("Project not
 * found."), wherever it happened to fire from (a background refresh, a
 * mutation, anything) -- `project` stayed set and the whole project shell
 * (tabs, now-stale records) kept rendering, with every subsequent action
 * 404ing the exact same way forever and no path back to the project list.
 */
export function subscribeProjectGone(listener: ProjectGoneListener): () => void {
  projectGoneListeners.add(listener);
  return () => projectGoneListeners.delete(listener);
}

function notifyProjectGone(projectId: string, message: string): void {
  for (const listener of projectGoneListeners) listener(projectId, message);
}

type ViewerDemotedListener = (projectId: string) => void;
const viewerDemotedListeners = new Set<ViewerDemotedListener>();

/**
 * Round 886: App.tsx's own `myRole` is fetched exactly once, in
 * openExistingProject, with no revalidation path afterward -- there's no
 * poll, no websocket, and nothing else ever re-fetches it for an
 * already-open project. If the owner demotes this collaborator to
 * "viewer" (CollaboratorsPanel's own per-row role select) while the
 * project stays open in this browser, every write-affordance (the record
 * form, row Edit/Delete/Duplicate, board-card drag, bulk-selection,
 * Automations' Add/Delete, WhatsApp's Connect/Send/Delete, Time Machine's
 * Restore/Delete, etc.) kept rendering exactly as before -- the server
 * correctly rejects the very next write with a real 403 VIEWER_READ_ONLY
 * (requireProjectWriteAccess, apps/api/src/routes/projects.ts), but
 * nothing ever told the UI to actually hide the control that triggered
 * it, so the same confusing failure repeats indefinitely. (A collaborator
 * fully REMOVED, rather than merely demoted, is already covered by
 * subscribeProjectGone above -- requireProjectAccess throws
 * PROJECT_NOT_FOUND for that case, not VIEWER_READ_ONLY.) Mirrors
 * subscribeProjectGone's own project-id-scoped shape.
 */
export function subscribeViewerDemoted(listener: ViewerDemotedListener): () => void {
  viewerDemotedListeners.add(listener);
  return () => viewerDemotedListeners.delete(listener);
}

function notifyViewerDemoted(projectId: string): void {
  for (const listener of viewerDemotedListeners) listener(projectId);
}

/**
 * A generous ceiling on the *whole* request, retries included -- meant to be
 * comfortably above the server's own 60s Anthropic-call timeout (see
 * packages/spec-engine/src/anthropicFetch.ts's ANTHROPIC_REQUEST_TIMEOUT_MS)
 * plus real cold-start latency, but still a hard bound. Without this, a
 * request whose connection succeeds but whose response never arrives (a
 * stalled upstream call, or a Render cold start that happens not to surface
 * as a connection-level failure) hung forever with the UI stuck on a busy
 * spinner ("thinking it over…") and absolutely no feedback -- the real
 * report that originally motivated this.
 *
 * This same AbortController's signal covers every attempt inside
 * fetchWithWakeRetry, including its own retry backoff sleeps (see
 * wakeRetry.ts's own comment: Render's free tier can take "50+ seconds" to
 * wake, and DEFAULT_DELAYS_MS's seven delays sum to ~101s of that budget --
 * widened from an original ~49s after a real, repeated report ("it never
 * loads, always says the server is old") showed that ceiling had zero
 * margin above Render's own documented worst case, which this app hits on
 * every visit while no keep-alive ping is running) -- so this value must
 * stay comfortably above 101s of cold-start retrying plus however many 60s
 * Anthropic calls one request can legitimately make before the connection
 * ends. /build and most other routes make at most one (the Debug agent's
 * own requestSpecFix, only if diffAndMigrate throws); /refine makes TWO:
 * routes/projects.ts's own generateSpec() call, awaited *before*
 * streamPipeline() ever writes response headers, plus that same
 * requestSpecFix() fallback if the regenerated spec then fails to migrate --
 * both still gated by this one AbortController, since it's a single
 * long-lived SSE connection from the client's point of view. So the real
 * worst case is 101 + 60 + 60 = 221s, not 101 + 60 = 161s -- an earlier
 * version of this constant and its comment only counted one Anthropic call,
 * which would have let this exact combination (a cold start plus a
 * migration that needs the Debug agent's fix) be falsely aborted as "taking
 * too long" even though the server was never stalled. (An even earlier
 * version, 100s, was already less than a smaller 109s one-call worst case,
 * producing that same false-positive on the enhance-and-build flow -- the
 * bug this comment keeps needing to re-derive the math for.) This value
 * adds just under a minute of margin on top of the 221s worst case for
 * request/response transfer, JSON parsing, and DB writes, rather than
 * shaving it as close as possible to the theoretical minimum. Whenever
 * DEFAULT_DELAYS_MS's own total changes, or a route grows a third
 * sequential Anthropic call, this must be recalculated too.
 */
export const REQUEST_TIMEOUT_MS = 280_000;

/**
 * Wraps fetchWithWakeRetry so that if the connection never succeeds within
 * REQUEST_TIMEOUT_MS (the backend is genuinely unreachable, not just
 * cold-starting), the caller sees a translated message instead of the
 * browser's raw, untranslated network-error text (e.g. "Failed to fetch").
 * Passing this controller's own signal is what makes REQUEST_TIMEOUT_MS the
 * real retry ceiling: fetchWithWakeRetry keeps retrying past its own fixed
 * DEFAULT_DELAYS_MS array for as long as this signal hasn't fired yet (see
 * that file's own comment) -- so the full 220s budget actually gets used
 * for a slow cold start, not just DEFAULT_DELAYS_MS's smaller ~101s sum.
 */
async function fetchApi(input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchWithWakeRetry(input, { ...init, signal: controller.signal }, { onWaking: notifyWakingRefCounted });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(resolveErrorMessage({ code: "REQUEST_TIMEOUT" }));
    }
    throw new Error(resolveErrorMessage({ code: "NETWORK_ERROR" }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the same stored language preference / browser locale
 * LanguageProvider uses (see i18n/LanguageContext.tsx) to translate a
 * server error, since this runs in plain functions outside the React tree.
 */
function resolveErrorMessage(body: { error?: string; code?: string }): string {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LANG_STORAGE_KEY);
  } catch {
    // localStorage can be unavailable (private mode); fall through to the browser locale.
  }
  const lang = detectInitialLang(stored, typeof navigator !== "undefined" ? navigator.language : undefined);
  return resolveErrorMessageForLang(lang, body);
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // localStorage can be unavailable (private mode); the session just
    // won't survive a refresh, which is an acceptable degradation here.
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // see setToken
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetchApi(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `Request failed (${res.status})`, code: "REQUEST_FAILED" }));
    const code = (body as { code?: string }).code;
    const message = resolveErrorMessage(body as { error?: string; code?: string });
    if (code === "SESSION_EXPIRED" || code === "AUTH_REQUIRED") notifyAuthExpired();
    if (code === "PROJECT_NOT_FOUND") {
      const match = path.match(/^\/projects\/([^/]+)/);
      if (match) notifyProjectGone(match[1], message);
    }
    if (code === "VIEWER_READ_ONLY") {
      const match = path.match(/^\/projects\/([^/]+)/);
      if (match) notifyViewerDemoted(match[1]);
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function signup(email: string, password: string): Promise<{ user: User; token: string }> {
  return request("/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) });
}

/**
 * Once RESEND_API_KEY is configured server-side, a correct password no
 * longer returns a token directly -- it returns `{ requiresCode: true,
 * loginCodeId }` instead, and the caller (AuthScreen.tsx) must show the
 * code-entry step and call verifyLoginCode to actually finish logging in.
 * Without that env var set, the server still returns `{ user, token }`
 * immediately, exactly as before this feature existed -- see
 * routes/auth.ts's own `emailSender.configured` check.
 */
export function login(
  email: string,
  password: string,
  lang: "he" | "en",
): Promise<{ user: User; token: string } | { requiresCode: true; loginCodeId: string }> {
  return request("/auth/login", { method: "POST", body: JSON.stringify({ email, password, lang }) });
}

export function verifyLoginCode(loginCodeId: string, code: string): Promise<{ user: User; token: string }> {
  return request("/auth/login/verify-code", { method: "POST", body: JSON.stringify({ loginCodeId, code }) });
}

/**
 * Always resolves with `{ sent: true }`, whether or not `email` matches a
 * real account -- see routes/auth.ts's own doc comment on why the server
 * deliberately never reveals that either way. The one exception is
 * EMAIL_NOT_CONFIGURED (503), a deployment-wide condition unrelated to any
 * specific address, which AuthScreen.tsx surfaces as a real error instead
 * of the generic "check your email" confirmation.
 */
export function forgotPassword(email: string, lang: "he" | "en"): Promise<{ sent: true }> {
  return request("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email, lang }) });
}

/** The second half of the flow above -- `token` is whatever AuthScreen.tsx read from the emailed link's own `?resetToken=` query param. */
export function resetPassword(token: string, newPassword: string, lang?: "he" | "en"): Promise<void> {
  return request("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, newPassword, lang }) });
}

export function me(): Promise<{ user: User }> {
  return request("/auth/me");
}

export async function logout(): Promise<void> {
  await request("/auth/logout", { method: "POST" }).catch(() => undefined);
  clearToken();
}

/**
 * `lang` (round 1252) picks which language the server's own
 * password-changed notification is written in, the same `changeEmail`
 * convention just below.
 *
 * Round 1310: same `x-idempotency-key` mechanism createProject already
 * uses (see its own doc comment) -- here specifically because this
 * route's own success invalidates the exact precondition
 * (`currentPassword` verified against the stored hash) a
 * fetchWithWakeRetry retry re-checks with the same, now-stale body, so a
 * response lost in transit after the server already changed the password
 * made the retry fail with a false "Current password is incorrect" for a
 * change that already fully succeeded.
 */
export function changePassword(currentPassword: string, newPassword: string, lang: "he" | "en"): Promise<void> {
  return request("/auth/password", {
    method: "PATCH",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ currentPassword, newPassword, lang }),
  });
}

/**
 * ChangeEmailPanel.tsx's own API call -- returns the updated User (new
 * email included) so the caller can update its own held `user` state, the
 * same way CollaboratorsPanel's onOwnerTransferred already does for a
 * project. `lang` (round 1206) picks which language the server's own
 * old-email notification is written in, the same `login`/`forgotPassword`
 * convention above.
 */
export function changeEmail(currentPassword: string, email: string, lang: "he" | "en"): Promise<{ user: User }> {
  return request("/auth/email", { method: "PATCH", body: JSON.stringify({ currentPassword, email, lang }) });
}

/**
 * Real, permanent self-service account deletion (DeleteAccountPanel.tsx).
 * The server's own session is already gone by the time this resolves (the
 * DELETE route revokes every session, this one included), so this doesn't
 * separately call clearToken -- the caller does that itself once this
 * succeeds, the same way logout() above pairs a server call with its own
 * local cleanup.
 */
export function deleteAccount(lang?: "he" | "en"): Promise<void> {
  const query = lang ? `?lang=${lang}` : "";
  return request(`/auth/account${query}`, { method: "DELETE" });
}

/**
 * `X-Idempotency-Key` is generated once per call (not inside `request()`'s
 * own retry loop), so fetchWithWakeRetry's own retries of *this* call
 * resend the exact same key (it's part of the `init` object that loop
 * reuses on every attempt -- see wakeRetry.ts) while a genuinely new call
 * (the user submitting the idea box again) gets a fresh one. This is
 * docs/wakeRetry-idempotency-design.md's (round 470) mechanism, first
 * wired up for this route in round 471: a retry that lands after the
 * first attempt already finished creating a project replays that same
 * response instead of creating a second, duplicate draft and paying for a
 * second real AI call.
 */
export function createProject(description: string): Promise<{ project: Project; providerName: string }> {
  return request("/projects", {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ description }),
  });
}

export interface TemplateSummary {
  id: string;
  icon: string;
  name: string;
  nameHe: string;
  description: string;
  descriptionHe: string;
  entityNames: string[];
  entityNamesEn: string[];
}

export function listTemplates(): Promise<{ templates: TemplateSummary[] }> {
  return request("/templates");
}

/** See createProject's own doc comment for why this generates one idempotency key per call, here protecting against a duplicate draft project from the same template. */
export function createProjectFromTemplate(templateId: string, lang: "he" | "en"): Promise<{ project: Project }> {
  return request("/projects/from-template", {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ templateId, lang }),
  });
}

/**
 * The Prompt Architect Agent: sends a short, rough idea and gets back a
 * fuller, more detailed rewrite the user can review before it's used to
 * create the project (same AI-or-heuristic provider seam as createProject).
 */
export function enhanceIdea(idea: string): Promise<{ enhanced: string; providerName: string }> {
  return request("/ideas/enhance", { method: "POST", body: JSON.stringify({ idea }) });
}

export function listProjects(): Promise<{ projects: Project[] }> {
  return request("/projects");
}

/**
 * The robust complement to listProjects above (DeleteAccountPanel.tsx):
 * that listing silently drops any project whose stored spec no longer
 * parses against today's schema, which would leave that project's own
 * localStorage preference entries un-swept forever after account deletion.
 * This never parses spec_json at all, so it can't miss one.
 */
export function listMyProjectIds(): Promise<{ ownedProjectIds: string[]; sharedProjectIds: string[] }> {
  return request("/projects/mine-ids");
}

/** See createProject's own doc comment for why this generates one idempotency key per call, here protecting against a duplicate clone of the same source project. */
export function cloneProject(projectId: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/clone`, { method: "POST", headers: { "x-idempotency-key": crypto.randomUUID() } });
}

export function renameProject(projectId: string, name: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/name`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export function updateProjectDescription(projectId: string, description: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/description`, { method: "PATCH", body: JSON.stringify({ description }) });
}

/**
 * Every entity/field-scoped request below encodes `entityName`/`fieldName`
 * into the URL path (here and in renameFieldLabel/addField/removeField/
 * removeEntity/listRecords/createRecord/updateRecord/deleteRecord) -- a raw
 * "/" in either would otherwise split the path into extra segments Express's
 * single-segment `:entityName`/`:fieldName` route params can't match, 404ing
 * every request that touches that entity/field, permanently (even its own
 * rename/remove routes use the same shape). `deriveEntityName`/
 * `deriveFieldName` (routes/projects.ts) already strip every non-alphanumeric
 * character from a manually-added name, so this is unreachable through the
 * UI; it's defense-in-depth against the one other path a name is set
 * through -- the real Anthropic provider -- whose system prompt already
 * requires a plain ASCII identifier (anthropic.ts) but, like any prompt
 * instruction, isn't a hard guarantee. Same defense-in-depth posture already
 * taken for the exact same assumed input in backup.ts's sanitizeZipEntryName.
 * encodeURIComponent is a no-op for every name already in use (ASCII or
 * Hebrew alike -- the browser already percent-encodes non-ASCII bytes on the
 * wire either way), so this changes nothing for any project that works today.
 */
/** Round 960: same idempotency-key shape as removeField's own fix (round 941) -- a lost response after this rename already committed must replay that success on retry, not re-apply the same now-stale label a second time and silently revert a genuinely newer edit that landed in between. */
export function renameEntityLabel(projectId: string, entityName: string, label: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/entities/${encodeURIComponent(entityName)}/label`, {
    method: "PATCH",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ label }),
  });
}

/** Round 960: same idempotency-key shape as renameEntityLabel's own fix just above -- see its own comment. */
export function renameFieldLabel(
  projectId: string,
  entityName: string,
  fieldName: string,
  label: string,
): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/entities/${encodeURIComponent(entityName)}/fields/${encodeURIComponent(fieldName)}/label`, {
    method: "PATCH",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ label }),
  });
}

/**
 * See createProject's own doc comment for why this generates one
 * idempotency key per call, here protecting against a duplicate field
 * from the same click/retry. `opts` is optional and, left unset, sends
 * exactly today's request shape (a plain, optional text field) -- every
 * existing call site that only ever passed a label keeps working
 * unchanged. `enumValues` is sent as the server's own comma-separated
 * string shape (its own AddFieldSchema splits it), matching the single
 * free-text input the "enum" type's UI offers rather than making the
 * caller build an array just to immediately re-join it.
 */
export function addField(
  projectId: string,
  entityName: string,
  label: string,
  opts?: { type?: Field["type"]; required?: boolean; enumValues?: string; relationTo?: string },
): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/entities/${encodeURIComponent(entityName)}/fields`, {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ label, ...opts }),
  });
}

/** Round 1216: same idempotency-key shape as addField's own fix -- a lost response after this entity was already duplicated must replay that success on retry, not create a second duplicate. */
export function duplicateEntity(projectId: string, entityName: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/entities/${encodeURIComponent(entityName)}/duplicate`, {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
  });
}

/** Round 941: same idempotency-key shape as deleteRecord's own fix (round 792) -- a lost response after this field was already removed must replay that success on retry, not surface a confusing "not found". */
export function removeField(projectId: string, entityName: string, fieldName: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/entities/${encodeURIComponent(entityName)}/fields/${encodeURIComponent(fieldName)}`, {
    method: "DELETE",
    headers: { "x-idempotency-key": crypto.randomUUID() },
  });
}

/** Round 960: same idempotency-key shape as renameEntityLabel's own fix -- see its own comment. */
export function setFieldRequired(
  projectId: string,
  entityName: string,
  fieldName: string,
  required: boolean,
): Promise<{ project: Project }> {
  return request(
    `/projects/${projectId}/entities/${encodeURIComponent(entityName)}/fields/${encodeURIComponent(fieldName)}/required`,
    { method: "PATCH", headers: { "x-idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ required }) },
  );
}

/**
 * See addField's own comment on the `enumValues` shape -- same comma-separated-string convention, split server-side.
 * Round 960: same idempotency-key shape as renameEntityLabel's own fix -- see its own comment.
 */
export function setFieldType(
  projectId: string,
  entityName: string,
  fieldName: string,
  type: Field["type"],
  opts?: { enumValues?: string; relationTo?: string },
): Promise<{ project: Project }> {
  return request(
    `/projects/${projectId}/entities/${encodeURIComponent(entityName)}/fields/${encodeURIComponent(fieldName)}/type`,
    { method: "PATCH", headers: { "x-idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ type, ...opts }) },
  );
}

/** Round 945: same idempotency-key shape as deleteCheckpoint's own fix (round 944) -- a lost response after this project was already deleted must replay that success on retry, not surface a confusing "not found" for the single most destructive action in the app. */
export function deleteProject(projectId: string, lang?: "he" | "en"): Promise<void> {
  const query = lang ? `?lang=${lang}` : "";
  return request(`/projects/${projectId}${query}`, {
    method: "DELETE",
    headers: { "x-idempotency-key": crypto.randomUUID() },
  });
}

/**
 * `expect` is the exact role/assumption string the caller had on screen
 * when it captured `index` -- roles/assumptions have no identity beyond
 * array position, unlike entities/fields (addressed by name below), so two
 * of these calls overlapping (the user clicking two different chips before
 * either response lands) could otherwise have the second one silently
 * land on whatever entry the first one's removal shifted into that same
 * index. The server rejects the request (409) if `expect` no longer
 * matches instead of mutating the wrong entry -- see assertIndexStillMatches
 * in apps/api/src/routes/projects.ts.
 *
 * Round 943: same idempotency-key shape as removeEntity's/removeField's own
 * fix (round 941) -- a lost response after this role was already removed
 * must replay that success on retry, not surface a confusing "stale index"
 * conflict for a removal that, from the user's point of view, already
 * fully succeeded.
 */
export function removeRole(projectId: string, index: number, expect: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/roles/${index}`, {
    method: "DELETE",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ expect }),
  });
}

/** Round 943: same idempotency-key shape as removeRole's own fix just above -- see its own comment. */
export function removeAssumption(projectId: string, index: number, expect: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/assumptions/${index}`, {
    method: "DELETE",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ expect }),
  });
}

/** Round 943: same idempotency-key shape as removeRole's own fix above -- see its own comment. */
export function removePersona(projectId: string, index: number, expect: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/personas/${index}`, {
    method: "DELETE",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ expect }),
  });
}

/** See createProject's own doc comment for why this generates one idempotency key per call, here protecting against a duplicate role from the same click/retry. */
export function addRole(projectId: string, role: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/roles`, {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ role }),
  });
}

/** See createProject's own doc comment for why this generates one idempotency key per call, here protecting against a duplicate assumption from the same click/retry. */
export function addAssumption(projectId: string, assumption: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/assumptions`, {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ assumption }),
  });
}

/** See createProject's own doc comment for why this generates one idempotency key per call, here protecting against a duplicate persona from the same click/retry. */
export function addPersona(projectId: string, persona: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/personas`, {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ persona }),
  });
}

/** Round 943: same idempotency-key shape as removeRole's own fix above -- a lost response after a successful rename must replay that success on retry, not surface a confusing "stale index" conflict (the retried `expect` would otherwise no longer match the already-renamed value). */
export function renameRole(
  projectId: string,
  index: number,
  role: string,
  expect: string,
): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/roles/${index}`, {
    method: "PATCH",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ role, expect }),
  });
}

/** Round 943: same idempotency-key shape as renameRole's own fix just above -- see its own comment. */
export function renameAssumption(
  projectId: string,
  index: number,
  assumption: string,
  expect: string,
): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/assumptions/${index}`, {
    method: "PATCH",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ assumption, expect }),
  });
}

/** Round 943: same idempotency-key shape as renameRole's own fix above -- see its own comment. */
export function renamePersona(
  projectId: string,
  index: number,
  persona: string,
  expect: string,
): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/personas/${index}`, {
    method: "PATCH",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ persona, expect }),
  });
}

/** Round 941: same idempotency-key shape as deleteRecord's own fix (round 792) -- a lost response after this entity was already removed must replay that success on retry, not surface a confusing "not found". */
export function removeEntity(projectId: string, entityName: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/entities/${encodeURIComponent(entityName)}`, {
    method: "DELETE",
    headers: { "x-idempotency-key": crypto.randomUUID() },
  });
}

/** See createProject's own doc comment for why this generates one idempotency key per call, here protecting against a duplicate entity from the same click/retry. */
export function addEntity(projectId: string, label: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/entities`, {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ label }),
  });
}

/**
 * Sends the user's answers to the spec's open questions (quick-pick or
 * freely typed), and/or a free-standing request not tied to any specific
 * question, back to the server, which regenerates the spec from them
 * before the build runs — so this actually changes what gets built, not
 * just which chip looks selected. `providerName` is round 406's own
 * AI-vs-heuristic honest signal, carried from this route's own
 * generateSpec() call -- absent (not even the key) when there was nothing
 * to answer, since the server never calls generateSpec() again in that
 * no-op case. See createProject's own doc comment for why this also
 * generates one idempotency key per call, protecting against a second
 * real generateSpec() call and spec overwrite from the same click/retry.
 * `answers` is an array, not a `Record<string,string>` keyed by question
 * text -- two open questions can legitimately share identical wording
 * (OpenQuestionSchema carries no uniqueness constraint), and a flat object
 * can't hold two entries under the same key, so the array preserves both
 * answers distinctly even when their questions' text collides.
 */
export function answerQuestions(
  projectId: string,
  answers: { question: string; answer: string }[],
  additionalRequest?: string,
): Promise<{ project: Project; providerName?: string }> {
  return request(`/projects/${projectId}/answers`, {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ answers, additionalRequest }),
  });
}

/**
 * Consumes the streaming build/refine pipeline (Server-Sent Events framing
 * over a plain fetch, so the same Authorization header works — EventSource
 * can't set custom headers). Calls onEvent for every agent step as it
 * arrives and resolves once the stream ends.
 *
 * Round 950: `projectId` is passed explicitly (every real caller already
 * has it in scope) rather than regex-matched out of `path`, same as the
 * fix below for the PROJECT_NOT_FOUND gap this function had -- requireProjectAccess
 * (apps/api/src/routes/projects.ts) throws that code the moment this
 * project was deleted, or this account's own collaborator access to it was
 * revoked, which can happen while a Build/Refine is mid-click; without
 * calling notifyProjectGone here (the generic request() helper already
 * does, see its own doc comment), the project shell just kept rendering
 * forever, with every retry hitting the identical 404 again.
 */
async function streamPipeline(
  path: string,
  projectId: string,
  onEvent: (event: AgentStepEvent) => void,
  body?: unknown,
): Promise<void> {
  const token = getToken();
  const res = await fetchApi(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok || !res.body) {
    const errorBody = await res.json().catch(() => ({ error: `Request failed (${res.status})`, code: "REQUEST_FAILED" }));
    const code = (errorBody as { code?: string }).code;
    const message = resolveErrorMessage(errorBody as { error?: string; code?: string });
    if (code === "SESSION_EXPIRED" || code === "AUTH_REQUIRED") notifyAuthExpired();
    if (code === "PROJECT_NOT_FOUND") notifyProjectGone(projectId, message);
    if (code === "VIEWER_READ_ONLY") notifyViewerDemoted(projectId);
    throw new Error(message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    // Unlike the initial fetchApi() call above, a build/refine can run for
    // minutes -- a real network drop mid-stream is a genuine risk, and
    // reader.read() throws the browser's raw, untranslated error for it
    // (e.g. "network error"/"Failed to fetch") instead of a real HTTP
    // response fetchApi could translate. Only the read itself is wrapped:
    // a bug in onEvent or a malformed SSE frame below is a different kind
    // of failure and shouldn't be misreported as a network problem.
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      throw new Error(resolveErrorMessage({ code: "NETWORK_ERROR" }));
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (line) onEvent(JSON.parse(line.slice("data: ".length)) as AgentStepEvent);
    }
  }
}

export function streamBuild(projectId: string, onEvent: (event: AgentStepEvent) => void): Promise<void> {
  return streamPipeline(`/projects/${projectId}/build`, projectId, onEvent);
}

export function streamRefine(
  projectId: string,
  instruction: string,
  onEvent: (event: AgentStepEvent) => void,
): Promise<void> {
  return streamPipeline(`/projects/${projectId}/refine`, projectId, onEvent, { instruction });
}

/**
 * Turns a project's own name into a filename the browser's download
 * mechanism can save directly. Unlike an HTTP `Content-Disposition`
 * header (constrained to Latin-1 by Node's http module, so the server's
 * own equivalent logic in apps/api/src/routes/projects.ts is deliberately
 * ASCII-only), the `download` attribute on a real, rendered `<a>` element
 * is read directly by the browser and has supported arbitrary Unicode
 * (Hebrew included) since HTML5 -- so this only strips characters that are
 * genuinely unsafe in a filename (path separators, Windows-reserved
 * characters, control characters), not every non-ASCII one. This product
 * is Hebrew-first (see docs/roadmap.md); a name like "אפליקציה לניהול
 * תורים למספרה" used to collapse entirely to the empty-string fallback.
 */
export function safeDownloadName(projectName: string, fallback: string): string {
  return projectName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim() || fallback;
}

/**
 * Fetches a binary response (with the Authorization header, so a plain
 * <a href> won't work) and saves it via the browser's normal download
 * flow -- the shared mechanics behind exportProject and backupProject,
 * which differed only in the URL path and the download filename.
 *
 * Round 950: same PROJECT_NOT_FOUND gap, and the same fix, as
 * streamPipeline's own identical fix just above -- requireProjectAccess
 * throws it the moment this project was deleted or this account's own
 * access was revoked, and export/backup go through that same check.
 */
async function downloadBlob(path: string, projectId: string, downloadName: string): Promise<void> {
  const token = getToken();
  const res = await fetchApi(path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `Request failed (${res.status})`, code: "REQUEST_FAILED" }));
    const code = (body as { code?: string }).code;
    const message = resolveErrorMessage(body as { error?: string; code?: string });
    if (code === "SESSION_EXPIRED" || code === "AUTH_REQUIRED") notifyAuthExpired();
    if (code === "PROJECT_NOT_FOUND") notifyProjectGone(projectId, message);
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = downloadName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Downloads the real, standalone exported app as a .zip and saves it via the browser's normal download flow. */
export function exportProject(projectId: string, projectName: string): Promise<void> {
  return downloadBlob(`/api/projects/${projectId}/export`, projectId, `${safeDownloadName(projectName, "forge-app")}.zip`);
}

/**
 * Downloads a single .zip containing one CSV per entity -- the whole
 * project's data at once, instead of visiting every tab's own CSV export
 * button. columnOrders carries each entity's own drag-reordered column
 * order (apps/web/src/columnOrder.ts), a client-only localStorage
 * preference the server has no other way to learn -- sent as a single
 * JSON-encoded query param since this is a plain GET download with no
 * request body. Omitted entities (never reordered) fall back to their
 * declared field order server-side, same as every other export surface.
 */
export function backupProject(projectId: string, projectName: string, columnOrders: Record<string, string[]>): Promise<void> {
  const query = Object.keys(columnOrders).length > 0 ? `?columnOrders=${encodeURIComponent(JSON.stringify(columnOrders))}` : "";
  return downloadBlob(`/api/projects/${projectId}/backup${query}`, projectId, `${safeDownloadName(projectName, "forge-app")}-backup.zip`);
}

export interface BusinessTwinEntityStat {
  name: string;
  label: string;
  count: number;
}

export interface BusinessTwin {
  summary: string;
  roles: string[];
  entities: BusinessTwinEntityStat[];
  totalRecords: number;
  mostActive: BusinessTwinEntityStat | null;
  unused: BusinessTwinEntityStat[];
  observations: string[];
  mostLinkedRecord: { text: string; entityName: string; recordId: number } | null;
  mostActiveObservation: { text: string; entityName: string } | null;
  jumpableObservations: { text: string; entityName: string }[];
  distributions: {
    text: string;
    entityName: string;
    entityLabel: string;
    fieldName: string;
    fieldLabel: string;
    breakdown: { value: string; label: string; count: number }[];
  }[];
  numericStats: {
    text: string;
    entityName: string;
    entityLabel: string;
    fieldName: string;
    fieldLabel: string;
    sum: number;
    average: number;
    recordCount: number;
  }[];
}

export function getBusinessTwin(projectId: string): Promise<{ twin: BusinessTwin }> {
  return request(`/projects/${projectId}/twin`);
}

export function getEntityCounts(projectId: string): Promise<{ counts: Record<string, number> }> {
  return request(`/projects/${projectId}/entity-counts`);
}

/**
 * Round 1006: backs the calendar view's "Subscribe" affordance
 * (EntityPanel.tsx) -- the token used to build a live subscription URL a
 * calendar app re-fetches on its own schedule, unlike the existing one-shot
 * "Export ICS" download. See apps/api/src/routes/projects.ts's own doc
 * comment on this route, and getOrCreateCalendarFeedToken (packages/db)
 * for why this is a real persisted secret, not derived client-side.
 */
export function getCalendarFeedToken(projectId: string): Promise<{ token: string }> {
  return request(`/projects/${projectId}/calendar-feed-token`);
}

/**
 * Round 1012: rotates the feed token so any previously-copied subscribe
 * URL (a removed/demoted collaborator's own, or anyone they'd forwarded
 * it to) stops working -- owner-only, since it also breaks every OTHER
 * collaborator's already-configured subscription with no warning to
 * them. See routes/projects.ts's own doc comment on this route.
 *
 * `lang` (round 1290) picks which language the server's own best-effort
 * "your calendar subscription link was reset" notification to every
 * other collaborator is written in. Optional since this is a bodyless
 * POST with nowhere else to carry it, same convention as
 * removeCollaborator's own `lang` query param below.
 *
 * Round 1313: same `x-idempotency-key` mechanism createProject already
 * uses (see its own doc comment) -- here specifically because a response
 * lost in transit after the server already rotated the token made a
 * fetchWithWakeRetry retry rotate it a SECOND time and re-send every
 * collaborator a second, confusing "link was reset" email.
 */
export function regenerateCalendarFeedToken(projectId: string, lang?: "he" | "en"): Promise<{ token: string }> {
  const query = lang ? `?lang=${lang}` : "";
  return request(`/projects/${projectId}/calendar-feed-token/regenerate${query}`, {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
  });
}

export function listCheckpoints(projectId: string): Promise<{ checkpoints: Checkpoint[] }> {
  return request(`/projects/${projectId}/checkpoints`);
}

/** Round 956: same idempotency-key shape as deleteCheckpoint's own fix (round 944) -- a lost response after this restore already committed must replay that exact outcome (migrationWarning included) on retry, not silently re-diff the already-restored spec against itself and come back with no warning. */
export function restoreCheckpoint(
  projectId: string,
  checkpointId: string,
): Promise<{ project: Project; migrationWarning: string | null }> {
  return request(`/projects/${projectId}/checkpoints/${checkpointId}/restore`, {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
  });
}

/** Round 962: same idempotency-key shape as deleteCheckpoint's own fix (round 944) -- a lost response after this rename already committed must replay that success on retry, not re-apply the same now-stale label a second time and silently revert a genuinely newer rename that landed in between. */
export function renameCheckpoint(projectId: string, checkpointId: string, label: string): Promise<{ checkpoint: Checkpoint }> {
  return request(`/projects/${projectId}/checkpoints/${checkpointId}`, {
    method: "PATCH",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ label }),
  });
}

/** Round 944: same idempotency-key shape as deleteRecord's own fix (round 792) -- a lost response after this checkpoint was already deleted must replay that success on retry, not surface a confusing "not found". */
export function deleteCheckpoint(projectId: string, checkpointId: string): Promise<void> {
  return request(`/projects/${projectId}/checkpoints/${checkpointId}`, {
    method: "DELETE",
    headers: { "x-idempotency-key": crypto.randomUUID() },
  });
}

export function listRecords(projectId: string, entityName: string): Promise<{ records: EntityRecord[] }> {
  return request(`/projects/${projectId}/entities/${encodeURIComponent(entityName)}`);
}

/**
 * Round 594: the one real-effect mutation route missed when the
 * X-Idempotency-Key mechanism (docs/wakeRetry-idempotency-design.md) was
 * rolled out to every other mutating route in rounds 471-528 -- see the
 * matching server-side comment on POST /projects/:id/entities/:entityName.
 * A response lost in transit after this request already committed a new
 * record server-side would otherwise leave fetchWithWakeRetry's retry to
 * insert a second, fully duplicate row.
 */
export function createRecord(
  projectId: string,
  entityName: string,
  data: Record<string, unknown>,
  options?: { suppressAutomations?: boolean },
): Promise<{ record: EntityRecord }> {
  return request(`/projects/${projectId}/entities/${encodeURIComponent(entityName)}`, {
    method: "POST",
    headers: {
      "x-idempotency-key": crypto.randomUUID(),
      ...(options?.suppressAutomations ? { "x-suppress-automations": "true" } : {}),
    },
    body: JSON.stringify(data),
  });
}

/**
 * Uploads a chosen file for a single `file`-type field and returns the
 * descriptor the caller then JSON.stringify()s as that field's own value
 * (see EntityPanel.tsx's FieldInput "file" branch) -- separate from
 * `request()` above since a multipart body must never get
 * `content-type: application/json` or a JSON.stringify()'d body; the
 * browser sets its own multipart boundary header once given a real
 * FormData.
 *
 * Round 907: the same X-Idempotency-Key mechanism createRecord/
 * sendWhatsAppMessage already send -- this call goes through fetchApi's
 * own fetchWithWakeRetry just like every other request, and a FormData
 * wrapping a real File is a re-readable Blob, not a one-shot stream, so a
 * retry after a dropped connection (even one where the server already
 * finished and only the response itself got lost) successfully re-sends
 * the identical file bytes. Without a key, the server has no way to tell
 * that retry apart from a genuinely new upload, and multer names every
 * file with a fresh random UUID -- so each retry silently wrote a second,
 * orphaned file to disk forever, with no cleanup mechanism anywhere for a
 * file no record ends up referencing.
 */
export async function uploadRecordFile(
  projectId: string,
  entityName: string,
  fieldName: string,
  file: File,
): Promise<{ url: string; name: string; size: number; mimeType: string }> {
  const token = getToken();
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetchApi(
    `/api/projects/${projectId}/entities/${encodeURIComponent(entityName)}/fields/${encodeURIComponent(fieldName)}/upload`,
    {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "x-idempotency-key": crypto.randomUUID(),
      },
      body: formData,
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `Request failed (${res.status})`, code: "REQUEST_FAILED" }));
    const code = (body as { code?: string }).code;
    const message = resolveErrorMessage(body as { error?: string; code?: string });
    if (code === "SESSION_EXPIRED" || code === "AUTH_REQUIRED") notifyAuthExpired();
    // Round 950: same PROJECT_NOT_FOUND gap, and the same fix, as
    // streamPipeline's/downloadBlob's own identical fix above.
    if (code === "PROJECT_NOT_FOUND") notifyProjectGone(projectId, message);
    if (code === "VIEWER_READ_ONLY") notifyViewerDemoted(projectId);
    throw new Error(message);
  }
  const body = (await res.json()) as { file: { url: string; name: string; size: number; mimeType: string } };
  return body.file;
}

/**
 * Round 792: the same X-Idempotency-Key mechanism createRecord already
 * uses, missed for update -- a response lost in transit after the server
 * already applied this update left fetchWithWakeRetry's retry free to
 * re-apply it (harmless for storage, but a duplicate "record_updated"
 * automation fire for a single logical edit).
 */
export function updateRecord(
  projectId: string,
  entityName: string,
  recordId: number,
  data: Record<string, unknown>,
  options?: { suppressAutomations?: boolean },
): Promise<{ record: EntityRecord }> {
  return request(`/projects/${projectId}/entities/${encodeURIComponent(entityName)}/${recordId}`, {
    method: "PATCH",
    headers: {
      "x-idempotency-key": crypto.randomUUID(),
      ...(options?.suppressAutomations ? { "x-suppress-automations": "true" } : {}),
    },
    body: JSON.stringify(data),
  });
}

/**
 * Round 792: the same X-Idempotency-Key mechanism createRecord already
 * uses, missed for delete -- a response lost in transit after the server
 * already deleted the row left fetchWithWakeRetry's retry hitting an
 * already-deleted record, surfacing a confusing "not found" error for a
 * delete that, from the user's own point of view, already fully
 * succeeded (see EntityPanel.tsx's commitPendingDelete, which would
 * otherwise restore the already-gone row into the UI on that error).
 */
export function deleteRecord(projectId: string, entityName: string, recordId: number): Promise<void> {
  return request(`/projects/${projectId}/entities/${encodeURIComponent(entityName)}/${recordId}`, {
    method: "DELETE",
    headers: { "x-idempotency-key": crypto.randomUUID() },
  });
}

/** The owner never appears in `collaborators` itself (see collaborators.ts's own module comment -- their access comes from project.ownerId, not the join table), so the panel needs this separately to show who actually owns the project. Null only in the should-never-happen case of a dangling owner reference. */
export interface ProjectOwnerInfo {
  userId: string;
  email: string;
}

export function listCollaborators(projectId: string): Promise<{ collaborators: ProjectCollaborator[]; owner: ProjectOwnerInfo | null }> {
  return request(`/projects/${projectId}/collaborators`);
}

/**
 * `lang` (round 1253) picks which language the server's own invite
 * notification email is written in, the same `changeEmail`/`changePassword`
 * convention.
 */
export function addCollaborator(
  projectId: string,
  email: string,
  role: CollaboratorRole = "editor",
  lang?: "he" | "en",
): Promise<{ collaborators: ProjectCollaborator[]; owner: ProjectOwnerInfo | null }> {
  return request(`/projects/${projectId}/collaborators`, { method: "POST", body: JSON.stringify({ email, role, lang }) });
}

/**
 * Round 1191: same X-Idempotency-Key mechanism createProject/
 * transferProjectOwnership already use (see their own doc comments) --
 * this route serves both "owner removes someone else" and self-service
 * "leave project," and the self-leave path's own server-side fix
 * (withIdempotency wrapping requireProjectAccess) only actually protects
 * a retry once this call carries a key for it to key its cached response
 * on.
 */
/**
 * `lang` (round 1254) picks which language the server's own removal
 * notification is written in -- sent only when the owner removes a
 * DIFFERENT collaborator, never on a self-initiated "leave." Optional
 * since a bodyless DELETE has nowhere else to carry it, so it's sent as
 * a query param instead.
 */
export function removeCollaborator(projectId: string, userId: string, lang?: "he" | "en"): Promise<void> {
  const query = lang ? `?lang=${lang}` : "";
  return request(`/projects/${projectId}/collaborators/${userId}${query}`, {
    method: "DELETE",
    headers: { "x-idempotency-key": crypto.randomUUID() },
  });
}

/**
 * `lang` (round 1254) picks which language the server's own role-change
 * notification email is written in, the same `addCollaborator` convention.
 */
export function updateCollaboratorRole(
  projectId: string,
  userId: string,
  role: CollaboratorRole,
  lang?: "he" | "en",
): Promise<{ collaborators: ProjectCollaborator[]; owner: ProjectOwnerInfo | null }> {
  return request(`/projects/${projectId}/collaborators/${userId}/role`, {
    method: "PATCH",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ role, lang }),
  });
}

/**
 * The caller (CollaboratorsPanel) is no longer the project's own owner once
 * this succeeds -- the returned `project` has the new ownerId, so the
 * caller can update its own held Project state (e.g. via setProject) the
 * same way ProjectNameEditor's onRenamed already does, which flips isOwner
 * for every owner-gated control derived from project.ownerId.
 *
 * Round 1189: same X-Idempotency-Key mechanism createProject already uses
 * (see its own doc comment) -- the server-side fix makes this route
 * retry-safe, but only once this request actually carries a key for
 * withIdempotency to key its cached response on.
 */
export function transferProjectOwnership(
  projectId: string,
  userId: string,
  lang?: "he" | "en",
): Promise<{ collaborators: ProjectCollaborator[]; owner: ProjectOwnerInfo | null; project: Project }> {
  return request(`/projects/${projectId}/transfer-ownership`, {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ userId, lang }),
  });
}

/**
 * WhatsApp sync connects the way WhatsApp Web/Desktop does -- scanning a QR
 * code with your own phone links this app as an additional device -- so no
 * Meta Business account is needed. This is an unofficial method (against
 * WhatsApp's own terms of service, which are written around their
 * official clients), carrying a real, if usually small, risk that a
 * number showing automated behavior gets flagged; the panel says so
 * before connecting.
 */
export type WhatsAppConnectionStatus = "disconnected" | "connecting" | "qr" | "connected";

export interface WhatsAppStatusView {
  status: WhatsAppConnectionStatus;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  error: string | null;
}

export function getWhatsAppStatus(projectId: string): Promise<WhatsAppStatusView> {
  return request(`/projects/${projectId}/integrations/whatsapp/status`);
}

export function connectWhatsApp(projectId: string): Promise<WhatsAppStatusView> {
  return request(`/projects/${projectId}/integrations/whatsapp/connect`, { method: "POST" });
}

export function disconnectWhatsApp(projectId: string): Promise<WhatsAppStatusView> {
  return request(`/projects/${projectId}/integrations/whatsapp/disconnect`, { method: "POST" });
}

export interface WhatsAppSendResult {
  ok: boolean;
  error?: string;
  // Round 1081: true once the server either already deleted the resolved
  // attachment file (the request reached whatsapp.sendMessage, which the
  // send route always cleans that file up after, win or lose) or confirmed
  // there was nothing left to clean up (the attachment reference itself
  // was invalid or already gone). False means the request never got that
  // far -- e.g. WHATSAPP_NOT_CONNECTED, a VALIDATION_ERROR on to/message,
  // or the route's own rate limiter rejecting it outright -- so a real
  // uploaded file is still sitting on disk and the caller must not forget
  // it. See sendWhatsAppMessage's own comment for how this is derived.
  attachmentAlreadyHandled: boolean;
}

/**
 * The three reasons WhatsAppWebManager.sendMessage can refuse honestly
 * before ever reaching Baileys (whatsappWeb.ts) -- a stable, machine-
 * readable snake_case code, unlike a genuine Baileys-internal send failure
 * caught in that same function's own catch block (an arbitrary message
 * with no fixed shape, so it can't be translated and is shown as-is).
 * Mapped to the same `error.<CODE>` translation convention every other
 * server error already uses, via resolveErrorMessage below.
 *
 * Exported so AutomationsPanel.tsx/automationsReport.ts (round 935) can
 * translate the identical raw codes a `send_whatsapp` automation's own
 * failed run stores verbatim (apps/api/src/automations.ts never
 * translates them, by design -- that's a client-side concern) using this
 * same canonical list, instead of maintaining a second copy that could
 * drift out of sync with this one.
 */
export const KNOWN_WHATSAPP_SEND_ERROR_CODES = new Set(["not_connected", "invalid_phone_number", "missing_country_code"]);

/**
 * Round 1080: the send_email counterpart to KNOWN_WHATSAPP_SEND_ERROR_CODES
 * above -- apps/api/src/automations.ts's own fireEmailAction now records
 * this exact stable snake_case code (never translated server-side, same
 * "that's a client concern" design) when a toMode:"field" rule's resolved
 * destination value isn't a valid email address.
 */
export const KNOWN_EMAIL_SEND_ERROR_CODES = new Set(["invalid_email_address"]);

/**
 * Round 1166: apps/api/src/automations.ts also stores a handful of
 * whole-rule/whole-record misconfiguration failures as fixed English
 * sentences (never translated server-side, same "client concern" design
 * as the snake_case codes above) -- e.g. a webhook rule with no URL set,
 * or a toMode:"field" send_whatsapp rule whose triggering record has no
 * value in the configured phone field. Before this round these leaked
 * raw English into AutomationsPanel.tsx/automationsReport.ts's Hebrew-
 * primary rule summaries, run history, and downloaded/copied reports --
 * the exact "untranslated server error" problem the snake_case codes
 * above already solve, just never extended to these plain-sentence
 * errors. Maps each literal to a stable error.<CODE> key via the same
 * resolveErrorMessage convention every other server error already uses.
 * Two of these intentionally mirror apps/api/src/automations.ts's own
 * exported WHATSAPP_NOT_CONNECTED_ERROR/EMAIL_NOT_CONFIGURED_ERROR text
 * as a literal rather than an import, since apps/web depends on
 * @forge/shared, not the server-only @forge/db that actually defines
 * those constants.
 */
export const AUTOMATION_CONFIG_ERROR_CODES: Record<string, string> = {
  "WhatsApp is not connected": "WHATSAPP_NOT_CONNECTED",
  "Email sending is not configured for this deployment": "AUTOMATION_EMAIL_NOT_CONFIGURED",
  "This rule has no valid webhook URL configured": "AUTOMATION_NO_WEBHOOK_URL",
  "This rule has no destination email address configured": "AUTOMATION_NO_EMAIL_DESTINATION",
  "This rule has no destination phone number configured": "AUTOMATION_NO_PHONE_DESTINATION",
  "This record has no value in the configured phone-number field": "AUTOMATION_PHONE_FIELD_EMPTY",
};

export interface WhatsAppAttachmentDescriptor {
  url: string;
  name: string;
  mimeType: string;
}

/**
 * Round 973: the manual-send counterpart of uploadRecordFile above, for a
 * file attached to a WhatsApp test-send rather than tied to any entity/
 * field. Returns the same {url, name, size, mimeType} shape; only `url`,
 * `name` and `mimeType` are ever threaded back into sendWhatsAppMessage
 * below (the send route's own WhatsAppSendSchema has no use for `size`).
 */
export async function uploadWhatsAppAttachment(projectId: string, file: File): Promise<{ url: string; name: string; size: number; mimeType: string }> {
  const token = getToken();
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetchApi(`/api/projects/${projectId}/integrations/whatsapp/attachments/upload`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-idempotency-key": crypto.randomUUID(),
    },
    body: formData,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `Request failed (${res.status})`, code: "REQUEST_FAILED" }));
    const code = (body as { code?: string }).code;
    const message = resolveErrorMessage(body as { error?: string; code?: string });
    if (code === "SESSION_EXPIRED" || code === "AUTH_REQUIRED") notifyAuthExpired();
    if (code === "PROJECT_NOT_FOUND") notifyProjectGone(projectId, message);
    if (code === "VIEWER_READ_ONLY") notifyViewerDemoted(projectId);
    throw new Error(message);
  }
  const body = (await res.json()) as { file: { url: string; name: string; size: number; mimeType: string } };
  return body.file;
}

/**
 * Round 979: the manual-remove/replace counterpart of uploadWhatsAppAttachment
 * above -- a chosen attachment the user removes (or replaces with a
 * different file) before ever sending otherwise sat on disk forever, since
 * only whole-project deletion ever touched that directory. Deliberately
 * best-effort from the caller's own point of view too (WhatsAppPanel.tsx's
 * handleRemoveAttachment/handleAttachmentChange never need to block or show
 * an error for this -- the local React state change is what the user is
 * actually waiting on).
 */
export function deleteWhatsAppAttachment(projectId: string, url: string): Promise<void> {
  return request(`/projects/${projectId}/integrations/whatsapp/attachments`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

/**
 * Round 1002: the create-form counterpart of uploadRecordFile above -- a
 * file the user chose then replaced or removed before ever submitting the
 * create form (EntityPanel.tsx's FieldInput "file" branch) otherwise sat on
 * disk forever, since deleteReplacedFileFields (round 685) only ever diffs
 * against an already-persisted DB row and never runs for a record that was
 * never created. Deliberately best-effort from the caller's own point of
 * view, same as deleteWhatsAppAttachment -- the local React state change is
 * what the user is actually waiting on.
 */
export function deleteUploadedRecordFile(projectId: string, entityName: string, fieldName: string, url: string): Promise<void> {
  return request(`/projects/${projectId}/entities/${encodeURIComponent(entityName)}/fields/${encodeURIComponent(fieldName)}/upload`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export async function sendWhatsAppMessage(
  projectId: string,
  to: string,
  message: string,
  attachment?: WhatsAppAttachmentDescriptor,
): Promise<WhatsAppSendResult> {
  const token = getToken();
  const res = await fetchApi(`/api/projects/${projectId}/integrations/whatsapp/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-idempotency-key": crypto.randomUUID(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ to, message, ...(attachment ? { attachment } : {}) }),
  });
  // A failed send (e.g. the socket drops mid-send, or the number is
  // invalid) is still a normal, expected response here -- surface it as
  // data, not a thrown error, so the panel can show the real reason
  // instead of a generic failure. But some failures (e.g. sending before
  // WhatsApp is connected) come back as the shared {error, code} shape the
  // generic error middleware uses, not this route's own {ok, error} shape
  // -- normalize those too, so every caller can just check `.ok` without
  // needing to know which failure path produced the response.
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; code?: string };
  // Round 1081: `typeof body.ok === "boolean"` means the request actually
  // reached the route's own withIdempotency callback (routes/projects.ts),
  // which always rm()s a resolved attachment file after whatsapp.sendMessage
  // resolves, whether that send itself succeeded or failed -- so the file
  // is already gone either way. INVALID_ATTACHMENT/ATTACHMENT_FILE_GONE
  // mean the route rejected the attachment reference itself before ever
  // resolving a real file path, so there was nothing on disk to clean up
  // in the first place. Every other {error, code} shape (WHATSAPP_NOT_CONNECTED,
  // a VALIDATION_ERROR, the route's own rate limiter) short-circuits BEFORE
  // the attachment is even looked at -- a real uploaded file, if any, is
  // still sitting on disk untouched.
  if (typeof body.ok === "boolean") {
    if (!body.ok && body.error && KNOWN_WHATSAPP_SEND_ERROR_CODES.has(body.error)) {
      return { ok: false, error: resolveErrorMessage({ code: `WHATSAPP_SEND_${body.error.toUpperCase()}`, error: body.error }), attachmentAlreadyHandled: true };
    }
    return { ...(body as WhatsAppSendResult), attachmentAlreadyHandled: true };
  }
  if (body.code === "SESSION_EXPIRED" || body.code === "AUTH_REQUIRED") notifyAuthExpired();
  // Round 950: same PROJECT_NOT_FOUND gap, and the same fix, as
  // streamPipeline's/downloadBlob's/uploadRecordFile's own identical fix
  // above.
  if (body.code === "PROJECT_NOT_FOUND") notifyProjectGone(projectId, resolveErrorMessage(body));
  if (body.code === "VIEWER_READ_ONLY") notifyViewerDemoted(projectId);
  const attachmentAlreadyHandled = body.code === "INVALID_ATTACHMENT" || body.code === "ATTACHMENT_FILE_GONE";
  return { ok: false, error: resolveErrorMessage(body), attachmentAlreadyHandled };
}

export interface WhatsAppMessageLogEntry {
  id: string;
  direction: "in" | "out";
  fromNumber: string;
  toNumber: string;
  body: string;
  matchedLabel: string | null;
  matchedEntityName: string | null;
  matchedRecordId: number | null;
  status: "received" | "sent" | "failed";
  /** Round 1101: true when the original send had an attachment -- the attachment itself is never recoverable (deleted from disk right after the send attempt, win or lose), so Retry can only ever resend the text body. Used to warn before a text-only retry silently drops it a second time. Optional (rather than required) purely so every pre-existing mock/fixture typed as this interface doesn't need updating -- an absent value means the same thing a real false does here. */
  hadAttachment?: boolean;
  createdAt: string;
}

export function listWhatsAppMessages(
  projectId: string,
  cursor?: string | null,
): Promise<{ messages: WhatsAppMessageLogEntry[]; hasMore: boolean; nextCursor: string | null }> {
  const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return request(`/projects/${projectId}/integrations/whatsapp/messages${suffix}`);
}

export function clearWhatsAppMessages(projectId: string): Promise<void> {
  return request(`/projects/${projectId}/integrations/whatsapp/messages`, { method: "DELETE" });
}

/**
 * The complement to clearWhatsAppMessages above -- removes exactly one
 * message from the log, not the whole history.
 *
 * Round 958: same idempotency-key shape as deleteCheckpoint's own fix
 * (round 944) -- a lost response after this message was already deleted
 * must replay that success on retry, not surface a confusing "not found"
 * for a delete that, from the user's own point of view, already fully
 * succeeded.
 */
export function deleteWhatsAppMessage(projectId: string, messageId: string): Promise<void> {
  return request(`/projects/${projectId}/integrations/whatsapp/messages/${messageId}`, {
    method: "DELETE",
    headers: { "x-idempotency-key": crypto.randomUUID() },
  });
}

export type AutomationTrigger = "record_created" | "field_equals" | "schedule" | "record_deleted";
export type AutomationToMode = "static" | "field";
export type AutomationActionType = "send_whatsapp" | "webhook" | "send_email";

export interface AutomationRuleView {
  id: string;
  entityName: string;
  trigger: AutomationTrigger;
  fieldName: string | null;
  fieldValue: string | null;
  scheduleTimeUtc: string | null;
  scheduleDaysOfWeek: string | null;
  /** Round 967: the IANA timezone scheduleTimeUtc/scheduleDaysOfWeek are wall-clock values in; null (treated as "UTC") for a rule created before this field existed. */
  scheduleTimezone: string | null;
  actionType: AutomationActionType;
  toMode: AutomationToMode;
  toNumber: string | null;
  toField: string | null;
  webhookUrl: string | null;
  /** Round 974: sent as an `Authorization: Bearer <webhookSecret>` header on every outbound webhook request when set -- see packages/db's AutomationRule.webhookSecret. Null leaves the request with no Authorization header at all, same as before this field existed. */
  webhookSecret: string | null;
  /** Round 996: the recipient address for actionType "send_email" when toMode is "static" -- see packages/db's AutomationRule.toEmail. */
  toEmail: string | null;
  /** Round 996: the outgoing email's subject line for actionType "send_email" -- messageTemplate below is reused as the email body. */
  emailSubject: string | null;
  messageTemplate: string;
  enabled: boolean;
  lastTriggeredAt: string | null;
  lastStatus: "sent" | "failed" | null;
  lastError: string | null;
  /** Round 948: the actionType this rule actually HAD when lastError was last written -- see packages/db's AutomationRule.lastActionType for why the live `actionType` above must never be used to translate a stale lastError. Null if the rule has never fired, or fired before this column existed. */
  lastActionType: AutomationActionType | null;
  /** Round 959: computed server-side from hasTooManyConsecutiveFailuresToday's own cap (apps/api/src/automations.ts, rounds 924/934/951) -- true means the scheduler has stopped retrying this "schedule"-trigger rule for the rest of today after 5 consecutive real failures, and won't try again until tomorrow's UTC rollover even if the destination is fixed sooner. Always false for a non-"schedule" trigger or a disabled rule, since the scheduler never consults this cap for either. */
  pausedForToday: boolean;
}

export function listAutomationRules(projectId: string): Promise<{ rules: AutomationRuleView[] }> {
  return request(`/projects/${projectId}/automations`);
}

export interface AutomationRunView {
  id: string;
  ruleId: string;
  status: "sent" | "failed";
  error: string | null;
  /** Round 948: the rule's own actionType AT THE TIME this run fired -- see packages/db's AutomationRun.actionType for why. Null for a run recorded before this column existed. */
  actionType: AutomationActionType | null;
  /** Round 971: the id of the record (if any) that triggered this run -- null for a "schedule" rule's own run (there's no triggering record at all), or a run recorded before this column existed. Round 972: a null recordId no longer means "not retryable" by itself -- see retryAutomationRun below for the real rule. */
  recordId: number | null;
  triggeredAt: string;
}

export function listAutomationRuns(projectId: string, ruleId: string): Promise<{ runs: AutomationRunView[] }> {
  return request(`/projects/${projectId}/automations/${ruleId}/runs`);
}

/**
 * Round 971: re-fires a failed record-triggered run against the record's
 * CURRENT state (no historical snapshot of the record exists to replay
 * verbatim).
 *
 * Round 972: a "schedule" rule's own failed run (always `recordId: null`,
 * since there's no triggering record) is ALSO retryable now -- re-fires
 * the schedule rule directly instead, bypassing the server's own daily
 * failure cap for this one manual attempt (that cap only ever governs the
 * automatic per-tick scheduler loop, which otherwise has no way to recover
 * before the next UTC day once it trips). The only case the server still
 * rejects with a 400 is a null-`recordId` run on a NON-schedule rule --
 * only possible for a run recorded before this column existed at all, with
 * no record reference ever captured to resend against. AutomationsPanel.tsx
 * shows the Retry button accordingly: whenever `run.recordId` is non-null,
 * OR the rule's own trigger is "schedule".
 */
export function retryAutomationRun(projectId: string, ruleId: string, runId: string): Promise<{ run: AutomationRunView | null }> {
  return request(`/projects/${projectId}/automations/${ruleId}/runs/${runId}/retry`, {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
  });
}

/**
 * Round 997: fires a rule right now, on demand -- a "schedule" rule sends
 * verbatim (no triggering record exists for it, same as its own real
 * firing); every other trigger fires against the entity's own most
 * recently created record. Throws with code "AUTOMATION_TEST_NO_RECORDS"
 * when a record-triggered rule's entity has no records at all yet.
 */
export function testAutomationRule(projectId: string, ruleId: string): Promise<{ run: AutomationRunView | null }> {
  return request(`/projects/${projectId}/automations/${ruleId}/test`, {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
  });
}

export function createAutomationRule(
  projectId: string,
  entityName: string,
  data: {
    trigger: AutomationTrigger;
    fieldName?: string;
    fieldValue?: string;
    scheduleTimeUtc?: string;
    scheduleDaysOfWeek?: string;
    scheduleTimezone?: string;
    actionType: AutomationActionType;
    toMode: AutomationToMode;
    toNumber?: string;
    toField?: string;
    webhookUrl?: string;
    webhookSecret?: string;
    toEmail?: string;
    emailSubject?: string;
    messageTemplate: string;
  },
): Promise<{ rule: AutomationRuleView }> {
  return request(`/projects/${projectId}/entities/${encodeURIComponent(entityName)}/automations`, {
    method: "POST",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(data),
  });
}

/** Round 953: same idempotency-key shape as createAutomationRule's own fix (round 600) -- a lost response after this rule was already updated must replay that success on retry, not risk clobbering a genuinely different concurrent edit. */
export function updateAutomationRule(
  projectId: string,
  ruleId: string,
  patch: Partial<{
    trigger: AutomationTrigger;
    fieldName: string | null;
    fieldValue: string | null;
    scheduleTimeUtc: string | null;
    scheduleDaysOfWeek: string | null;
    scheduleTimezone: string | null;
    actionType: AutomationActionType;
    toMode: AutomationToMode;
    toNumber: string | null;
    toField: string | null;
    webhookUrl: string | null;
    webhookSecret: string | null;
    toEmail: string | null;
    emailSubject: string | null;
    messageTemplate: string;
    enabled: boolean;
  }>,
): Promise<{ rule: AutomationRuleView }> {
  return request(`/projects/${projectId}/automations/${ruleId}`, {
    method: "PATCH",
    headers: { "x-idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(patch),
  });
}

/** Round 953: same idempotency-key shape as createAutomationRule's own fix (round 600) -- a lost response after this rule was already deleted must replay that success on retry, not surface a confusing "not found". */
export function deleteAutomationRule(projectId: string, ruleId: string): Promise<void> {
  return request(`/projects/${projectId}/automations/${ruleId}`, {
    method: "DELETE",
    headers: { "x-idempotency-key": crypto.randomUUID() },
  });
}
