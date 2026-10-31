import type { Entity, EntityRecord, Project } from "@forge/shared";
import { getRecord, listRecords, type ForgeDatabase } from "@forge/db";
import { isHebrewText } from "@forge/spec-engine";
import { pickDisplayField, recordDisplayLabel } from "./displayField.js";

/**
 * The "Business Twin" — a real, honest first version of the vision's
 * larger idea (section 58 of the founding spec, and the product-feedback
 * follow-up). It does NOT claim to understand your business strategy; it
 * reports genuine facts derived from your live data (record counts per
 * entity) and a small number of observations that follow directly from
 * those counts. No fabricated insight, no simulated personas — that's
 * future work, not pretended here.
 */
export interface BusinessTwinEntityStat {
  name: string;
  label: string;
  count: number;
}

export interface BusinessTwin {
  summary: string;
  roles: string[];
  entities: BusinessTwinEntityStat[];
  totalRecords: number;
  mostActive: BusinessTwinEntityStat | null;
  unused: BusinessTwinEntityStat[];
  observations: string[];
  /**
   * The "most-linked record" insight, kept separate from the plain-text
   * `observations` array because -- unlike every other observation here --
   * it names one specific real record (an actual entityName+id, already
   * resolved by computeRelationHubObservation below), so the client can
   * jump straight to it instead of just stating the fact in prose.
   */
  mostLinkedRecord: { text: string; entityName: string; recordId: number } | null;
  /**
   * The "most active entity" insight, the direct sibling of
   * mostLinkedRecord above -- this fact was previously only ever pushed
   * into the plain-text `observations` array as inert prose, the exact
   * same "can't jump to it" gap round 174/175/176 already closed for
   * Global Search, WhatsApp, and mostLinkedRecord itself. Kept separate
   * from `observations` (never duplicated into it) for the same reason:
   * it names a real, jumpable entity (mostActive.name), not just a fact.
   */
  mostActiveObservation: { text: string; entityName: string } | null;
  /**
   * Relation-coverage and duplicate-detection facts (computeRelationCoverageObservations/
   * computeDuplicateObservations below) each name one specific real entity --
   * the exact same "can't jump to it" gap round 174/175/176/212 already
   * closed for Global Search, WhatsApp, mostLinkedRecord, and
   * mostActiveObservation. Kept separate from `observations` (never
   * duplicated into it) for the same reason. Unlike mostActive/
   * mostLinkedRecord (each singular), a project can have several of these
   * at once, so this is an array rather than a single nullable value.
   */
  jumpableObservations: { text: string; entityName: string }[];
  /**
   * The same per-value counts computeEnumDistributionObservations already
   * computes (see its own `countByValue`/`breakdown` locals) to build its
   * prose `text` -- surfaced here too, structured, so the dashboard view
   * can render a real bar chart instead of re-parsing a sentence. Every
   * entry here already has a matching prose sentence in
   * jumpableObservations; this is additive, not a replacement.
   */
  distributions: {
    text: string;
    entityName: string;
    entityLabel: string;
    fieldName: string;
    fieldLabel: string;
    breakdown: { value: string; label: string; count: number }[];
  }[];
  /** The structured sibling of computeNumericAggregateObservations' prose, for the same reason as `distributions` above. */
  numericStats: {
    text: string;
    entityName: string;
    entityLabel: string;
    fieldName: string;
    fieldLabel: string;
    sum: number;
    average: number;
    recordCount: number;
  }[];
  /**
   * Round 1329: the structured sibling of computeOverdueObservations'/
   * computeDueSoonObservations' own prose, for the same reason as
   * `distributions`/`numericStats` above -- both functions already
   * compute this exact shape internally to build their sentence, but
   * before this round it was discarded the moment it was folded into the
   * flat `jumpableObservations` array, so the Dashboard view (which only
   * ever rendered `distributions`/`numericStats`) had no tile for
   * overdue/due-soon deadlines at all, even though the fact itself was
   * already computed on every request and shown as a bullet in the
   * Report view. Each entry here already has a matching prose sentence
   * in jumpableObservations; this is additive, not a replacement.
   */
  overdueStats: {
    text: string;
    entityName: string;
    entityLabel: string;
    fieldName: string;
    fieldLabel: string;
    overdueCount: number;
    recordCount: number;
  }[];
  dueSoonStats: {
    text: string;
    entityName: string;
    entityLabel: string;
    fieldName: string;
    fieldLabel: string;
    dueSoonCount: number;
    recordCount: number;
  }[];
}

/**
 * The entity-level twin of the field-label-collision guard every observation
 * below already carries for FIELD labels (each builds its own local
 * `labelOccurrences` map) -- mirroring checkpointDiff.ts's/pipeline.ts's own
 * identical `entityLabelOccurrences`/`entityDisplayLabel` pair. An entity's
 * own display label is just as unenforced-unique as a field's: the Entity
 * Label editor and its PATCH /entities/:entityName/label route (see
 * routes/projects.ts) accept any non-empty string with no collision check
 * against sibling entities, so two different entities can legally share a
 * label. Computed once per computeBusinessTwin call, over this project's
 * current live entity list -- unlike pipeline.ts's refine-impact version,
 * the Business Twin never compares two specs, so there's no previous-vs-next
 * union to build here.
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
 * Reports how well a relation field is actually being used -- e.g. "3 of 5
 * tickets have no customer linked" -- for any entity that has one, not
 * special-cased to a particular entity/field name. This is exactly the
 * same "genuine fact derived from live data" principle as the rest of the
 * Business Twin: it never guesses *why* a relation is unset, just surfaces
 * the honest count so a real person can decide whether that's expected.
 */
