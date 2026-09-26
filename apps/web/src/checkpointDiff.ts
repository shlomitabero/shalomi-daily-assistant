import type { Checkpoint, ProductSpec } from "@forge/shared";
import { safeDownloadName } from "./api.js";
import type { Lang } from "./i18n/language.js";

const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

export interface CheckpointDiff {
  removedEntities: { name: string; label: string }[];
  changedEntities: { name: string; label: string; removedFieldNames: string[] }[];
}

/**
 * Restoring never destroys data (migrations are additive-only, see
 * projects.ts's restore route), but it DOES move which entities/fields the
 * live app currently *shows* -- so before clicking Restore, a real question
 * is "what would disappear from the screens I see right now if I go back to
 * this older checkpoint?" This answers exactly that, in the opposite
 * direction from pipeline.ts's own computeImpact (which reports what a
 * build newly ADDS going forward): an entity present now but missing from
 * the checkpoint would be removed, and a field present now but missing from
 * the checkpoint (on an entity that still exists) would be removed too.
 */
export function computeCheckpointDiff(currentSpec: ProductSpec, checkpointSpec: ProductSpec): CheckpointDiff {
  const checkpointEntities = new Map(checkpointSpec.entities.map((e) => [e.name, e]));
  const removedEntities: { name: string; label: string }[] = [];
  const changedEntities: { name: string; label: string; removedFieldNames: string[] }[] = [];

  for (const entity of currentSpec.entities) {
    const inCheckpoint = checkpointEntities.get(entity.name);
    if (!inCheckpoint) {
      removedEntities.push({ name: entity.name, label: entity.label ?? entity.name });
      continue;
    }
    const checkpointFieldNames = new Set(inCheckpoint.fields.map((f) => f.name));
    const removedFieldNames = entity.fields.filter((f) => !checkpointFieldNames.has(f.name)).map((f) => f.label ?? f.name);
    if (removedFieldNames.length > 0) {
      changedEntities.push({ name: entity.name, label: entity.label ?? entity.name, removedFieldNames });
    }
  }

  return { removedEntities, changedEntities };
}

/**
 * Whether a checkpoint's own entities/fields are exactly what the app is
 * showing right now -- not just "restoring it wouldn't remove anything"
 * (computeCheckpointDiff's own, one-directional question), but "you are
 * already looking at this". After a restore to an OLDER checkpoint, the
 * list's own newest-first order no longer lines up with which entry is
 * actually current -- the most-recently-created checkpoint at the top can
 * be stale once you've gone back to an earlier one, with nothing in the
 * list itself saying so. Compared as sets of entity/field names (matching
 * computeCheckpointDiff's own scope) rather than full JSON equality, since
 * array order is never meaningful here and isn't guaranteed stable.
 */
export function isCheckpointCurrent(currentSpec: ProductSpec, checkpointSpec: ProductSpec): boolean {
  const currentNames = new Set(currentSpec.entities.map((e) => e.name));
  const checkpointNames = new Set(checkpointSpec.entities.map((e) => e.name));
  if (currentNames.size !== checkpointNames.size) return false;
  for (const name of currentNames) {
    if (!checkpointNames.has(name)) return false;
  }

  const checkpointEntities = new Map(checkpointSpec.entities.map((e) => [e.name, e]));
  for (const entity of currentSpec.entities) {
    const inCheckpoint = checkpointEntities.get(entity.name)!;
    const currentFieldNames = new Set(entity.fields.map((f) => f.name));
    const checkpointFieldNames = new Set(inCheckpoint.fields.map((f) => f.name));
    if (currentFieldNames.size !== checkpointFieldNames.size) return false;
    for (const fieldName of currentFieldNames) {
      if (!checkpointFieldNames.has(fieldName)) return false;
    }
  }

  return true;
}

/**
 * Case-insensitive substring match on a checkpoint's own label -- a real
 * refine's label ("Refine: add invoice tracking") always carries the
 * actual instruction that produced it (see apps/api/src/routes/projects.ts's
 * changeLabel), so this is genuinely searchable, not just cosmetic text.
 * Every build/refine adds one more entry to this list forever (there's no
 * cap and no delete), so a project with a long history had no way to find
 * one specific checkpoint besides scrolling and reading every label --
 * mirrors filterAndSortProjects' own convention for "Your projects".
 */
export function filterCheckpoints(checkpoints: Checkpoint[], search: string): Checkpoint[] {
  const query = search.trim().toLowerCase();
  if (!query) return checkpoints;
  return checkpoints.filter((c) => c.label.toLowerCase().includes(query));
}

export type CheckpointType = "build" | "refine";

/**
 * Every checkpoint's own label already encodes which kind of change made
 * it, exactly like the WhatsApp log's own message.direction field encodes
 * incoming vs. outgoing -- but here it's baked into the label text itself
 * rather than a separate column (see apps/api/src/routes/projects.ts's
 * changeLabel: "Initial build"/"בנייה ראשונית" for a fresh build, or
 * "Refine: <instruction>"/"שיפור: <instruction>" for every refine after
 * it). Read from the label with startsWith rather than persisted
 * separately, since the label is the only place this distinction already
 * lives and every checkpoint ever created already carries it correctly.
 */
