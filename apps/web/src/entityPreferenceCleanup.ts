import { purgeColumnWidthsForEntity, migrateColumnWidthsForEntityRename } from "./columnWidths.js";
import { purgeColumnOrderForEntity, migrateColumnOrderForEntityRename } from "./columnOrder.js";
import { purgeHiddenFieldsForEntity, migrateHiddenFieldsForEntityRename } from "./columnVisibility.js";
import { purgeFieldFiltersForEntity, migrateFieldFiltersForEntityRename } from "./fieldFiltersPreference.js";
import { purgeGroupByFieldForEntity, migrateGroupByFieldForEntityRename } from "./groupByPreference.js";
import {
  purgeCollapsedBoardColumnsForEntity,
  migrateCollapsedBoardColumnsForEntityRename,
} from "./collapsedBoardColumnsPreference.js";
import { purgeCollapsedGroupsForEntity, migrateCollapsedGroupsForEntityRename } from "./collapsedGroupsPreference.js";
import { purgeSortKeysForEntity, migrateSortKeysForEntityRename } from "./sortKeysPreference.js";
import { purgeViewModeForEntity, migrateViewModeForEntityRename } from "./viewModePreference.js";
import { purgeEntityRecentSearchesForEntity, migrateEntityRecentSearchesForEntityRename } from "./entityRecentSearches.js";
import { purgeEntityNameFromTabOrder } from "./entityTabOrder.js";

/**
 * projectPreferenceCleanup.ts's own purgeProjectPreferences sweeps every
 * per-entity-keyed store when a whole PROJECT is deleted -- but a refine
 * can also drop just one ENTITY from an otherwise-surviving project (see
 * App.tsx's handleBuildComplete, which already explicitly reasons about
 * this exact case for the stale `activeEntity` tab, but did nothing about
 * these stores before this function existed). Without this, column
 * widths/order/hidden-fields, field filters, group-by choice (plus its
 * paired type), collapsed board columns, collapsed groups, sort keys,
 * view mode, and recent searches for a dropped entity sit in localStorage
 * forever -- the same "a missed store leaks without bound" shape rounds
 * 390/392/399/401 already fixed at the whole-project granularity, just
 * one level down. Worse than a pure leak: if a later refine reintroduces
 * an entity with the same name but a different field shape, several of
 * these stores have no type-check at all and would silently reapply the
 * stale preference to the new, unrelated entity.
 *
 * Called once per dropped entity, right after a build/refine completes,
 * for every entity present in the pre-refine spec but absent from the
 * newly-built one. Each underlying purge function is scoped to exactly
 * one project+entity and leaves every other entity's (and every other
 * project's) own entries untouched.
 *
 * entityTabOrder.ts's own purge is the one exception to that "scoped to
 * one project+entity" shape: that store is keyed by projectId alone, with
 * the entity name living inside its array value, so its purge filters the
 * name out of that array instead of deleting a `${projectId}:${entityName}`
 * entry outright -- added in round 865 after the other 9 stores here
 * (round 853) left it as the one sibling never swept.
 */
export function purgeEntityPreferences(projectId: string, entityName: string): void {
  purgeColumnWidthsForEntity(projectId, entityName);
  purgeColumnOrderForEntity(projectId, entityName);
  purgeHiddenFieldsForEntity(projectId, entityName);
  purgeFieldFiltersForEntity(projectId, entityName);
  purgeGroupByFieldForEntity(projectId, entityName);
  purgeCollapsedBoardColumnsForEntity(projectId, entityName);
  purgeCollapsedGroupsForEntity(projectId, entityName);
  purgeSortKeysForEntity(projectId, entityName);
  purgeViewModeForEntity(projectId, entityName);
  purgeEntityRecentSearchesForEntity(projectId, entityName);
  purgeEntityNameFromTabOrder(projectId, entityName);
}

/**
 * Round 1029: the other half of App.tsx's own round-988 fix. That round
 * correctly stopped treating a case-only entity rename (e.g. "customer"
 * -> "Customer" -- a refine's regenerated spec is free to recase an
 * entity's name while its real shape/data never actually changed) as a
 * drop, so purgeEntityPreferences above is no longer wrongly called
 * against it. But nothing filled the resulting gap: every one of the 9
 * stores below (every purge* call above except entityTabOrder.ts, whose
 * own order array is already remapped case-insensitively by
 * applyColumnOrder/columnOrder.ts -- no storage key of its own to go
 * stale) is keyed by this entity's CURRENT name. The instant the UI
 * starts reading under the new casing, every one of those real,
 * actively-used preferences (column widths/order/hidden fields, field
 * filters, group-by choice + its paired type, collapsed board
 * columns/groups, sort keys, view mode, recent searches) becomes
 * unreachable under its own old key, forever -- indistinguishable from
 * having been silently reset, even though round 988 made sure nothing
 * ever actively deleted it.
 *
 * Called once per entity round 988's own case-insensitive match detects
 * as renamed (not dropped), right alongside it -- renaming each store's
 * own key in place rather than leaving the stale old one to rot, the
 * same way the field-level case-rename fixes (EntityPanel.tsx round 985,
 * collapsedGroupsPreference.ts/collapsedBoardColumnsPreference.ts round
 * 1008) persist their own remap rather than re-discovering it on every
 * load. A no-op per store when there's nothing to migrate.
 */
export function migrateEntityPreferencesForCaseRename(projectId: string, oldName: string, newName: string): void {
  migrateColumnWidthsForEntityRename(projectId, oldName, newName);
  migrateColumnOrderForEntityRename(projectId, oldName, newName);
  migrateHiddenFieldsForEntityRename(projectId, oldName, newName);
  migrateFieldFiltersForEntityRename(projectId, oldName, newName);
  migrateGroupByFieldForEntityRename(projectId, oldName, newName);
  migrateCollapsedBoardColumnsForEntityRename(projectId, oldName, newName);
  migrateCollapsedGroupsForEntityRename(projectId, oldName, newName);
  migrateSortKeysForEntityRename(projectId, oldName, newName);
  migrateViewModeForEntityRename(projectId, oldName, newName);
  migrateEntityRecentSearchesForEntityRename(projectId, oldName, newName);
}
