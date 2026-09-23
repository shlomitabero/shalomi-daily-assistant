import type { Entity, EntityRecord, Project } from "@forge/shared";
import { countRecords, getRecord, listRecords, type ForgeDatabase } from "@forge/db";
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
}

/**
 * Reports how well a relation field is actually being used -- e.g. "3 of 5
 * tickets have no customer linked" -- for any entity that has one, not
 * special-cased to a particular entity/field name. This is exactly the
 * same "genuine fact derived from live data" principle as the rest of the
 * Business Twin: it never guesses *why* a relation is unset, just surfaces
 * the honest count so a real person can decide whether that's expected.
 */
function computeRelationCoverageObservations(db: ForgeDatabase, project: Project, hebrew: boolean): string[] {
  const observations: string[] = [];
  for (const entity of project.spec.entities) {
    const relationFields = entity.fields.filter((f) => f.type === "relation");
    if (relationFields.length === 0) continue;
    const records = listRecords(db, project.id, entity);
    if (records.length === 0) continue;

    for (const field of relationFields) {
      const unassigned = records.filter((r) => r[field.name] === null || r[field.name] === undefined).length;
      if (unassigned === 0) continue;
      const entityLabel = entity.label ?? entity.name;
      const fieldLabel = field.label ?? field.name;
      observations.push(
        hebrew
          ? `ב"${entityLabel}", ל-${unassigned} מתוך ${records.length} רשומות אין "${fieldLabel}" מוגדר.`
          : `In "${entityLabel}", ${unassigned} of ${records.length} records have no "${fieldLabel}" set.`,
      );
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
function computeRelationHubObservation(db: ForgeDatabase, project: Project, hebrew: boolean): string[] {
  const entities = project.spec.entities;
  // targetEntityName -> targetRecordId -> [{ sourceLabel, fieldLabel, count }]
  const breakdownByTarget = new Map<string, Map<number, { sourceLabel: string; fieldLabel: string; count: number }[]>>();

  for (const sourceEntity of entities) {
    const relationFields = sourceEntity.fields.filter(
      (f) => f.type === "relation" && f.relationTo && entities.some((e) => e.name === f.relationTo),
    );
    if (relationFields.length === 0) continue;
    const sourceRecords = listRecords(db, project.id, sourceEntity);
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
  if (!best || !targetEntity || !targetRecord) return [];

  const breakdown = breakdownByTarget.get(best.targetName)!.get(best.id)!;
  const breakdownText = breakdown
    .map((b) => (hebrew ? `${b.count} ב"${b.sourceLabel}"` : `${b.count} in "${b.sourceLabel}"`))
    .join(hebrew ? ", " : ", ");
  const label = recordDisplayLabel(targetEntity, targetRecord);
  const entityLabel = targetEntity.label ?? targetEntity.name;

  return [
    hebrew
      ? `"${label}" (${entityLabel}) הרשומה המקושרת ביותר: ${best.total} קישורים בסה"כ — ${breakdownText}.`
      : `"${label}" (${entityLabel}) is the most-linked record: ${best.total} links total — ${breakdownText}.`,
  ];
}

/**
 * Flags records within the same entity that share the exact same display
 * label (the same field pickDisplayField/recordDisplayLabel already uses
 * to represent a record everywhere else in this app -- usually "name" or
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
 * records sharing that exact value really does suggest the same person or
 * thing was entered twice.
 */
function computeDuplicateObservations(db: ForgeDatabase, project: Project, hebrew: boolean): string[] {
  const observations: string[] = [];
  for (const entity of project.spec.entities) {
    const displayField = pickDisplayField(entity);
    if (!displayField || displayField.type !== "text") continue;
    const records = listRecords(db, project.id, entity);
    if (records.length < 2) continue;

    const countByLabel = new Map<string, number>();
    for (const record of records) {
      const label = recordDisplayLabel(entity, record);
      countByLabel.set(label, (countByLabel.get(label) ?? 0) + 1);
    }

    const entityLabel = entity.label ?? entity.name;
    for (const [label, count] of countByLabel) {
      if (count < 2) continue;
      observations.push(
        hebrew
          ? `ב"${entityLabel}", ${count} רשומות חולקות את השם "${label}" — יתכן כפילות.`
          : `In "${entityLabel}", ${count} records share the name "${label}" — possibly a duplicate.`,
      );
    }
  }
  return observations;
}

export function computeBusinessTwin(db: ForgeDatabase, project: Project): BusinessTwin {
  const hebrew = isHebrewText(project.description);
  const entities: BusinessTwinEntityStat[] = project.spec.entities.map((entity) => ({
    name: entity.name,
    label: entity.label ?? entity.name,
    count: countRecords(db, project.id, entity),
  }));

  const totalRecords = entities.reduce((sum, e) => sum + e.count, 0);
  const unused = entities.filter((e) => e.count === 0);
  const mostActive = entities.reduce<BusinessTwinEntityStat | null>((best, e) => {
    if (e.count === 0) return best;
    if (!best || e.count > best.count) return e;
    return best;
  }, null);

  const observations: string[] = [];
  if (totalRecords === 0) {
    observations.push(
      hebrew
        ? "עדיין לא הוזנו נתונים אמיתיים באפליקציה — רק הדוגמאות שנוספו בבנייה."
        : "No real data has been entered yet — only the samples added during the build.",
    );
  } else {
    if (mostActive) {
      observations.push(
        hebrew
          ? `הכי הרבה פעילות יש ב"${mostActive.label}" — ${mostActive.count} רשומות.`
          : `Most activity is in "${mostActive.label}" — ${mostActive.count} records.`,
      );
    }
    if (unused.length > 0) {
      const names = unused.map((e) => e.label).join(hebrew ? ", " : ", ");
      observations.push(
        hebrew
          ? `עדיין אין רשומות ב: ${names} — כדאי לבדוק אם זה בכוונה.`
          : `No records yet in: ${names} — worth checking whether that's expected.`,
      );
    }
    observations.push(...computeRelationHubObservation(db, project, hebrew));
    observations.push(...computeRelationCoverageObservations(db, project, hebrew));
    observations.push(...computeDuplicateObservations(db, project, hebrew));
  }

  return {
    summary: project.spec.summary,
    roles: project.spec.roles,
    entities,
    totalRecords,
    mostActive,
    unused,
    observations,
  };
}