export function getCheckpointType(checkpoint: Checkpoint): CheckpointType {
  return checkpoint.label.startsWith("Refine:") || checkpoint.label.startsWith("שיפור:") ? "refine" : "build";
}

/**
 * Composes with (never replaces) filterCheckpoints' own text search --
 * the same independent-filters combination EntityPanel.tsx's
 * search+statusFilter and WhatsAppPanel.tsx's search+directionFilter
 * already use. A project with a long refine history had no way to
 * isolate "just the original build" from "everything I've refined
 * since" besides reading every label -- exactly the same never-capped,
 * never-deleted growth filterCheckpoints' own doc comment already
 * describes for text search.
 */
export function filterCheckpointsByType(checkpoints: Checkpoint[], type: "all" | CheckpointType): Checkpoint[] {
  if (type === "all") return checkpoints;
  return checkpoints.filter((c) => getCheckpointType(c) === type);
}

/**
 * How many of the checkpoint list's entries are currently showing versus
 * how many exist in total -- the same two-distinct-phrasings convention
 * formatEntityRecordCount (entityFormatting.ts, round 155),
 * formatMyProjectsCount (App.tsx, round 167), and
 * formatWhatsAppMessageCount (whatsappLog.ts, round 170) already
 * established elsewhere in this app, applied here to this panel's own
 * search box (round 157): the search only even appears past
 * HistoryPanel's own 5-checkpoint threshold, exactly the point where a
 * person can no longer tell at a glance how many of a project's
 * ever-growing, never-capped build/refine history a search actually
 * matched.
 */
export function formatCheckpointCount(
  shown: number,
  total: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  return shown === total
    ? t("history.count.all", { count: total })
    : t("history.count.filtered", { shown, total });
}

/**
 * Renders the checkpoint list (already fetched into the panel -- no extra
 * network round-trip) as a plain, shareable text snapshot -- same "plain
 * UTF-8 text, not a PDF" reasoning as twinReport.ts's own doc comment
 * (this app's Hebrew-first audience means a real PDF would need an
 * embedded Hebrew font, a bigger undertaking than this feature's value
 * justifies). Every build/refine adds one more entry to this list forever
 * with no cap and no delete, so this is the only way to keep a permanent
 * record of a project's own build history outside the app -- the same gap
 * this app's other two panels (Business Twin, round 129; WhatsApp log,
 * round 154) already closed for their own data.
 */
export function formatCheckpointHistory(
  checkpoints: Checkpoint[],
  currentSpec: ProductSpec,
  projectName: string,
  lang: Lang,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const lines: string[] = [];
  lines.push(`${t("history.title")} — ${projectName}`);
  lines.push(t("history.report.generatedAt", { date: new Date().toLocaleString(LOCALE[lang]) }));
  lines.push("");

  if (checkpoints.length === 0) {
    lines.push(t("history.empty"));
    return lines.join("\n");
  }

  for (const checkpoint of checkpoints) {
    const time = new Date(checkpoint.createdAt).toLocaleString(LOCALE[lang]);
    const current = isCheckpointCurrent(currentSpec, checkpoint.spec) ? ` [${t("history.current")}]` : "";
    lines.push(`${checkpoint.label}${current}`);
    lines.push(`${time} — ${t("history.screenCount", { count: checkpoint.spec.entities.length })}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * The panel's own diff toggle only ever answered one question: "what would
 * restoring THIS checkpoint remove from the live app right now?" -- always
 * diffing against currentSpec, with no way to compare two arbitrary past
 * checkpoints against each other (e.g. "what did refine #3 add that refine
 * #1 didn't have yet?"). computeCheckpointDiff itself was always generic
 * (it takes two plain ProductSpecs, not "current" and "a checkpoint"
 * specifically), so the only real gap was picking which spec plays the
 * baseline role -- this resolves that choice: null (the default, "compare
 * with current") keeps the exact existing behavior, any other id swaps in
 * that checkpoint's own spec instead. Falls back to currentSpec if the
 * chosen id doesn't match any known checkpoint (e.g. one just got deleted
 * mid-session by a concurrent action) rather than throwing.
 */
export function resolveCompareSpec(checkpoints: Checkpoint[], compareTargetId: string | null, currentSpec: ProductSpec): ProductSpec {
  if (compareTargetId == null) return currentSpec;
  return checkpoints.find((c) => c.id === compareTargetId)?.spec ?? currentSpec;
}

/**
 * The header line above the diff list -- names which baseline the shown
 * diff is actually against, so switching the "compare with" dropdown (see
 * resolveCompareSpec above) doesn't leave a stale-looking, unlabeled list
 * that still reads as if it were comparing against the live current state.
 */
export function formatCompareTarget(
  checkpoints: Checkpoint[],
  compareTargetId: string | null,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (compareTargetId == null) return t("history.diff.currentState");
  const target = checkpoints.find((c) => c.id === compareTargetId);
  return target ? target.label : t("history.diff.currentState");
}

/** Saves the already-rendered history text as a real downloaded .txt file, the same browser-download mechanics twinReport.ts's downloadTwinReport uses. */
export function downloadCheckpointHistory(text: string, projectName: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeDownloadName(projectName, "forge-app")}-history.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