function computeRelationCoverageObservations(
  recordsByEntity: Map<string, EntityRecord[]>,
  project: Project,
  hebrew: boolean,
  entityLabels: Map<string, number>,
): { text: string; entityName: string }[] {
  const observations: { text: string; entityName: string }[] = [];
  for (const entity of project.spec.entities) {
    const relationFields = entity.fields.filter((f) => f.type === "relation");
    if (relationFields.length === 0) continue;
    const records = recordsByEntity.get(entity.name) ?? [];
    if (records.length === 0) continue;

    // FieldLabelEditor/the field-label route enforce no uniqueness on a
    // field's display label (only `name` is unique per entity -- see
    // EntitySchema in packages/shared), so two relation fields here can
    // legitimately share a label. Disambiguated with the field's own
    // (always-unique) name, the same fix computeRelationHubObservation
    // below already applies when a source label repeats within one
    // breakdown.
    const labelOccurrences = new Map<string, number>();
    for (const field of relationFields) {
      const label = field.label ?? field.name;
      labelOccurrences.set(label, (labelOccurrences.get(label) ?? 0) + 1);
    }

    for (const field of relationFields) {
      const unassigned = records.filter((r) => r[field.name] === null || r[field.name] === undefined).length;
      if (unassigned === 0) continue;
      const entityLabel = entityDisplayLabel(entity, entityLabels);
      const fieldLabel = field.label ?? field.name;
      const ambiguous = (labelOccurrences.get(fieldLabel) ?? 0) > 1;
      observations.push({
        text: hebrew
          ? `ב"${entityLabel}", ל-${unassigned} מתוך ${records.length} רשומות אין "${fieldLabel}"${ambiguous ? ` (${field.name})` : ""} מוגדר.`
          : `In "${entityLabel}", ${unassigned} of ${records.length} records have no "${fieldLabel}"${ambiguous ? ` (${field.name})` : ""} set.`,
        entityName: entity.name,
      });
    }
  }
  return observations;
}

/**
 * Mirrors entityFormatting.ts's/backup.ts's/calendarFeed.ts's own identical
 * parseFileFieldValue/fileFieldDisplayName check -- a `file` field's stored
 * value is a JSON-encoded `{url, name, size, mimeType}` descriptor, not a
 * plain string like every other field type, so a missing upload can be
 * `null`/`undefined` (never answered) OR a non-empty string that fails to
 * parse as a real descriptor (never a reachable case through this app's own
 * upload route, but still "no real file" the same way this codebase's other
 * three copies of this check already treat it).
 */
function hasRealFileValue(value: unknown): boolean {
  if (typeof value !== "string" || value === "") return false;
  try {
    const parsed = JSON.parse(value) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.length > 0;
  } catch {
    return false;
  }
}

/**
 * Round 1249: the exact "file" twin of computeRelationCoverageObservations
 * just above -- a `file` field (e.g. a resume, ID photo, invoice, contract
 * scan; see anthropic.ts's own system-prompt wording for when `type:
 * "file"` gets used) is exactly as business-meaningful to report coverage
 * for as a relation field is ("3 of 10 Claims have no receipt uploaded" is
 * the same genuine, actionable, no-fabricated-insight fact as "3 of 5
 * tickets have no customer linked"), but this file had zero `file`-type
 * awareness anywhere in it before this round (confirmed via
 * `grep -n '"file"' twin.ts` returning no hits) despite every sibling
 * surface in this codebase (entityFormatting.ts, backup.ts, repository.ts,
 * seed.ts, calendarFeed.ts) already having a dedicated `file` branch.
 */
function computeFileFieldCoverageObservations(
  recordsByEntity: Map<string, EntityRecord[]>,
  project: Project,
  hebrew: boolean,
  entityLabels: Map<string, number>,
): { text: string; entityName: string }[] {
  const observations: { text: string; entityName: string }[] = [];
  for (const entity of project.spec.entities) {
    const fileFields = entity.fields.filter((f) => f.type === "file");
    if (fileFields.length === 0) continue;
    const records = recordsByEntity.get(entity.name) ?? [];
    if (records.length === 0) continue;

    // Mirrors computeRelationCoverageObservations's own labelOccurrences
    // disambiguation exactly -- FieldSchema/the field-label route enforce
    // no uniqueness on a field's display label, so two file fields here
    // can legitimately share one.
    const labelOccurrences = new Map<string, number>();
    for (const field of fileFields) {
      const label = field.label ?? field.name;
      labelOccurrences.set(label, (labelOccurrences.get(label) ?? 0) + 1);
    }

    for (const field of fileFields) {
      const missing = records.filter((r) => !hasRealFileValue(r[field.name])).length;
      if (missing === 0) continue;
      const entityLabel = entityDisplayLabel(entity, entityLabels);
      const fieldLabel = field.label ?? field.name;
      const ambiguous = (labelOccurrences.get(fieldLabel) ?? 0) > 1;
      observations.push({
        text: hebrew
          ? `ב"${entityLabel}", ל-${missing} מתוך ${records.length} רשומות אין "${fieldLabel}"${ambiguous ? ` (${field.name})` : ""} מועלה.`
          : `In "${entityLabel}", ${missing} of ${records.length} records have no "${fieldLabel}"${ambiguous ? ` (${field.name})` : ""} uploaded.`,
        entityName: entity.name,
      });
    }
  }
  return observations;
}

/**
 * Finds the single record that's referenced the most across every relation
 * field in the project that points to it -- e.g. "Dana Levi" being both a
 * customer on 2 orders and 1 support ticket -- and reports it as one
 * observation, honestly: a real cross-entity count, never a guess at why
 * that record is popular. Only reported when a record is referenced more
 * than once; a single reference isn't a pattern worth surfacing.
 */
