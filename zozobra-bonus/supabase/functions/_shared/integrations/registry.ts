import { beecommAdapter, costAdapter, payrollAdapter, pbxAdapter, surveyAdapter } from "./stubs.ts";
import { tabitAdapter } from "./tabit.ts";
import type { MetricsAdapter } from "./types.ts";
import { webhookAdapter } from "./webhook.ts";
import type { SystemId } from "../store.ts";

export const ADAPTERS: Partial<Record<SystemId, MetricsAdapter>> = {
  tabit: tabitAdapter,
  beecomm: beecommAdapter,
  cost: costAdapter,
  payroll: payrollAdapter,
  pbx: pbxAdapter,
  survey: surveyAdapter,
  webhook: webhookAdapter,
};

export function adapterFor(system: string): MetricsAdapter | null {
  return ADAPTERS[system as SystemId] ?? null;
}
