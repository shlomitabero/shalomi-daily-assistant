/**
 * How many people have access to a project (the owner plus every
 * collaborator) -- CollaboratorsPanel's own header never showed this at
 * all, unlike every sibling overlay panel (HistoryPanel's own
 * formatCheckpointCount, App.tsx's formatMyProjectsCount,
 * entityFormatting.ts's formatEntityRecordCount), each of which shows a
 * live count right next to its own <h2>. Unlike those three, this list
 * has no search/filter to narrow it, so there's no "shown vs. total"
 * distinction to make -- just the one real number.
 */
export function formatCollaboratorCount(count: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  return t("collab.count", { count });
}