function computeRelationHubObservation(
  db: ForgeDatabase,
  recordsByEntity: Map<string, EntityRecord[]>,
  project: Project,
  hebrew: boolean,
  entityLabels: Map<string, number>,
): { text: string; entityName: string; recordId: number } | null {
  const entities = project.spec.entities;
  // targetEntityName -> targetRecordId -> [{ sourceLabel, fieldLabel, count }]
  const breakdownByTarget = new Map<string, Map<number, { sourceLabel: string; fieldLabel: string; count: number }[]>>();

  for (const sourceEntity of entities) {
    // Round 1160: case-insensitive, mirroring migrate.ts's own round-1159
    // fix -- without it, a relationTo differing from its target entity's
    // name only by letter case was silently excluded from this observation
    // entirely (filtered out here, so it never reached the non-null find
    // below either).
    const relationFields = sourceEntity.fields.filter(
      (f) => f.type === "relation" && f.relationTo && entities.some((e) => e.name.toLowerCase() === f.relationTo!.toLowerCase()),
    );
    if (relationFields.length === 0) continue;
    const sourceRecords = recordsByEntity.get(sourceEntity.name) ?? [];
    if (sourceRecords.length === 0) continue;

    for (const field of relationFields) {
      const countsById = new Map<number, number>();
      for (const record of sourceRecords) {
        const raw = record[field.name];
        if (raw === null || raw === undefined) continue;
        const id = Number(raw);
        countsById.set(id, (countsById.get(id) ?? 0) + 1);
      }
      if (countsById.size === 0) continue;

      // Resolved to the entity's own real, canonical name (not the
      // possibly-differently-cased relationTo string itself) -- the
      // relationFields filter above only lets a field through once it's
      // confirmed to resolve case-insensitively, so this find is safe, and
      // every downstream exact-case entities.find(...)! (below) keeps
      // working against a targetName that's always a real entity name.
      const targetName = entities.find((e) => e.name.toLowerCase() === field.relationTo!.toLowerCase())!.name;
      if (!breakdownByTarget.has(targetName)) breakdownByTarget.set(targetName, new Map());
      const perId = breakdownByTarget.get(targetName)!;
      for (const [id, count] of countsById) {
        const entry = { sourceLabel: entityDisplayLabel(sourceEntity, entityLabels), fieldLabel: field.label ?? field.name, count };
        perId.set(id, [...(perId.get(id) ?? []), entry]);
      }
    }
  }

  // Ranked candidates, not just the single top one: a real getRecord lookup
  // confirms the top-total id still resolves to an actual row before it's
  // reported, falling through to the next real candidate otherwise. Today,
  // FK constraints (see migrate.ts) and additive-only migrations mean a
  // dangling id can't actually happen through this app's own code paths --
  // this is cheap insurance against a future path (or a bug elsewhere)
  // producing one anyway, so a stale reference drops just that one
  // candidate rather than the whole insight.
  const candidates: { targetName: string; id: number; total: number }[] = [];
  for (const [targetName, perId] of breakdownByTarget) {
    for (const [id, breakdown] of perId) {
      const total = breakdown.reduce((sum, b) => sum + b.count, 0);
      if (total > 1) candidates.push({ targetName, id, total });
    }
  }
  candidates.sort((a, b) => b.total - a.total);

  let best: { targetName: string; id: number; total: number } | null = null;
  let targetEntity: Entity | null = null;
  let targetRecord: EntityRecord | undefined;
  for (const candidate of candidates) {
    const entity = entities.find((e) => e.name === candidate.targetName)!;
    const record = getRecord(db, project.id, entity, candidate.id);
    if (record) {
      best = candidate;
      targetEntity = entity;
      targetRecord = record;
      break;
    }
  }
  if (!best || !targetEntity || !targetRecord) return null;

  const breakdown = breakdownByTarget.get(best.targetName)!.get(best.id)!;
  // Two entries can share the same sourceLabel when one entity has two
  // different relation fields both pointing at the same target entity
  // (e.g. Deal.customerId and Deal.referredBy both -> Customer) -- without
  // naming the field, those lines would read as identical-looking
  // duplicates ('3 in "Deals", 2 in "Deals"') with no way to tell them
  // apart, even though fieldLabel distinguishes them.
  const sourceLabelOccurrences = new Map<string, number>();
  for (const b of breakdown) {
    sourceLabelOccurrences.set(b.sourceLabel, (sourceLabelOccurrences.get(b.sourceLabel) ?? 0) + 1);
  }
  const breakdownText = breakdown
    .map((b) => {
      const ambiguous = (sourceLabelOccurrences.get(b.sourceLabel) ?? 0) > 1;
      if (hebrew) {
        return ambiguous ? `${b.count} ב"${b.sourceLabel}" (${b.fieldLabel})` : `${b.count} ב"${b.sourceLabel}"`;
      }
      return ambiguous ? `${b.count} in "${b.sourceLabel}" (via ${b.fieldLabel})` : `${b.count} in "${b.sourceLabel}"`;
    })
    .join(", ");
  const label = recordDisplayLabel(targetEntity, targetRecord, hebrew ? "he" : "en");
  const entityLabel = entityDisplayLabel(targetEntity, entityLabels);

  return {
    text: hebrew
      ? `"${label}" (${entityLabel}) הרשומה המקושרת ביותר: ${best.total} קישורים בסה"כ — ${breakdownText}.`
      : `"${label}" (${entityLabel}) is the most-linked record: ${best.total} links total — ${breakdownText}.`,
    entityName: targetEntity.name,
    recordId: best.id,
  };
}

/**
 * Flags records within the same entity that share the same display label
 * (the same field pickDisplayField/recordDisplayLabel already uses to
 * represent a record everywhere else in this app -- usually "name" or
 * "title") -- e.g. two "Customer" records both named "Dana Levi". This is
 * genuinely actionable for a real small business (a duplicate contact
 * entered twice, an accidental double-import) without ever claiming to
 * know *why* they match, same as every other Business Twin observation.
 * recordDisplayLabel falls back to a record's own unique "#<id>" when an
 * entity has no usable display field, so two records can never collide on
 * that fallback and produce a false positive there -- but pickDisplayField
 * itself falls back further, to the entity's first field of *any* type,
 * when there's no "name"/"title" hint and no text field at all. Two
 * records genuinely coincide on that kind of field all the time (e.g. two
 * unrelated shipments that both happen to weigh 5kg) without being
 * duplicates in any meaningful sense, so this only runs for an entity
 * whose picked display field is free-text -- "text" or "longtext" (the same
 * free-text kind pickDisplayField's own fallback step treats as
 * interchangeable) -- the one case where two records sharing that value
 * really does suggest the same person or thing was entered twice.
 *
 * Grouping uses a trimmed, case-folded key rather than the raw label, since
 * the exact double-import this observation targets is exactly the kind of
 * mistake that produces "Dana Levi" and "dana levi " (or "DANA LEVI") as
 * two distinct rows that are obviously the same person to a human reading
 * the list, but were previously invisible to this check because they
 * landed on two different Map keys. The group's first-seen original label
 * (not the normalized key) is what gets displayed, so casing/whitespace in
 * the observation text still matches a real record.
 */
