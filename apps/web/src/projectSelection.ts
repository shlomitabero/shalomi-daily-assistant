/**
 * Bulk-select on the home screen worked off the raw selected-id set with no
 * regard for whether a selected project was still visible under the current
 * search/filter/sort -- select a project, then change the filter so it's
 * hidden, and it stayed "selected": still counted in the bulk-actions bar,
 * and still deleted by a real bulk-delete, even though the user could no
 * longer see it was about to happen.
 */
export function visibleSelectedIds(selectedIds: Set<string>, visibleIds: string[]): Set<string> {
  const visible = new Set(visibleIds);
  return new Set([...selectedIds].filter((id) => visible.has(id)));
}
