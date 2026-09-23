import type { ProductSpec } from "@forge/shared";

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
