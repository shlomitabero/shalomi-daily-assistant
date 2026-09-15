import type { AgentStepEvent, Checkpoint, EntityRecord, Project, User } from "@forge/shared";

const TOKEN_KEY = "forge.token";

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
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
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
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok || !res.body) {
    const errorBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((errorBody as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
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
 * Downloads the real, standalone exported app as a .zip and saves it via
 * the browser's normal download flow. Uses a blob (not a plain <a href>)
 * because the request needs the Authorization header.
 */
export async function exportProject(projectId: string, projectName: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`/api/projects/${projectId}/export`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${projectName.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "forge-app"}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
