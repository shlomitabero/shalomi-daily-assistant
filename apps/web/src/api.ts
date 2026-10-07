import type { AgentStepEvent, Checkpoint, EntityRecord, Project, ProjectCollaborator, User } from "@forge/shared";
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
 * stay comfortably above 101s of cold-start retrying plus a 60s Anthropic
 * call that only *starts* once the connection finally succeeds: 101 + 60 =
 * 161s is the real worst-case legitimate total. An earlier version of this
 * same ceiling (100s) was already less than an even smaller 109s worst
 * case, producing exactly the false-positive "this is taking too long"
 * error this comment now warns against repeating -- confirmed by a real
 * report with a screenshot of that exact error on the enhance-and-build
 * flow. This value adds just under a minute of margin on top of the 161s
 * worst case for request/response transfer, JSON parsing, and DB writes,
 * rather than shaving it as close as possible to the theoretical minimum.
 * Whenever DEFAULT_DELAYS_MS's own total changes, this must be
 * recalculated too -- that exact mismatch is what caused the bug both
 * versions of this comment describe.
 */
export const REQUEST_TIMEOUT_MS = 220_000;

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
    if (code === "SESSION_EXPIRED" || code === "AUTH_REQUIRED") notifyAuthExpired();
    throw new Error(resolveErrorMessage(body as { error?: string; code?: string }));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function signup(email: string, password: string): Promise<{ user: User; token: string }> {
  return request("/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) });
}

export function login(email: string, password: string): Promise<{ user: User; token: string }> {
  return request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

export function me(): Promise<{ user: User }> {
  return request("/auth/me");
}

export async function logout(): Promise<void> {
  await request("/auth/logout", { method: "POST" }).catch(() => undefined);
  clearToken();
}

export function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return request("/auth/password", { method: "PATCH", body: JSON.stringify({ currentPassword, newPassword }) });
}

/**
 * Real, permanent self-service account deletion (DeleteAccountPanel.tsx).
 * The server's own session is already gone by the time this resolves (the
 * DELETE route revokes every session, this one included), so this doesn't
 * separately call clearToken -- the caller does that itself once this
 * succeeds, the same way logout() above pairs a server call with its own
 * local cleanup.
 */
export function deleteAccount(): Promise<void> {
  return request("/auth/account", { method: "DELETE" });
}

export function createProject(description: string): Promise<{ project: Project; providerName: string }> {
  return request("/projects", { method: "POST", body: JSON.stringify({ description }) });
}

export interface TemplateSummary {
  id: string;
  icon: string;
  name: string;
  nameHe: string;
  description: string;
  descriptionHe: string;
}

export function listTemplates(): Promise<{ templates: TemplateSummary[] }> {
  return request("/templates");
}

export function createProjectFromTemplate(templateId: string, lang: "he" | "en"): Promise<{ project: Project }> {
  return request("/projects/from-template", { method: "POST", body: JSON.stringify({ templateId, lang }) });
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

export function cloneProject(projectId: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/clone`, { method: "POST" });
}

export function renameProject(projectId: string, name: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/name`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export function updateProjectDescription(projectId: string, description: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/description`, { method: "PATCH", body: JSON.stringify({ description }) });
}

export function renameEntityLabel(projectId: string, entityName: string, label: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/entities/${entityName}/label`, { method: "PATCH", body: JSON.stringify({ label }) });
}

export function renameFieldLabel(
  projectId: string,
  entityName: string,
  fieldName: string,
  label: string,
): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/entities/${entityName}/fields/${fieldName}/label`, {
    method: "PATCH",
    body: JSON.stringify({ label }),
  });
}

export function addField(projectId: string, entityName: string, label: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/entities/${entityName}/fields`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
}

export function removeField(projectId: string, entityName: string, fieldName: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/entities/${entityName}/fields/${fieldName}`, { method: "DELETE" });
}

export function deleteProject(projectId: string): Promise<void> {
  return request(`/projects/${projectId}`, { method: "DELETE" });
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
 */
export function removeRole(projectId: string, index: number, expect: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/roles/${index}`, { method: "DELETE", body: JSON.stringify({ expect }) });
}

export function removeAssumption(projectId: string, index: number, expect: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/assumptions/${index}`, {
    method: "DELETE",
    body: JSON.stringify({ expect }),
  });
}

export function addRole(projectId: string, role: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/roles`, { method: "POST", body: JSON.stringify({ role }) });
}

export function addAssumption(projectId: string, assumption: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/assumptions`, { method: "POST", body: JSON.stringify({ assumption }) });
}

export function renameRole(
  projectId: string,
  index: number,
  role: string,
  expect: string,
): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/roles/${index}`, {
    method: "PATCH",
    body: JSON.stringify({ role, expect }),
  });
}

export function renameAssumption(
  projectId: string,
  index: number,
  assumption: string,
  expect: string,
): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/assumptions/${index}`, {
    method: "PATCH",
    body: JSON.stringify({ assumption, expect }),
  });
}

export function removeEntity(projectId: string, entityName: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/entities/${entityName}`, { method: "DELETE" });
}