function computeDuplicateObservations(
  recordsByEntity: Map<string, EntityRecord[]>,
  project: Project,
  hebrew: boolean,
  entityLabels: Map<string, number>,
): { text: string; entityName: string }[] {
  const observations: { text: string; entityName: string }[] = [];
  for (const entity of project.spec.entities) {
    const displayField = pickDisplayField(entity);
    if (!displayField || (displayField.type !== "text" && displayField.type !== "longtext")) continue;
    const records = recordsByEntity.get(entity.name) ?? [];
    if (records.length < 2) continue;

    const groupsByNormalizedLabel = new Map<string, { count: number; displayLabel: string }>();
    for (const record of records) {
      const label = recordDisplayLabel(entity, record, hebrew ? "he" : "en");
      const key = label.trim().toLowerCase();
      const existing = groupsByNormalizedLabel.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        groupsByNormalizedLabel.set(key, { count: 1, displayLabel: label });
      }
    }

    const entityLabel = entityDisplayLabel(entity, entityLabels);
    for (const { count, displayLabel } of groupsByNormalizedLabel.values()) {
      if (count < 2) continue;
      observations.push({
        text: hebrew
          ? `ב"${entityLabel}", ${count} רשומות חולקות את השם "${displayLabel}" — יתכן כפילות.`
          : `In "${entityLabel}", ${count} records share the name "${displayLabel}" — possibly a duplicate.`,
        entityName: entity.name,
      });
    }
  }
  return observations;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Two genuine facts read off each record's own `createdAt` (a real column
 * every table has -- see repository.ts's insertRecord -- not a guess): how
 * much data actually arrived in the last week, and which entities with
 * real records haven't seen a single new one in the last 30 days. The
 * second one is the more actionable half for a real small business -- an
 * entity that USED to get data but has clearly gone stale (a process that
 * quietly stopped, a form nobody fills out anymore) is a genuinely
 * different signal from the existing "unused" observation above, which
 * only catches an entity that never had any data at all. Each stale
 * entity gets its own jumpableObservations entry (rather than one sentence
 * naming several at once) so it's clickable straight to that entity's own
 * tab, matching every other insight in this same list -- see
 * computeBusinessTwin's own "unused" block for the identical reasoning.
 */
function computeActivityObservations(
  recordsByEntity: Map<string, EntityRecord[]>,
  project: Project,
  hebrew: boolean,
  entityLabels: Map<string, number>,
): { observations: string[]; jumpableObservations: { text: string; entityName: string }[] } {
  const observations: string[] = [];
  const jumpableObservations: { text: string; entityName: string }[] = [];
  const now = Date.now();
  let recentCount = 0;
  const staleEntities: { name: string; label: string }[] = [];

  for (const entity of project.spec.entities) {
    const records = recordsByEntity.get(entity.name) ?? [];
    if (records.length === 0) continue;

    let newestAgeMs = Infinity;
    for (const record of records) {
      const createdMs = new Date(String(record.createdAt)).getTime();
      if (Number.isNaN(createdMs)) continue;
      const ageMs = now - createdMs;
      if (ageMs <= 7 * DAY_MS) recentCount += 1;
      if (ageMs < newestAgeMs) newestAgeMs = ageMs;
    }
    if (newestAgeMs > 30 * DAY_MS) staleEntities.push({ name: entity.name, label: entityDisplayLabel(entity, entityLabels) });
  }

  if (recentCount > 0) {
    observations.push(
      hebrew ? `${recentCount} רשומות נוספו בשבוע האחרון.` : `${recentCount} record${recentCount === 1 ? "" : "s"} added in the last week.`,
    );
  }
  for (const e of staleEntities) {
    jumpableObservations.push({
      text: hebrew
        ? `לא נוספו רשומות חדשות ב-30 הימים האחרונים ב"${e.label}".`
        : `No new records added in the last 30 days in "${e.label}".`,
      entityName: e.name,
    });
  }
  return { observations, jumpableObservations };
}

/**
 * Every observation above is derived from record counts, relation fields,
 * the display field, or `createdAt` -- the Business Twin never once reads a
 * `number` field's actual value, even though most of this app's own
 * domain-library entities have one (Order.total, Payment.amount,
 * Booking.amount, Claim.claimAmount -- see domainEntities.ts): a small
 * business's most business-meaningful numbers (money, quantities) were
 * silently invisible to the one panel meant to summarize the data. A real
 * sum + average across every record with a real value for that field --
 * the same "genuine fact derived from live data, never a guess" principle
 * as every observation above -- closes that gap. Skipped entirely when no
 * record has a real numeric value for the field, the same "nothing to
 * report yet" guard computeRelationCoverageObservations and
 * computeDuplicateObservations both already use.
 */
/** Round 1090: see this file's own call-site comment below for the full rationale -- "he-IL" silently embeds an invisible U+200E before a negative number's minus sign. */
function stripBidiMarks(s: string): string {
  return s.replace(/[‎‏]/g, "");
}

