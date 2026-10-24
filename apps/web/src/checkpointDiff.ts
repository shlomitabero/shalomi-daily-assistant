import type { Checkpoint, Entity, Field, ProductSpec } from "@forge/shared";
import { safeDownloadName } from "./api.js";
import type { Lang } from "./i18n/language.js";

const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

export interface CheckpointDiff {
  removedEntities: { name: string; label: string }[];
  addedEntities: { name: string; label: string }[];
  changedEntities: {
    name: string;
    label: string;
    removedFieldNames: string[];
    addedFieldNames: string[];
    changedFieldNames: string[];
    descriptionChanged: boolean;
  }[];
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
 *
 * `required` is included for the same reason: it's a real behavioral
 * property (repository.ts's coerceValue rejects a missing value once a
 * field is required), not cosmetic like `label`. pipeline.ts's own
 * computeImpact already tracks a field becoming required as a
 * "tightened" structural change worth a build-time warning -- this just
 * folds the identical property into the equality check this file's two
 * callers (computeCheckpointDiff, isCheckpointCurrent) already use, so a
 * checkpoint that only differs by a field's required flag is correctly
 * reported as changed / not current, in either direction (loosened or
 * tightened), rather than silently read as "the same field, unchanged".
 */
function fieldSignature(f: Field): string {
  // Declared order, not sorted -- groupByField (entityFormatting.ts) renders
  // Kanban board columns in exactly this declared order (its own doc comment:
  // "in the enum's own declared order, not first-seen order"), and the record
  // form's <select> (EntityPanel.tsx) renders <option>s in the same order, so
  // a refine that only reorders enumValues -- same values, same labels, same
  // required flag -- visibly reorders every rendered instance of this enum
  // field. Sorting here (as an earlier version of this line did) made that
  // reorder invisible to both of this function's callers, the same miss this
  // file already fixed twice for enumLabels and description.
  const enumPart = f.type === "enum" ? (f.enumValues ?? []).join(",") : "";
  // Real, pervasively user-rendered content -- the displayed text in table
  // cells, Kanban board columns, form <select> options, automation rule
  // conditions, calendar exports, and grouping/sort/search matching all
  // read enumLabels, not the raw enumValue (entityFormatting.ts, calendarIcs.ts,
  // AutomationsPanel.tsx). Not cosmetic like `label` (excluded deliberately,
  // see this function's own doc comment above) -- a refine that only
  // re-labels an enum's existing options, leaving enumValues/type/required
  // untouched, used to be invisible here. Stringified as sorted
  // "rawValue:displayLabel" pairs so key order never produces a spurious
  // diff; undefined and {} are deliberately the same signature (both mean
  // "no overrides, raw values shown as-is").
  const enumLabelsPart =
    f.type === "enum"
      ? Object.entries(f.enumLabels ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([value, label]) => `${value}:${label}`)
          .join(",")
      : "";
  const relationPart = f.type === "relation" ? (f.relationTo ?? "") : "";
  return `${f.type}|${relationPart}|${enumPart}|${enumLabelsPart}|${f.required ? "required" : "optional"}`;
}

/**
 * A field's display label is never enforced unique (only its name is --
 * see entityFormatting.ts's/pipeline.ts's own identical comment on this),
 * so two fields on the same entity can legally share a label via the
 * Field Label editor. Without this, a field reported here by label alone
 * (removed/added/changed) could be confused with a different, still-live
 * sibling field sharing the identical label -- e.g. restoring an older
 * checkpoint that dropped only one of two fields both labeled "Amount"
 * would read as "Amount" disappearing entirely, even though the other
 * "Amount" field is untouched. Mirrors (rather than imports, matching
 * this codebase's established per-surface convention)
 * entityFormatting.ts's identical fieldLabelOccurrences/fieldDisplayLabel
 * pair.
 */
function fieldLabelOccurrences(fields: Field[]): Map<string, number> {
  const occurrences = new Map<string, number>();
  for (const f of fields) {
    const label = f.label ?? f.name;
    occurrences.set(label, (occurrences.get(label) ?? 0) + 1);
  }
  return occurrences;
}

function fieldDisplayLabel(field: Field, occurrences: Map<string, number>): string {
  const label = field.label ?? field.name;
  return (occurrences.get(label) ?? 0) > 1 ? `${label} (${field.name})` : label;
}

/**
 * The entity-level twin of fieldLabelOccurrences/fieldDisplayLabel above --
 * an entity's own display label is just as unenforced-unique as a field's
 * (routes/projects.ts's PATCH /entities/:entityName/label route accepts
 * any non-empty string, no collision check against sibling entities'
 * labels), so two different entities can legally share a label via the
 * Entity Label editor. Without this, HistoryPanel's rendering of this
 * diff's removed/added/changed entity lists (which reads `label` alone)
 * could be confused with a different, still-live entity sharing the
 * identical label -- mirrors (rather than imports, matching this
 * codebase's established per-surface convention) pipeline.ts's identical
 * entityLabelOccurrences/entityDisplayLabel pair.
 */
function entityLabelOccurrences(entities: Entity[]): Map<string, number> {
  const occurrences = new Map<string, number>();
  for (const e of entities) {
    const label = e.label ?? e.name;
    occurrences.set(label, (occurrences.get(label) ?? 0) + 1);
  }
  return occurrences;
}

function entityDisplayLabel(entity: Entity, occurrences: Map<string, number>): string {
  const label = entity.label ?? entity.name;
  return (occurrences.get(label) ?? 0) > 1 ? `${label} (${entity.name})` : label;
}

/**
 * Round 927: a checkpoint's own label is just as unenforced-unique as an
 * entity's or field's (RenameCheckpointSchema in routes/projects.ts
 * accepts any non-empty string, no collision check against sibling
 * checkpoints), so two checkpoints in the same project can legally end up
 * sharing a label via CheckpointLabelEditor. Without this,
 * HistoryPanel.tsx's own "Compare with" dropdown and its "Comparing to: X"
 * header both rendered a raw label with nothing to tell two same-labeled
 * checkpoints apart -- picking either option looked identical, with no
 * way to verify which checkpoint was actually chosen. Mirrors
 * entityLabelOccurrences/entityDisplayLabel and fieldLabelOccurrences/
 * fieldDisplayLabel above exactly, using each checkpoint's own createdAt
 * (already what the main checkpoint list shows directly under its label)
 * as the disambiguator rather than an id, which would mean nothing to a
 * real user.
 */
export function checkpointLabelOccurrences(checkpoints: Checkpoint[]): Map<string, number> {
  const occurrences = new Map<string, number>();
  for (const c of checkpoints) {
    occurrences.set(c.label, (occurrences.get(c.label) ?? 0) + 1);
  }
  return occurrences;
}

export function checkpointDisplayLabel(checkpoint: Checkpoint, occurrences: Map<string, number>, lang: Lang): string {
  return (occurrences.get(checkpoint.label) ?? 0) > 1
    ? `${checkpoint.label} (${new Date(checkpoint.createdAt).toLocaleString(LOCALE[lang])})`
    : checkpoint.label;
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
  // Round 954: the entity-level counterpart of round 946's own
  // lowercased-fallback fix just below for FIELD names in this exact
  // function -- an entity renamed only by letter case (e.g. "Customer" ->
  // "customer" via refine) is, same as a field, a true no-op per
  // migrate.ts's own hardening (rounds 617-620): the same physical SQLite
  // table, same data, nothing actually migrated. Without this fallback,
  // the exact-string lookups below missed that case-only rename in BOTH
  // directions at once -- this one entity was reported as simultaneously
  // removed ("customer") AND added ("Customer") in the same diff, the
  // identical contradictory message round 946 already fixed one level
  // down (fields), just never extended to entities in this same file.
  const checkpointEntitiesByLowerName = new Map(checkpointSpec.entities.map((e) => [e.name.toLowerCase(), e]));
  const currentEntityNamesLower = new Set(currentSpec.entities.map((e) => e.name.toLowerCase()));
  // Counted over every entity that exists on EITHER side (deduped by name),
  // mirroring the identical field-level domain choice below -- see this
  // function's own doc comment for why.
  // Round 954: keyed by LOWERCASE name (not exact name) so a case-only
  // rename -- e.g. "customer" in the checkpoint vs "Customer" in current --
  // is counted as the SAME entity here too, not two separate ones. Without
  // this, entityLabelOccurrences saw two distinct map entries sharing one
  // label and wrongly appended a "(Customer)" disambiguation suffix to a
  // label that, for a true case-only rename, isn't actually ambiguous at
  // all. Current's own definition wins (its loop runs second), matching
  // this same function's established "current's definition wins for an
  // item present on both sides" convention used elsewhere below.
  const allEntitiesByName = new Map<string, Entity>();
  for (const e of checkpointSpec.entities) allEntitiesByName.set(e.name.toLowerCase(), e);
  for (const e of currentSpec.entities) allEntitiesByName.set(e.name.toLowerCase(), e);
  const entityLabels = entityLabelOccurrences(Array.from(allEntitiesByName.values()));
  const removedEntities: { name: string; label: string }[] = [];
  const addedEntities: { name: string; label: string }[] = [];
  const changedEntities: {
    name: string;
    label: string;
    removedFieldNames: string[];
    addedFieldNames: string[];
    changedFieldNames: string[];
    descriptionChanged: boolean;
  }[] = [];

  for (const entity of currentSpec.entities) {
    const inCheckpoint = checkpointEntities.get(entity.name) ?? checkpointEntitiesByLowerName.get(entity.name.toLowerCase());
    if (!inCheckpoint) {
      removedEntities.push({ name: entity.name, label: entityDisplayLabel(entity, entityLabels) });
      continue;
    }
    const checkpointFieldsByName = new Map(inCheckpoint.fields.map((f) => [f.name, f]));
    // Round 946: a case-only field rename (e.g. "email" -> "Email" via
    // refine) is, per migrate.ts's own hardening across rounds 617-620, a
    // true no-op -- the same physical SQLite column, same data, nothing
    // actually migrated. Without this lowercased fallback (mirroring
    // migrate.ts's identical prevFieldsByName.get(name) ?? prevFieldByLowerName
    // convention), the exact-string lookup below misses in BOTH directions
    // at once -- checkpointFieldsByName has no "Email" entry (it's keyed by
    // the checkpoint's own differently-cased "email"), and currentFieldNames
    // has no "email" entry (it's keyed by the current spec's "Email") -- so
    // this one field was reported as simultaneously removed ("Email") AND
    // added ("email") in the same diff, a flatly contradictory message for
    // a change that doesn't actually lose or gain anything.
    const checkpointFieldsByLowerName = new Map(inCheckpoint.fields.map((f) => [f.name.toLowerCase(), f]));
    const currentFieldNames = new Set(entity.fields.map((f) => f.name));
    const currentFieldNamesLower = new Set(entity.fields.map((f) => f.name.toLowerCase()));
    // Counted over every field that exists on EITHER side (deduped by name,
    // the current spec's definition winning for a field present on both),
    // not just whichever of removed/added/changed list a field lands in --
    // see this function's own doc comment above for why.
    const allFieldsByName = new Map<string, Field>();
    for (const f of inCheckpoint.fields) allFieldsByName.set(f.name, f);
    for (const f of entity.fields) allFieldsByName.set(f.name, f);
    const labelOccurrences = fieldLabelOccurrences(Array.from(allFieldsByName.values()));
    const removedFieldNames = entity.fields
      .filter((f) => !checkpointFieldsByName.has(f.name) && !checkpointFieldsByLowerName.has(f.name.toLowerCase()))
      .map((f) => fieldDisplayLabel(f, labelOccurrences));
    const addedFieldNames = inCheckpoint.fields
      .filter((f) => !currentFieldNames.has(f.name) && !currentFieldNamesLower.has(f.name.toLowerCase()))
      .map((f) => fieldDisplayLabel(f, labelOccurrences));
    const changedFieldNames = entity.fields
      .filter((f) => {
        const inCheckpointField = checkpointFieldsByName.get(f.name) ?? checkpointFieldsByLowerName.get(f.name.toLowerCase());
        return inCheckpointField !== undefined && fieldSignature(f) !== fieldSignature(inCheckpointField);
      })
      .map((f) => fieldDisplayLabel(f, labelOccurrences));
    // Real, user-rendered content (EntityPanel.tsx: {entity.description &&
    // <p className="muted">{entity.description}</p>}, shown above every
    // entity's own table/form) -- not cosmetic like label (see
    // entityLabelOccurrences' own doc comment above for why label is never
    // compared here). A refine that only rewords an entity's description,
    // leaving every field untouched, used to be invisible to this diff
    // entirely.
    const descriptionChanged = (entity.description ?? "") !== (inCheckpoint.description ?? "");
    if (removedFieldNames.length > 0 || addedFieldNames.length > 0 || changedFieldNames.length > 0 || descriptionChanged) {
      changedEntities.push({
        name: entity.name,
        label: entityDisplayLabel(entity, entityLabels),
        removedFieldNames,
        addedFieldNames,
        changedFieldNames,
        descriptionChanged,
      });
    }
  }

  for (const entity of checkpointSpec.entities) {
    if (!currentEntities.has(entity.name) && !currentEntityNamesLower.has(entity.name.toLowerCase())) {
      addedEntities.push({ name: entity.name, label: entityDisplayLabel(entity, entityLabels) });
    }
  }

  return { removedEntities, addedEntities, changedEntities };
}

/**
 * Whether a checkpoint's own spec is exactly what the app is showing
 * right now -- not just "restoring it wouldn't remove anything"
 * (computeCheckpointDiff's own, one-directional question), but "you are
 * already looking at this". After a restore to an OLDER checkpoint, the
 * list's own newest-first order no longer lines up with which entry is
 * actually current -- the most-recently-created checkpoint at the top can
 * be stale once you've gone back to an earlier one, with nothing in the
 * list itself saying so.
 *
 * The restore route (apps/api/src/routes/projects.ts) replaces a
 * project's ENTIRE spec with the checkpoint's, not just its
 * entities/fields -- so a checkpoint whose entities/fields match the
 * live spec byte-for-byte can still genuinely differ from it in
 * summary/roles/screens/assumptions/personas/openQuestions (e.g. a
 * refine step that only reworded the summary or renamed a role, leaving
 * every entity untouched). Comparing entities/fields alone used to mark
 * that checkpoint "Current" and permanently disable its own Restore
 * button, even though the live app's summary/role chips visibly differ
 * from it -- the opposite of what the doc comment above already promised.
 * summary/roles/personas/screens/assumptions/openQuestions have no
 * drag-reorder feature anywhere in the UI, so their stored array order
 * IS their display order and a plain JSON comparison is correct for
 * them; only entities/fields get the order-insensitive, signature-based
 * comparison below, since array order is never meaningful there and
 * isn't guaranteed stable -- but a same-named field that changed
 * type/enum/relation between the two specs is a real structural
 * difference, not "still current", so name-matching alone is
 * deliberately not enough even there.
 */
export function isCheckpointCurrent(currentSpec: ProductSpec, checkpointSpec: ProductSpec): boolean {
  if (currentSpec.summary !== checkpointSpec.summary) return false;
  if (JSON.stringify(currentSpec.roles) !== JSON.stringify(checkpointSpec.roles)) return false;
  if (JSON.stringify(currentSpec.personas) !== JSON.stringify(checkpointSpec.personas)) return false;
  if (JSON.stringify(currentSpec.screens) !== JSON.stringify(checkpointSpec.screens)) return false;
  if (JSON.stringify(currentSpec.assumptions) !== JSON.stringify(checkpointSpec.assumptions)) return false;
  if (JSON.stringify(currentSpec.openQuestions) !== JSON.stringify(checkpointSpec.openQuestions)) return false;

  // Round 954: unlike computeCheckpointDiff above, an entity renamed only
  // by letter case does NOT need a lowercased fallback here -- this
  // exact-string containment check already returns false for it
  // (checkpointNames is keyed by the checkpoint's own casing, so it
  // genuinely doesn't contain the current spec's differently-cased name),
  // which is the CORRECT outcome for this function's own stricter "is
  // this EXACTLY what's on screen right now" question: with no explicit
  // label override, the entity's own rendered name text really does
  // differ by case between the two specs, so restoring would genuinely
  // change what's on screen. Mirrors the identical, already-established
  // reasoning for FIELD-name matching a few lines below.
  const currentNames = new Set(currentSpec.entities.map((e) => e.name));
  const checkpointNames = new Set(checkpointSpec.entities.map((e) => e.name));
  if (currentNames.size !== checkpointNames.size) return false;
  for (const name of currentNames) {
    if (!checkpointNames.has(name)) return false;
  }

  const checkpointEntities = new Map(checkpointSpec.entities.map((e) => [e.name, e]));
  for (const entity of currentSpec.entities) {
    const inCheckpoint = checkpointEntities.get(entity.name)!;
    // Real, user-rendered content (see computeCheckpointDiff's own
    // descriptionChanged comment above) -- a checkpoint whose entities/
    // fields match byte-for-byte but whose description text differs used
    // to be wrongly reported "Current", the same category of gap this
    // function's own doc comment already describes for summary/roles/etc.
    if ((entity.description ?? "") !== (inCheckpoint.description ?? "")) return false;
    // Round 874: the identical gap, for an entity's own display label.
    // fieldSignature deliberately excludes a FIELD's label (see its own
    // doc comment above) for computeCheckpointDiff's narrower "is this a
    // structural change worth flagging" question -- but isCheckpointCurrent
    // asks a stricter one, "is this EXACTLY what's on screen right now",
    // the same reasoning the description check just above already applies.
    // An entity/field label rename (routes/projects.ts's PATCH
    // .../entities/:entityName/label and .../fields/:fieldName/label) does
    // a direct updateProjectSpec write with no new checkpoint ever
    // inserted (checkpoints only come from pipeline.ts's build/refine
    // flow), so every pre-existing checkpoint still carries the old label
    // while the live spec now shows the new one -- restoring that
    // checkpoint would genuinely change the rendered label back, yet
    // nothing here caught it, wrongly marking the checkpoint "Current" and
    // permanently disabling the one action (Restore) that would actually
    // undo the rename.
    if ((entity.label ?? entity.name) !== (inCheckpoint.label ?? inCheckpoint.name)) return false;
    const currentFieldsByName = new Map(entity.fields.map((f) => [f.name, f]));
    const checkpointFieldsByName = new Map(inCheckpoint.fields.map((f) => [f.name, f]));
    if (currentFieldsByName.size !== checkpointFieldsByName.size) return false;
    for (const [fieldName, field] of currentFieldsByName) {
      const inCheckpointField = checkpointFieldsByName.get(fieldName);
      if (!inCheckpointField) return false;
      if (fieldSignature(field) !== fieldSignature(inCheckpointField)) return false;
      // Same reasoning as the entity label check just above, one level down.
      if ((field.label ?? field.name) !== (inCheckpointField.label ?? inCheckpointField.name)) return false;
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
    // count must read spec.screens, not spec.entities -- see HistoryPanel.tsx's
    // own identical fix for why entities.length under-reports the real count.
    lines.push(`${time} — ${t("history.screenCount", { count: checkpoint.spec.screens.length })}`);
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
  lang: Lang,
): string {
  if (compareTargetId == null) return t("history.diff.currentState");
  const target = checkpoints.find((c) => c.id === compareTargetId);
  if (!target) return t("history.diff.currentState");
  return checkpointDisplayLabel(target, checkpointLabelOccurrences(checkpoints), lang);
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
