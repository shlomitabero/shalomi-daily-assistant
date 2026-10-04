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
): { text: string; entityName: string }[] {
  const observations: { text: string; entityName: string }[] = [];
  for (const entity of project.spec.entities) {
    const relationFields = entity.fields.filter((f) => f.type === "relation");
    if (relationFields.length === 0) continue;
    const records = recordsByEntity.get(entity.name) ?? [];
    if (records.length === 0) continue;

    for (const field of relationFields) {
      const unassigned = records.filter((r) => r[field.name] === null || r[field.name] === undefined).length;
      if (unassigned === 0) continue;
      const entityLabel = entity.label ?? entity.name;
      const fieldLabel = field.label ?? field.name;
      observations.push({
        text: hebrew
          ? `ב"${entityLabel}", ל-${unassigned} מתוך ${records.length} רשומות אין "${fieldLabel}" מוגדר.`
          : `In "${entityLabel}", ${unassigned} of ${records.length} records have no "${fieldLabel}" set.`,
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
): { text: string; entityName: string; recordId: number } | null {
  const entities = project.spec.entities;
  // targetEntityName -> targetRecordId -> [{ sourceLabel, fieldLabel, count }]
  const breakdownByTarget = new Map<string, Map<number, { sourceLabel: string; fieldLabel: string; count: number }[]>>();

  for (const sourceEntity of entities) {
    const relationFields = sourceEntity.fields.filter(
      (f) => f.type === "relation" && f.relationTo && entities.some((e) => e.name === f.relationTo),
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

      const targetName = field.relationTo!;
      if (!breakdownByTarget.has(targetName)) breakdownByTarget.set(targetName, new Map());
      const perId = breakdownByTarget.get(targetName)!;
      for (const [id, count] of countsById) {
        const entry = { sourceLabel: sourceEntity.label ?? sourceEntity.name, fieldLabel: field.label ?? field.name, count };
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
  const breakdownText = breakdown
    .map((b) => (hebrew ? `${b.count} ב"${b.sourceLabel}"` : `${b.count} in "${b.sourceLabel}"`))
    .join(hebrew ? ", " : ", ");
  const label = recordDisplayLabel(targetEntity, targetRecord);
  const entityLabel = targetEntity.label ?? targetEntity.name;

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
 * whose picked display field is actually text -- the one case where two
 * records sharing that value really does suggest the same person or thing
 * was entered twice.
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
): { text: string; entityName: string }[] {
  const observations: { text: string; entityName: string }[] = [];
  for (const entity of project.spec.entities) {
    const displayField = pickDisplayField(entity);
    if (!displayField || displayField.type !== "text") continue;
    const records = recordsByEntity.get(entity.name) ?? [];
    if (records.length < 2) continue;

    const groupsByNormalizedLabel = new Map<string, { count: number; displayLabel: string }>();
    for (const record of records) {
      const label = recordDisplayLabel(entity, record);
      const key = label.trim().toLowerCase();
      const existing = groupsByNormalizedLabel.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        groupsByNormalizedLabel.set(key, { count: 1, displayLabel: label });
      }
    }

    const entityLabel = entity.label ?? entity.name;
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
    if (newestAgeMs > 30 * DAY_MS) staleEntities.push({ name: entity.name, label: entity.label ?? entity.name });
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
function computeNumericAggregateObservations(
  recordsByEntity: Map<string, EntityRecord[]>,
  project: Project,
  hebrew: boolean,
): { text: string; entityName: string }[] {
  const observations: { text: string; entityName: string }[] = [];
  for (const entity of project.spec.entities) {
    const numberFields = entity.fields.filter((f) => f.type === "number");
    if (numberFields.length === 0) continue;
    const records = recordsByEntity.get(entity.name) ?? [];
    if (records.length === 0) continue;

    const entityLabel = entity.label ?? entity.name;
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
      observations.push({
        text: hebrew
          ? `סה"כ "${fieldLabel}" ב"${entityLabel}": ${sum.toLocaleString()} (ממוצע ${average.toLocaleString(undefined, { maximumFractionDigits: 1 })} על פני ${values.length} רשומות).`
          : `Total "${fieldLabel}" in "${entityLabel}": ${sum.toLocaleString()} (average ${average.toLocaleString(undefined, { maximumFractionDigits: 1 })} across ${values.length} records).`,
        entityName: entity.name,
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
 */
function computeEnumDistributionObservations(
  recordsByEntity: Map<string, EntityRecord[]>,
  project: Project,
  hebrew: boolean,
): { text: string; entityName: string }[] {
  const observations: { text: string; entityName: string }[] = [];
  for (const entity of project.spec.entities) {
    const enumFields = entity.fields.filter((f) => f.type === "enum" && f.enumValues && f.enumValues.length > 0);
    if (enumFields.length === 0) continue;
    const records = recordsByEntity.get(entity.name) ?? [];
    if (records.length === 0) continue;

    const entityLabel = entity.label ?? entity.name;
    for (const field of enumFields) {
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
        .map(([value, count]) => `${count} "${(field.enumLabels && field.enumLabels[value]) || value}"`)
        .join(", ");
      const fieldLabel = field.label ?? field.name;
      observations.push({
        text: hebrew
          ? `פילוח "${fieldLabel}" ב"${entityLabel}": ${breakdown}.`
          : `"${fieldLabel}" breakdown in "${entityLabel}": ${breakdown}.`,
        entityName: entity.name,
      });
    }
  }
  return observations;
}

export function computeBusinessTwin(db: ForgeDatabase, project: Project): BusinessTwin {
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

  const entities: BusinessTwinEntityStat[] = project.spec.entities.map((entity) => ({
    name: entity.name,
    label: entity.label ?? entity.name,
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
    mostLinkedRecord = computeRelationHubObservation(db, recordsByEntity, project, hebrew);
    jumpableObservations.push(...computeRelationCoverageObservations(recordsByEntity, project, hebrew));
    jumpableObservations.push(...computeDuplicateObservations(recordsByEntity, project, hebrew));
    jumpableObservations.push(...computeNumericAggregateObservations(recordsByEntity, project, hebrew));
    jumpableObservations.push(...computeEnumDistributionObservations(recordsByEntity, project, hebrew));
    const activity = computeActivityObservations(recordsByEntity, project, hebrew);
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
  };
}