function computeNumericAggregateObservations(
  recordsByEntity: Map<string, EntityRecord[]>,
  project: Project,
  hebrew: boolean,
  entityLabels: Map<string, number>,
): {
  text: string;
  entityName: string;
  entityLabel: string;
  fieldName: string;
  fieldLabel: string;
  sum: number;
  average: number;
  recordCount: number;
}[] {
  const observations: ReturnType<typeof computeNumericAggregateObservations> = [];
  for (const entity of project.spec.entities) {
    const numberFields = entity.fields.filter((f) => f.type === "number");
    if (numberFields.length === 0) continue;
    const records = recordsByEntity.get(entity.name) ?? [];
    if (records.length === 0) continue;

    const entityLabel = entityDisplayLabel(entity, entityLabels);
    // Same label-collision gap as computeRelationCoverageObservations above
    // (field labels aren't unique, only names are) -- two number fields on
    // the same entity (e.g. Order.subtotal and Order.shipping both renamed
    // to "Amount") would otherwise produce two identical-looking lines with
    // no way to tell which real field either one is about.
    const labelOccurrences = new Map<string, number>();
    for (const field of numberFields) {
      const label = field.label ?? field.name;
      labelOccurrences.set(label, (labelOccurrences.get(label) ?? 0) + 1);
    }

    for (const field of numberFields) {
      const values: number[] = [];
      for (const record of records) {
        const raw = record[field.name];
        if (raw === null || raw === undefined || raw === "") continue;
        const num = Number(raw);
        if (!Number.isNaN(num)) values.push(num);
      }
      if (values.length === 0) continue;

      const sum = values.reduce((total, v) => total + v, 0);
      const average = sum / values.length;
      const fieldLabel = field.label ?? field.name;
      const ambiguous = (labelOccurrences.get(fieldLabel) ?? 0) > 1;
      const fieldSuffix = ambiguous ? ` (${field.name})` : "";
      // Unlike every other locale-formatted number in this app (twinReport.ts/
      // searchReport.ts/checkpointDiff.ts all pass he-IL/en-US explicitly),
      // these two toLocaleString calls had no locale argument at all --
      // baked server-side into prose text (not a client render), so they
      // always used this Node process's one global default ICU locale,
      // completely decoupled from `hebrew` (the very flag this sentence's
      // own word choice already depends on) and from the viewer's actual
      // in-app language. Round 703 fixed the sibling client-side instances
      // in BusinessTwinPanel.tsx's Dashboard tab, but never looked at this
      // file -- a different workspace, a different mechanism (a formatted
      // number embedded in generated text, not a live render).
      const numberLocale = hebrew ? "he-IL" : "en-US";
      // Round 1090: "he-IL" silently embeds an invisible U+200E before a
      // negative number's minus sign (confirmed directly:
      // `(-45.666).toLocaleString("he-IL", {maximumFractionDigits:1})`
      // embeds it, the identical "en-US" call doesn't). sum/average here
      // come from a number field with no positivity constraint (a
      // profit/loss or balance field can be genuinely negative), and this
      // sentence isn't only rendered on screen -- twinReport.ts folds
      // every observation's own .text verbatim into its downloadable
      // plain-text snapshot (its own doc comment: "WhatsApp, email, paste
      // anywhere"), the same "no bidi context left once it leaves the
      // app" gap round 1089 already fixed in automations.ts.
      const sumText = stripBidiMarks(sum.toLocaleString(numberLocale));
      const averageText = stripBidiMarks(average.toLocaleString(numberLocale, { maximumFractionDigits: 1 }));
      observations.push({
        text: hebrew
          ? `סה"כ "${fieldLabel}"${fieldSuffix} ב"${entityLabel}": ${sumText} (ממוצע ${averageText} על פני ${values.length} רשומות).`
          : `Total "${fieldLabel}"${fieldSuffix} in "${entityLabel}": ${sumText} (average ${averageText} across ${values.length} records).`,
        entityName: entity.name,
        entityLabel,
        fieldName: field.name,
        // Round 1336: bakes in the same disambiguating fieldSuffix the
        // sentence above already applies -- the Dashboard view
        // (BusinessTwinPanel.tsx) renders this value directly as a chart/
        // tile title with no ambiguity check of its own, so two
        // same-labeled number fields on this entity used to show as two
        // identically-titled, indistinguishable stat tiles even though the
        // Report view's prose already told them apart.
        fieldLabel: fieldLabel + fieldSuffix,
        sum,
        average,
        recordCount: values.length,
      });
    }
  }
  return observations;
}

/**
 * The `enum` counterpart to the numeric aggregate above -- the same
 * invisible-field-type gap, for status/category fields instead of money
 * (Order.status, Ticket.status, Booking.status, and every other seeded
 * enum field in domainEntities.ts). A real per-value count, sorted by
 * count so the largest bucket -- the one most worth a second look -- reads
 * first, e.g. "18 'pending', 4 'shipped', 2 'cancelled'". Skipped when
 * every record shares the same single value: a distribution of one value
 * isn't a distribution, the same "nothing to report yet" guard the
 * duplicate/relation-coverage observations above already apply to their
 * own single-candidate case.
 *
 * Boolean fields are included alongside enum fields -- entityFormatting.ts's
 * own isGroupableField/findFilterableFields already establish, elsewhere in
 * this codebase, that a boolean's two values (true/false) are exactly the
 * same "small, fixed value space" category as an enum's for this kind of
 * per-value-count summary; a business-meaningful boolean like "Paid" or
 * "IsActive" (common in domainEntities.ts's own seeded specs) was getting
 * no distribution insight at all before this, the one field type this
 * function's own filter never widened to match that established
 * convention. A boolean field has no `enumValues`/`enumLabels` of its own,
 * so its two raw values (always real JS booleans via repository.ts's
 * coerceValue, never "true"/"false" strings) are displayed as "TRUE"/
 * "FALSE" -- the same literal, unlocalized convention this app's own
 * interpolateTemplate (WhatsApp message formatting) and entityFormatting.ts
 * (CSV export) already use for a boolean's textual form.
 */
