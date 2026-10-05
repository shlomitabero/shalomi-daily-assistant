import type { Checkpoint, Field, ProductSpec } from "@forge/shared";
import { safeDownloadName } from "./api.js";
import type { Lang } from "./i18n/language.js";

const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

export interface CheckpointDiff {
  removedEntities: { name: string; label: string }[];
  addedEntities: { name: string; label: string }[];
  changedEntities: { name: string; label: string; removedFieldNames: string[]; addedFieldNames: string[]; changedFieldNames: string[] }[];
}

/**
 * A field's "shape" for diff/current-check purposes -- everything about it
 * that changes what the app actually does with the field, not just its
 * display label (which computeCheckpointDiff intentionally never compares,
 * matching FieldLabelEditor's own view that a label rename isn't a
 * structural change worth flagging here). Two same-named fields with equal
 * signatures are the "same field, unchanged" that both functions below
 * already assumed name-matching alone implied -- which silently stopped
 * being true the moment a refine changes a field's type (e.g. free text ->
 * enum) without renaming it, exactly the gap this fixes.
 */
function fieldSignature(f: Field): string {
  const enumPart = f.type === "enum" ? (f.enumValues ?? []).slice().sort().join(",") : "";
  const relationPart = f.type === "relation" ? (f.relationTo ?? "") : "";
  return `${f.type}|${relationPart}|${enumPart}`;
}

/**
 * Restoring never destroys data (migrations are additive-only, see
 * projects.ts's restore route), but it DOES move which entities/fields the
 * live app currently *shows* -- so before clicking Restore, a real question
 * is "what would disappear from (or newly appear on) the screens I see right
 * now if I go back to this older checkpoint?" This answers exactly that, in
 * the opposite direction from pipeline.ts's own computeImpact (which reports
 * what a build newly ADDS going forward relative to a fixed live spec): an
 * entity/field present in one spec but not the other is reported on
 * whichever side it's missing from. Both directions matter equally here,
 * unlike computeImpact's single fixed direction, because resolveCompareSpec
 * lets the "current" argument be an arbitrary older checkpoint too (see its
 * own doc comment) -- e.g. "what did refine #3 add that refine #1 didn't
 * have yet?" is exactly an addedEntities/addedFieldNames question, not a
 * removal one, even though it's asked through this same function.
 */
export function computeCheckpointDiff(currentSpec: ProductSpec, checkpointSpec: ProductSpec): CheckpointDiff {
  const checkpointEntities = new Map(checkpointSpec.entities.map((e) => [e.name, e]));
  const currentEntities = new Map(currentSpec.entities.map((e) => [e.name, e]));
  const removedEntities: { name: string; label: string }[] = [];
  const addedEntities: { name: string; label: string }[] = [];
  const changedEntities: {
    name: string;
    label: string;
    removedFieldNames: string[];
    addedFieldNames: string[];
    changedFieldNames: string[];
  }[] = [];

  for (const entity of currentSpec.entities) {
    const inCheckpoint = checkpointEntities.get(entity.name);
    if (!inCheckpoint) {
      removedEntities.push({ name: entity.name, label: entity.label ?? entity.name });
      continue;
    }
    const checkpointFieldsByName = new Map(inCheckpoint.fields.map((f) => [f.name, f]));
    const currentFieldNames = new Set(entity.fields.map((f) => f.name));
    const removedFieldNames = entity.fields.filter((f) => !checkpointFieldsByName.has(f.name)).map((f) => f.label ?? f.name);
    const addedFieldNames = inCheckpoint.fields.filter((f) => !currentFieldNames.has(f.name)).map((f) => f.label ?? f.name);
    const changedFieldNames = entity.fields
      .filter((f) => {
        const inCheckpointField = checkpointFieldsByName.get(f.name);
        return inCheckpointField !== undefined && fieldSignature(f) !== fieldSignature(inCheckpointField);
      })
      .map((f) => f.label ?? f.name);
    if (removedFieldNames.length > 0 || addedFieldNames.length > 0 || changedFieldNames.length > 0) {
      changedEntities.push({ name: entity.name, label: entity.label ?? entity.name, removedFieldNames, addedFieldNames, changedFieldNames });
    }
  }

  for (const entity of checkpointSpec.entities) {
    if (!currentEntities.has(entity.name)) {
      addedEntities.push({ name: entity.name, label: entity.label ?? entity.name });
    }
  }

  return { removedEntities, addedEntities, changedEntities };
}

/**
 * Whether a checkpoint's own entities/fields are exactly what the app is
 * showing right now -- not just "restoring it wouldn't remove anything"
 * (computeCheckpointDiff's own, one-directional question), but "you are
 * already looking at this". After a restore to an OLDER checkpoint, the
 * list's own newest-first order no longer lines up with which entry is
 * actually current -- the most-recently-created checkpoint at the top can
 * be stale once you've gone back to an earlier one, with nothing in the
 * list itself saying so. Compared as sets of entity/field names plus each
 * shared field's own fieldSignature (matching computeCheckpointDiff's own
 * scope) rather than full JSON equality, since array order is never
 * meaningful here and isn't guaranteed stable -- but a same-named field
 * that changed type/enum/relation between the two specs is a real
 * structural difference, not "still current", so name-matching alone is
 * deliberately not enough here either.
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
    const currentFieldsByName = new Map(entity.fields.map((f) => [f.name, f]));
    const checkpointFieldsByName = new Map(inCheckpoint.fields.map((f) => [f.name, f]));
    if (currentFieldsByName.size !== checkpointFieldsByName.size) return false;
    for (const [fieldName, field] of currentFieldsByName) {
      const inCheckpointField = checkpointFieldsByName.get(fieldName);
      if (!inCheckpointField) return false;
      if (fieldSignature(field) !== fieldSignature(inCheckpointField)) return false;
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
 * A checkpoint's `kind` is set once, at creation (pipeline.ts), from the
 * pipeline's own unambiguous knowledge of whether it came from /build or
 * /refine -- it used to be re-derived here from the checkpoint's own label
 * via startsWith("Refine:")/startsWith("שיפור:"), but CheckpointLabelEditor
 * lets a user freely rename any checkpoint's label to arbitrary text (its
 * own advertised use case: "give an important one a name that's actually
 * memorable"), which silently reclassified a renamed refine as a "build"
 * (or vice versa, by coincidence) the moment its label no longer matched
 * either prefix. Reading the persisted field instead means a rename can
 * never again change what HistoryPanel's build/refine filter thinks this
 * checkpoint is.
 */
export function getCheckpointType(checkpoint: Checkpoint): CheckpointType {
  return checkpoint.kind;
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
