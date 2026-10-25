import { clearColumnWidths } from "./columnWidths.js";
import { purgeColumnOrderForEntity } from "./columnOrder.js";
import { purgeHiddenFieldsForEntity } from "./columnVisibility.js";
import { purgeFieldFiltersForEntity } from "./fieldFiltersPreference.js";
import { purgeGroupByFieldForEntity } from "./groupByPreference.js";
import { purgeCollapsedBoardColumnsForEntity } from "./collapsedBoardColumnsPreference.js";
import { purgeCollapsedGroupsForEntity } from "./collapsedGroupsPreference.js";
import { purgeSortKeysForEntity } from "./sortKeysPreference.js";
import { purgeViewModeForEntity } from "./viewModePreference.js";
import { purgeEntityRecentSearchesForEntity } from "./entityRecentSearches.js";
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
  clearColumnWidths(projectId, entityName);
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