function computeEnumDistributionObservations(
  recordsByEntity: Map<string, EntityRecord[]>,
  project: Project,
  hebrew: boolean,
  entityLabels: Map<string, number>,
): {
  text: string;
  entityName: string;
  entityLabel: string;
  fieldName: string;
  fieldLabel: string;
  breakdown: { value: string; label: string; count: number }[];
}[] {
  const observations: ReturnType<typeof computeEnumDistributionObservations> = [];
  for (const entity of project.spec.entities) {
    const distributionFields = entity.fields.filter(
      (f) => (f.type === "enum" && f.enumValues && f.enumValues.length > 0) || f.type === "boolean",
    );
    if (distributionFields.length === 0) continue;
    const records = recordsByEntity.get(entity.name) ?? [];
    if (records.length === 0) continue;

    const entityLabel = entityDisplayLabel(entity, entityLabels);
    // Same label-collision gap as computeRelationCoverageObservations/
    // computeNumericAggregateObservations above -- two enum/boolean fields
    // on the same entity sharing a label would otherwise produce two
    // identical-looking breakdown lines with no way to tell them apart.
    const labelOccurrences = new Map<string, number>();
    for (const field of distributionFields) {
      const label = field.label ?? field.name;
      labelOccurrences.set(label, (labelOccurrences.get(label) ?? 0) + 1);
    }

    for (const field of distributionFields) {
      const countByValue = new Map<string, number>();
      for (const record of records) {
        const raw = record[field.name];
        if (raw === null || raw === undefined || raw === "") continue;
        const value = String(raw);
        countByValue.set(value, (countByValue.get(value) ?? 0) + 1);
      }
      if (countByValue.size < 2) continue;

      const breakdown = [...countByValue.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([value, count]) => ({
          value,
          label: field.type === "boolean" ? (value === "true" ? "TRUE" : "FALSE") : (field.enumLabels && field.enumLabels[value]) || value,
          count,
        }));
      const breakdownText = breakdown.map((b) => `${b.count} "${b.label}"`).join(", ");
      const fieldLabel = field.label ?? field.name;
      const ambiguous = (labelOccurrences.get(fieldLabel) ?? 0) > 1;
      const fieldSuffix = ambiguous ? ` (${field.name})` : "";
      observations.push({
        text: hebrew
          ? `פילוח "${fieldLabel}"${fieldSuffix} ב"${entityLabel}": ${breakdownText}.`
          : `"${fieldLabel}"${fieldSuffix} breakdown in "${entityLabel}": ${breakdownText}.`,
        entityName: entity.name,
        entityLabel,
        fieldName: field.name,
        // Round 1336: same disambiguation fix as computeNumericAggregateObservations above.
        fieldLabel: fieldLabel + fieldSuffix,
        breakdown,
      });
    }
  }
  return observations;
}

const DATE_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Mirrors entityFormatting.ts's own parseFieldDate -- local-midnight construction so a date string parses the same regardless of which timezone this server process happens to run in. */
function parseFieldDate(raw: string): Date {
  const match = DATE_FORMAT.exec(raw);
  if (match) {
    const [, yearStr, monthStr, dayStr] = match;
    return new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr));
  }
  return new Date(raw);
}

/**
 * Mirrors entityFormatting.ts's own isDeadlineFieldName -- a date field only
 * reads as a deadline a record can be "overdue" against if its own name
 * says so (a past dateOfBirth/joinedDate/shipDate is normal, not overdue).
 * Duplicated here (rather than imported across the apps/web <-> apps/api
 * boundary) the same way calendarFeed.ts already duplicates calendarIcs.ts's
 * own pure helpers, and displayField.ts/codegen.ts each keep their own copy
 * of parseFieldDate -- an established convention in this codebase for a
 * small, pure, cross-package-reused heuristic.
 */
function isDeadlineFieldName(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  return lower.includes("due") || lower.includes("deadline");
}

/**
 * Round 1392: resolves `instant`'s own calendar date in `timeZone` via
 * Intl, instead of the plain `Date.getFullYear()/getMonth()/getDate()`
 * getters computeOverdueObservations/computeDueSoonObservations used to
 * call directly -- those read the *server process's own* OS timezone
 * (UTC on Render, where no TZ env var is set, same default this app's own
 * CI/sandbox already runs under), not the real business owner's. The
 * live table's own getDateUrgency (entityFormatting.ts) runs in the
 * user's browser and therefore already gets this right by accident --
 * so a deadline landing on the server's current UTC date, already
 * "yesterday" or "tomorrow" in the owner's own local date, read as a
 * different overdue/dueSoon classification in the Business Twin than in
 * the live table describing the exact same record. Returns the resulting
 * date as a local-constructed midnight `Date` (same representation
 * parseFieldDate's own date-only values already use), so every existing
 * `.getTime()` comparison below needs no further change -- only how
 * "today" itself is derived.
 */
function startOfDayInTimeZone(instant: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return new Date(Number(get("year")), Number(get("month")) - 1, Number(get("day")));
}

/**
 * The `date` counterpart to computeNumericAggregateObservations/
 * computeEnumDistributionObservations above -- the same invisible-field-
 * type gap, for deadline fields instead of money or status. Every other
 * observation builder in this file reads number/enum/boolean/relation/the
 * display field/createdAt, but never a user-declared `date` field (e.g.
 * Invoice.dueDate, Task.deadline, Claim.deadline -- all seeded in
 * domainEntities.ts), even though entityFormatting.ts's own
 * isDeadlineFieldName/getDateUrgency already exist and are already used
 * to flag an overdue date red in the table/board view -- this is the one
 * place in the app that classification was never surfaced as a genuine,
 * data-derived fact. Only a field whose NAME says it's a deadline counts
 * (a past "shipDate"/"joinedDate" isn't overdue, it's just history) --
 * same restriction isDeadlineFieldName's own doc comment explains.
 * Skipped entirely when no record has a real overdue value for the field,
 * the same "nothing to report yet" guard every sibling observation above
 * already uses.
 */
