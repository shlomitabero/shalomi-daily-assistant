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

export function listProjects(): Promise<{ projects: Project[] }> {
  return request("/projects");
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
