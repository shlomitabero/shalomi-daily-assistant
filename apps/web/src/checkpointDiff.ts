import type { Checkpoint, ProductSpec } from "@forge/shared";

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
