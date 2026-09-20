import type { AgentStepEvent, Checkpoint, EntityRecord, Project, User } from "@forge/shared";
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

/**
 * A generous ceiling on the *whole* request, retries included -- comfortably
 * above the server's own 60s Anthropic-call timeout (see
 * packages/spec-engine/src/anthropicFetch.ts) plus real cold-start latency,
 * but still a hard bound. Without this, a request whose connection succeeds
 * but whose response never arrives (a stalled upstream call, or a Render
 * cold start that happens not to surface as a connection-level failure)
 * hung forever with the UI stuck on a busy spinner ("thinking it over…")
 * and absolutely no feedback -- exactly the real report that motivated this:
 * the home screen "just sits there" and never delivers the built app.
 * fetchWithWakeRetry's own retry-on-thrown-error logic only helps the
 * connection-refused case; a slow-but-not-yet-failed response sails right
 * through it untouched, which is the gap this closes.
 */
const REQUEST_TIMEOUT_MS = 100_000;

/**
 * Wraps fetchWithWakeRetry so that if every retry is exhausted (the
 * backend is genuinely unreachable, not just cold-starting), the caller
 * sees a translated message instead of the browser's raw, untranslated
 * network-error text (e.g. "Failed to fetch"). Also bounds the total wait
 * with REQUEST_TIMEOUT_MS so a hung request fails clearly instead of
 * spinning forever.
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

export function createProject(description: string): Promise<{ project: Project; providerName: string }> {
  return request("/projects", { method: "POST", body: JSON.stringify({ description }) });
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
 * Sends the user's answers to the spec's open questions (quick-pick or
 * freely typed), and/or a free-standing request not tied to any specific
 * question, back to the server, which regenerates the spec from them
 * before the build runs — so this actually changes what gets built, not
 * just which chip looks selected.
 */
export function answerQuestions(
  projectId: string,
  answers: Record<string, string>,
  additionalRequest?: string,
): Promise<{ project: Project }> {
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
}

export function getBusinessTwin(projectId: string): Promise<{ twin: BusinessTwin }> {
  return request(`/projects/${projectId}/twin`);
}

export function listCheckpoints(projectId: string): Promise<{ checkpoints: Checkpoint[] }> {
  return request(`/projects/${projectId}/checkpoints`);
}

export function restoreCheckpoint(projectId: string, checkpointId: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/checkpoints/${checkpointId}/restore`, { method: "POST" });
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

export function listWhatsAppMessages(projectId: string): Promise<{ messages: WhatsAppMessageLogEntry[] }> {
  return request(`/projects/${projectId}/integrations/whatsapp/messages`);
}

export function clearWhatsAppMessages(projectId: string): Promise<void> {
  return request(`/projects/${projectId}/integrations/whatsapp/messages`, { method: "DELETE" });
}