function computeOverdueObservations(
  recordsByEntity: Map<string, EntityRecord[]>,
  project: Project,
  hebrew: boolean,
  entityLabels: Map<string, number>,
  today: Date = new Date(),
  timeZone: string = "UTC",
): { text: string; entityName: string; entityLabel: string; fieldName: string; fieldLabel: string; overdueCount: number; recordCount: number }[] {
  const observations: ReturnType<typeof computeOverdueObservations> = [];
  const startOfToday = startOfDayInTimeZone(today, timeZone);
  for (const entity of project.spec.entities) {
    const deadlineFields = entity.fields.filter((f) => f.type === "date" && isDeadlineFieldName(f.name));
    if (deadlineFields.length === 0) continue;
    const records = recordsByEntity.get(entity.name) ?? [];
    if (records.length === 0) continue;

    const entityLabel = entityDisplayLabel(entity, entityLabels);
    // Same label-collision gap as computeNumericAggregateObservations/
    // computeEnumDistributionObservations above -- two deadline fields on
    // the same entity (e.g. "dueDate" and "renewalDeadline" both renamed
    // to "Deadline") would otherwise produce two identical-looking lines
    // with no way to tell which real field either one is about.
    const labelOccurrences = new Map<string, number>();
    for (const field of deadlineFields) {
      const label = field.label ?? field.name;
      labelOccurrences.set(label, (labelOccurrences.get(label) ?? 0) + 1);
    }

    for (const field of deadlineFields) {
      let recordCount = 0;
      let overdueCount = 0;
      for (const record of records) {
        const raw = record[field.name];
        if (typeof raw !== "string" || raw === "") continue;
        const date = parseFieldDate(raw);
        if (Number.isNaN(date.getTime())) continue;
        recordCount++;
        if (date.getTime() < startOfToday.getTime()) overdueCount++;
      }
      if (overdueCount === 0) continue;

      const fieldLabel = field.label ?? field.name;
      const ambiguous = (labelOccurrences.get(fieldLabel) ?? 0) > 1;
      const fieldSuffix = ambiguous ? ` (${field.name})` : "";
      observations.push({
        text: hebrew
          ? `${overdueCount} מ-${recordCount} רשומות ב"${entityLabel}" עברו את התאריך ב"${fieldLabel}"${fieldSuffix}.`
          : `${overdueCount} of ${recordCount} records in "${entityLabel}" have an overdue "${fieldLabel}"${fieldSuffix}.`,
        entityName: entity.name,
        entityLabel,
        fieldName: field.name,
        // Round 1336: same disambiguation fix as computeNumericAggregateObservations above.
        fieldLabel: fieldLabel + fieldSuffix,
        overdueCount,
        recordCount,
      });
    }
  }
  return observations;
}

/**
 * Round 1079: the "dueSoon" half of entityFormatting.ts's own DateUrgency
 * classification ("overdue" | "dueSoon" | null, see its own getDateUrgency
 * doc comment) was never surfaced here -- computeOverdueObservations above
 * only ever reports the strictly-past half. EntityPanel.tsx already renders
 * these as two visually distinct states (`date-overdue` vs `date-due-soon`
 * cell styling, `entity.dateOverdue`/`entity.dateDueSoon` i18n titles), so a
 * deadline landing in the next few days is already treated as its own
 * actionable fact in the live table/board -- but the Business Twin, built
 * specifically to surface exactly this kind of data-derived fact, stayed
 * blind to it: a deadline due tomorrow produces zero observations until the
 * moment it actually slips into "overdue", the one case this feature could
 * have given advance notice for. DUE_SOON_WINDOW_DAYS/the days-until
 * calculation mirror getDateUrgency's own exactly, so "due soon" means the
 * identical window a user already sees highlighted in the table.
 */
const DUE_SOON_WINDOW_DAYS = 3;

function computeDueSoonObservations(
  recordsByEntity: Map<string, EntityRecord[]>,
  project: Project,
  hebrew: boolean,
  entityLabels: Map<string, number>,
  today: Date = new Date(),
  timeZone: string = "UTC",
): { text: string; entityName: string; entityLabel: string; fieldName: string; fieldLabel: string; dueSoonCount: number; recordCount: number }[] {
  const observations: ReturnType<typeof computeDueSoonObservations> = [];
  const startOfToday = startOfDayInTimeZone(today, timeZone);
  const dayMs = 24 * 60 * 60 * 1000;
  for (const entity of project.spec.entities) {
    const deadlineFields = entity.fields.filter((f) => f.type === "date" && isDeadlineFieldName(f.name));
    if (deadlineFields.length === 0) continue;
    const records = recordsByEntity.get(entity.name) ?? [];
    if (records.length === 0) continue;

    const entityLabel = entityDisplayLabel(entity, entityLabels);
    // Same label-collision gap computeOverdueObservations above already guards against.
    const labelOccurrences = new Map<string, number>();
    for (const field of deadlineFields) {
      const label = field.label ?? field.name;
      labelOccurrences.set(label, (labelOccurrences.get(label) ?? 0) + 1);
    }

    for (const field of deadlineFields) {
      let recordCount = 0;
      let dueSoonCount = 0;
      for (const record of records) {
        const raw = record[field.name];
        if (typeof raw !== "string" || raw === "") continue;
        const date = parseFieldDate(raw);
        if (Number.isNaN(date.getTime())) continue;
        recordCount++;
        const daysUntil = Math.round((date.getTime() - startOfToday.getTime()) / dayMs);
        if (daysUntil >= 0 && daysUntil < DUE_SOON_WINDOW_DAYS) dueSoonCount++;
      }
      if (dueSoonCount === 0) continue;

      const fieldLabel = field.label ?? field.name;
      const ambiguous = (labelOccurrences.get(fieldLabel) ?? 0) > 1;
      const fieldSuffix = ambiguous ? ` (${field.name})` : "";
      observations.push({
        text: hebrew
          ? `${dueSoonCount} מ-${recordCount} רשומות ב"${entityLabel}" מתקרבות לתאריך ב"${fieldLabel}"${fieldSuffix} בימים הקרובים.`
          : `${dueSoonCount} of ${recordCount} records in "${entityLabel}" have a "${fieldLabel}"${fieldSuffix} coming up soon.`,
        entityName: entity.name,
        entityLabel,
        fieldName: field.name,
        // Round 1336: same disambiguation fix as computeNumericAggregateObservations above.
        fieldLabel: fieldLabel + fieldSuffix,
        dueSoonCount,
        recordCount,
      });
    }
  }
  return observations;
}