export function addEntity(projectId: string, label: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/entities`, { method: "POST", body: JSON.stringify({ label }) });
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
 * no-op case.
 */
export function answerQuestions(
  projectId: string,
  answers: Record<string, string>,
  additionalRequest?: string,
): Promise<{ project: Project; providerName?: string }> {
  return request(`/projects/${projectId}/answers`, {
    method: "POST",
    body: JSON.stringify({ answers, additionalRequest }),
  });
}

/**
 * Consumes the streaming build/refine pipeline (Server-Sent Events framing
 * over a plain fetch, so the same Authorization header works — EventSource
 * can't set custom headers). Calls onEvent for every agent step as it
 * arrives and resolves once the stream ends.
 */
async function streamPipeline(
  path: string,
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
    if (code === "SESSION_EXPIRED" || code === "AUTH_REQUIRED") notifyAuthExpired();
    throw new Error(resolveErrorMessage(errorBody as { error?: string; code?: string }));
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
  return streamPipeline(`/projects/${projectId}/build`, onEvent);
}

export function streamRefine(
  projectId: string,
  instruction: string,
  onEvent: (event: AgentStepEvent) => void,
): Promise<void> {
  return streamPipeline(`/projects/${projectId}/refine`, onEvent, { instruction });
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
 */
async function downloadBlob(path: string, downloadName: string): Promise<void> {
  const token = getToken();
  const res = await fetchApi(path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `Request failed (${res.status})`, code: "REQUEST_FAILED" }));
    const code = (body as { code?: string }).code;
    if (code === "SESSION_EXPIRED" || code === "AUTH_REQUIRED") notifyAuthExpired();
    throw new Error(resolveErrorMessage(body as { error?: string; code?: string }));
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
  return downloadBlob(`/api/projects/${projectId}/export`, `${safeDownloadName(projectName, "forge-app")}.zip`);
}

/**
 * Downloads a single .zip containing one CSV per entity -- the whole
 * project's data at once, instead of visiting every tab's own CSV export
 * button.
 */
export function backupProject(projectId: string, projectName: string): Promise<void> {
  return downloadBlob(`/api/projects/${projectId}/backup`, `${safeDownloadName(projectName, "forge-app")}-backup.zip`);
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
}

export function getBusinessTwin(projectId: string): Promise<{ twin: BusinessTwin }> {
  return request(`/projects/${projectId}/twin`);
}

export function getEntityCounts(projectId: string): Promise<{ counts: Record<string, number> }> {
  return request(`/projects/${projectId}/entity-counts`);
}

export function listCheckpoints(projectId: string): Promise<{ checkpoints: Checkpoint[] }> {
  return request(`/projects/${projectId}/checkpoints`);
}

export function restoreCheckpoint(projectId: string, checkpointId: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/checkpoints/${checkpointId}/restore`, { method: "POST" });
}

export function renameCheckpoint(projectId: string, checkpointId: string, label: string): Promise<{ checkpoint: Checkpoint }> {
  return request(`/projects/${projectId}/checkpoints/${checkpointId}`, { method: "PATCH", body: JSON.stringify({ label }) });
}

export function deleteCheckpoint(projectId: string, checkpointId: string): Promise<void> {
  return request(`/projects/${projectId}/checkpoints/${checkpointId}`, { method: "DELETE" });
}

export function listRecords(projectId: string, entityName: string): Promise<{ records: EntityRecord[] }> {
  return request(`/projects/${projectId}/entities/${entityName}`);
}

export function createRecord(
  projectId: string,
  entityName: string,
  data: Record<string, unknown>,
): Promise<{ record: EntityRecord }> {
  return request(`/projects/${projectId}/entities/${entityName}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateRecord(
  projectId: string,
  entityName: string,
  recordId: number,
  data: Record<string, unknown>,
): Promise<{ record: EntityRecord }> {
  return request(`/projects/${projectId}/entities/${entityName}/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteRecord(projectId: string, entityName: string, recordId: number): Promise<void> {
  return request(`/projects/${projectId}/entities/${entityName}/${recordId}`, { method: "DELETE" });
}

/** The owner never appears in `collaborators` itself (see collaborators.ts's own module comment -- their access comes from project.ownerId, not the join table), so the panel needs this separately to show who actually owns the project. Null only in the should-never-happen case of a dangling owner reference. */
export interface ProjectOwnerInfo {
  userId: string;
  email: string;
}

export function listCollaborators(projectId: string): Promise<{ collaborators: ProjectCollaborator[]; owner: ProjectOwnerInfo | null }> {
  return request(`/projects/${projectId}/collaborators`);
}

export function addCollaborator(
  projectId: string,
  email: string,
): Promise<{ collaborators: ProjectCollaborator[]; owner: ProjectOwnerInfo | null }> {
  return request(`/projects/${projectId}/collaborators`, { method: "POST", body: JSON.stringify({ email }) });
}

export function removeCollaborator(projectId: string, userId: string): Promise<void> {
  return request(`/projects/${projectId}/collaborators/${userId}`, { method: "DELETE" });
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
}

export async function sendWhatsAppMessage(projectId: string, to: string, message: string): Promise<WhatsAppSendResult> {
  const token = getToken();
  const res = await fetchApi(`/api/projects/${projectId}/integrations/whatsapp/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ to, message }),
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
  if (typeof body.ok === "boolean") return body as WhatsAppSendResult;
  if (body.code === "SESSION_EXPIRED" || body.code === "AUTH_REQUIRED") notifyAuthExpired();
  return { ok: false, error: resolveErrorMessage(body) };
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
  createdAt: string;
}

export function listWhatsAppMessages(
  projectId: string,
  offset = 0,
): Promise<{ messages: WhatsAppMessageLogEntry[]; hasMore: boolean }> {
  const suffix = offset > 0 ? `?offset=${offset}` : "";
  return request(`/projects/${projectId}/integrations/whatsapp/messages${suffix}`);
}

export function clearWhatsAppMessages(projectId: string): Promise<void> {
  return request(`/projects/${projectId}/integrations/whatsapp/messages`, { method: "DELETE" });
}

/** The complement to clearWhatsAppMessages above -- removes exactly one message from the log, not the whole history. */
export function deleteWhatsAppMessage(projectId: string, messageId: string): Promise<void> {
  return request(`/projects/${projectId}/integrations/whatsapp/messages/${messageId}`, { method: "DELETE" });
}
