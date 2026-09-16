import type { Project } from "@forge/shared";
import { countRecords, listRecords, type ForgeDatabase } from "@forge/db";
import { isHebrewText } from "@forge/spec-engine";

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
    observations.push(...computeRelationCoverageObservations(db, project, hebrew));
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