export function computeBusinessTwin(
  db: ForgeDatabase,
  project: Project,
  today: Date = new Date(),
  timeZone: string = "UTC",
): BusinessTwin {
  const hebrew = isHebrewText(project.description);

  // Every observation below (relation coverage, the relation hub, duplicate
  // detection, numeric aggregates, enum distributions, activity staleness)
  // used to call listRecords(db, project.id, entity) independently for the
  // same entity -- up to 6 full-table SELECTs per entity, on every single
  // Business Twin open, for a project with relation+text+number+enum fields
  // all on the same entity. Fetched once per entity here instead and handed
  // to every helper below, the same recordsByEntity-cache pattern already
  // used by backup.ts's recordIndexByEntity and GlobalSearchPanel.tsx. The
  // per-entity record count (entities[].count below) is derived from this
  // same array's length rather than a separate countRecords() query --
  // listRecords and countRecords always scan the identical set of rows, so
  // this removes a 7th redundant round-trip per entity, not just the other 6.
  const recordsByEntity = new Map<string, EntityRecord[]>();
  for (const entity of project.spec.entities) {
    recordsByEntity.set(entity.name, listRecords(db, project.id, entity));
  }

  // Computed once here and threaded into every helper below, rather than
  // each one re-deriving its own occurrence count independently -- the
  // occurrence count must be taken over the SAME full entity list every
  // helper is called against (this project's live spec), so sharing one Map
  // also guarantees every observation agrees on which labels are actually
  // ambiguous, not just each helper's own local view.
  const entityLabels = entityLabelOccurrences(project.spec.entities);

  const entities: BusinessTwinEntityStat[] = project.spec.entities.map((entity) => ({
    name: entity.name,
    label: entityDisplayLabel(entity, entityLabels),
    count: recordsByEntity.get(entity.name)?.length ?? 0,
  }));

  const totalRecords = entities.reduce((sum, e) => sum + e.count, 0);
  const unused = entities.filter((e) => e.count === 0);
  const mostActive = entities.reduce<BusinessTwinEntityStat | null>((best, e) => {
    if (e.count === 0) return best;
    if (!best || e.count > best.count) return e;
    return best;
  }, null);

  const observations: string[] = [];
  const jumpableObservations: { text: string; entityName: string }[] = [];
  const numericStats: ReturnType<typeof computeNumericAggregateObservations> = [];
  const distributions: ReturnType<typeof computeEnumDistributionObservations> = [];
  const overdueStats: ReturnType<typeof computeOverdueObservations> = [];
  const dueSoonStats: ReturnType<typeof computeDueSoonObservations> = [];
  let mostLinkedRecord: { text: string; entityName: string; recordId: number } | null = null;
  let mostActiveObservation: { text: string; entityName: string } | null = null;
  if (totalRecords === 0) {
    observations.push(
      hebrew
        ? "עדיין לא הוזנו נתונים אמיתיים באפליקציה — רק הדוגמאות שנוספו בבנייה."
        : "No real data has been entered yet — only the samples added during the build.",
    );
  } else {
    if (mostActive) {
      mostActiveObservation = {
        text: hebrew
          ? `הכי הרבה פעילות יש ב"${mostActive.label}" — ${mostActive.count} רשומות.`
          : `Most activity is in "${mostActive.label}" — ${mostActive.count} records.`,
        entityName: mostActive.name,
      };
    }
    // One jumpableObservations entry per unused entity (rather than one
    // sentence naming several at once) so each is clickable straight to
    // that entity's own tab -- before this, this was the only observation
    // in the whole panel that named a specific entity but gave no way to
    // jump to it, unlike every other insight in the same list.
    for (const e of unused) {
      jumpableObservations.push({
        text: hebrew
          ? `עדיין אין רשומות ב"${e.label}" — כדאי לבדוק אם זה בכוונה.`
          : `No records yet in "${e.label}" — worth checking whether that's expected.`,
        entityName: e.name,
      });
    }
    mostLinkedRecord = computeRelationHubObservation(db, recordsByEntity, project, hebrew, entityLabels);
    jumpableObservations.push(...computeRelationCoverageObservations(recordsByEntity, project, hebrew, entityLabels));
    jumpableObservations.push(...computeFileFieldCoverageObservations(recordsByEntity, project, hebrew, entityLabels));
    jumpableObservations.push(...computeDuplicateObservations(recordsByEntity, project, hebrew, entityLabels));
    numericStats.push(...computeNumericAggregateObservations(recordsByEntity, project, hebrew, entityLabels));
    distributions.push(...computeEnumDistributionObservations(recordsByEntity, project, hebrew, entityLabels));
    overdueStats.push(...computeOverdueObservations(recordsByEntity, project, hebrew, entityLabels, today, timeZone));
    dueSoonStats.push(...computeDueSoonObservations(recordsByEntity, project, hebrew, entityLabels, today, timeZone));
    jumpableObservations.push(...numericStats, ...distributions, ...overdueStats, ...dueSoonStats);
    const activity = computeActivityObservations(recordsByEntity, project, hebrew, entityLabels);
    observations.push(...activity.observations);
    jumpableObservations.push(...activity.jumpableObservations);
  }

  return {
    summary: project.spec.summary,
    roles: project.spec.roles,
    entities,
    totalRecords,
    mostActive,
    unused,
    observations,
    mostLinkedRecord,
    mostActiveObservation,
    jumpableObservations,
    distributions,
    numericStats,
    overdueStats,
    dueSoonStats,
  };
}
