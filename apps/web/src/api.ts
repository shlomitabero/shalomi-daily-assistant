import type { EntityRecord, Project } from "@forge/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function createProject(description: string): Promise<{ project: Project; providerName: string }> {
  return request("/projects", { method: "POST", body: JSON.stringify({ description }) });
}

export function buildProject(projectId: string): Promise<{ project: Project }> {
  return request(`/projects/${projectId}/build`, { method: "POST" });
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
