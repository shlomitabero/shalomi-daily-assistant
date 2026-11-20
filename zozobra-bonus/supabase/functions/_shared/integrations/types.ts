// Pluggable adapter contract: every data source turns its own format into
// NormalizedRow[] for a period. Matching, authority checks, writing and
// recalculation are done once, centrally, by ingestRows().

import type { NormalizedRow } from "../ingest.ts";
import type { SystemId } from "../store.ts";

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "url" | "select" | "json";
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
}

export interface AdapterContext {
  integrationId: string;
  branchId: string;
  config: Record<string, unknown>;
  /** From Supabase Vault. Server/edge only — never sent to the browser. */
  secret: string | null;
  fetch: typeof fetch;
}

export interface FetchResult {
  rows: NormalizedRow[];
  meta?: Record<string, unknown>;
}

export interface MetricsAdapter {
  system: SystemId;
  label: string;
  /** what the UI should offer */
  capabilities: { pull: boolean; report: boolean; webhook: boolean };
  /** metrics this source can provide by default, with its own key names */
  defaultKeys: Record<string, string>;
  configFields: ConfigField[];
  needsSecret: boolean;
  /** human-readable problems that block a pull (empty = ready) */
  readiness(config: Record<string, unknown>, hasSecret: boolean): string[];
  fetchMetrics(ctx: AdapterContext, period: string): Promise<FetchResult>;
  /** parse a report file exported from the system (CSV) */
  parseReport?(text: string, period: string, config: Record<string, unknown>): NormalizedRow[];
}

export class AdapterNotReadyError extends Error {
  constructor(public problems: string[]) {
    super(problems.join(" · "));
    this.name = "AdapterNotReadyError";
  }
}
