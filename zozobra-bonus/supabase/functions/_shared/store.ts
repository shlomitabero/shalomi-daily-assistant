// Data access contract shared by the web app, the edge functions and tests.
// Business logic (ingest, recalc) depends only on this interface; the
// Supabase implementation lives in store-supabase.ts.

import type { Direction, JobRole, MetricId, Scope } from "./metrics.ts";

export type SystemId =
  | "manual" | "csv" | "webhook" | "tabit" | "beecomm" | "cost" | "payroll" | "pbx" | "survey";

export interface EmployeeRec {
  id: string;
  branchId: string;
  firstName: string;
  lastName: string;
  phone: string;
  jobRole: JobRole;
  payrollId: string | null;
  tipBased: boolean;
  bonusEligible: boolean;
  startDate: string | null;
  endDate: string | null;
  active: boolean;
}

export interface ExternalIdRec {
  employeeId: string;
  system: SystemId;
  externalId: string;
  externalName: string | null;
}

export interface MetricRec {
  id: MetricId;
  name: string;
  scope: Scope;
  direction: Direction;
  unit: string;
}

export interface TargetRec {
  id: string;
  metricId: MetricId;
  target: number;
  thresholdPct: number;
  maxAmount: number;
  active: boolean;
  roleMaxAmount: Partial<Record<JobRole, number>>;
}

export interface ResultRec {
  metricId: MetricId;
  employeeId: string | null;
  value: number;
}

export interface ResultUpsert extends ResultRec {
  branchId: string;
  period: string; // YYYY-MM
  source: SystemId;
  integrationId: string | null;
  note?: string | null;
}

export interface UnmatchedInsert {
  branchId: string;
  system: SystemId;
  period: string;
  externalId: string | null;
  externalName: string | null;
  metricId: MetricId;
  value: number;
}

export interface PayoutRec {
  id: string;
  employeeId: string;
  amount: number;
  status: "draft" | "approved" | "paid";
}

export interface PayoutUpsert {
  branchId: string;
  period: string;
  employeeId: string;
  amount: number;
  lines: unknown;
  avgAchievement: number | null;
  realization: number | null;
  missingMetrics: string[];
}

export interface SourceMapRec {
  metricId: MetricId;
  system: SystemId;
  externalKey: string;
}

export interface SyncLogStart {
  branchId: string;
  integrationId: string | null;
  system: SystemId;
  trigger: "cron" | "manual" | "webhook" | "csv";
  period: string | null;
}

export interface SyncLogFinish {
  status: "success" | "partial" | "failed";
  rowsReceived: number;
  rowsWritten: number;
  rowsUnmatched: number;
  rowsRejected: number;
  message: string;
  details?: unknown;
}

export interface DataStore {
  getEmployees(branchId: string): Promise<EmployeeRec[]>;
  getExternalIds(branchId: string): Promise<ExternalIdRec[]>;
  getMetrics(): Promise<MetricRec[]>;
  getRoleMetrics(): Promise<{ jobRole: JobRole; metricId: MetricId }[]>;
  getTargets(branchId: string, period: string): Promise<TargetRec[]>;
  getResults(branchId: string, period: string): Promise<ResultRec[]>;
  getPayouts(branchId: string, period: string): Promise<PayoutRec[]>;
  getSourceMap(branchId: string): Promise<SourceMapRec[]>;
  upsertResults(rows: ResultUpsert[]): Promise<void>;
  insertUnmatched(rows: UnmatchedInsert[]): Promise<void>;
  upsertPayouts(rows: PayoutUpsert[]): Promise<void>;
  deleteDraftPayouts(ids: string[]): Promise<void>;
  startSync(s: SyncLogStart): Promise<string>;
  finishSync(id: string, f: SyncLogFinish): Promise<void>;
}
