/**
 * The real scope of a self-service account deletion (round 247) -- the
 * warning text (DeleteAccountPanel.tsx) previously only ever described
 * *what kind* of data would be lost ("every project you own... and your
 * access to any project shared with you") in the abstract, never *how
 * much*. A person weighing this irreversible action deserves the same
 * real number a bulk-delete confirm already shows for a single project
 * list (home.myProjects.bulk.confirmDelete's own {count} interpolation),
 * not vaguer prose for the far more severe action.
 */
export function formatDeleteAccountSummary(
  ownedCount: number,
  sharedCount: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string | null {
  if (ownedCount === 0 && sharedCount === 0) return null;
  if (ownedCount > 0 && sharedCount === 0) return t("deleteAccount.summary.ownedOnly", { owned: ownedCount });
  if (ownedCount === 0 && sharedCount > 0) return t("deleteAccount.summary.sharedOnly", { shared: sharedCount });
  return t("deleteAccount.summary.both", { owned: ownedCount, shared: sharedCount });
}
