import type { AutomationRuleView } from "./api.js";

export interface NewlyFailingAutomations {
  count: number;
  entityName: string;
}

/**
 * Unlike WhatsApp's message log (findNewInboundMessages, whatsappNotify.ts),
 * listAutomationRules always returns the full current set of rules, not an
 * append-only stream -- and a rule can recover (lastStatus flips back to
 * "sent" after a retry/fix) and later fail again. So the baseline here is
 * the full set of currently-failing rule ids from the previous check, not a
 * single newest-seen marker: diffing two full snapshots against each other
 * naturally forgets a rule the moment it stops failing, so a later failure
 * is treated as new again with no extra bookkeeping to explicitly "untrack"
 * a recovered rule.
 *
 * Returns null when previouslyFailingIds is null: the very first check
 * after a project loads has no baseline yet, and treating every
 * already-failing rule as "newly" failing would fire a desktop notification
 * for a pre-existing problem the instant the tab loads -- the same
 * reasoning findNewInboundMessages applies to a null lastNotified.
 */
export function findNewlyFailingAutomations(
  rules: AutomationRuleView[],
  previouslyFailingIds: Set<string> | null,
): NewlyFailingAutomations | null {
  if (previouslyFailingIds === null) return null;
  const newlyFailing = rules.filter((r) => r.enabled && r.lastStatus === "failed" && !previouslyFailingIds.has(r.id));
  if (newlyFailing.length === 0) return null;
  return { count: newlyFailing.length, entityName: newlyFailing[0].entityName };
}
