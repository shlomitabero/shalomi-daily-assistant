const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * SQLite identifiers (table/column names) can't be parameterized with `?`.
 * Every identifier that ends up in a raw SQL string must pass through this
 * allowlist first — defense against SQL injection via entity/field names
 * that originate from an LLM response or user-provided project data.
 */
export function assertSafeIdentifier(value: string, kind: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Unsafe ${kind} identifier: ${JSON.stringify(value)}`);
  }
  return value;
}

export function tableNameFor(projectId: string, entityName: string): string {
  const safeProjectId = projectId.replace(/[^A-Za-z0-9]/g, "_");
  const safeEntity = entityName.replace(/[^A-Za-z0-9]/g, "_");
  return assertSafeIdentifier(`entity_${safeProjectId}_${safeEntity}`, "table");
}
