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
  if (ownedCount > 0 && sharedCount === 0) {
    return t(ownedCount === 1 ? "deleteAccount.summary.ownedOnly.one" : "deleteAccount.summary.ownedOnly.many", { owned: ownedCount });
  }
  if (ownedCount === 0 && sharedCount > 0) {
    return t(sharedCount === 1 ? "deleteAccount.summary.sharedOnly.one" : "deleteAccount.summary.sharedOnly.many", { shared: sharedCount });
  }
  const bothKey =
    ownedCount === 1
      ? sharedCount === 1
        ? "deleteAccount.summary.both.oneOne"
        : "deleteAccount.summary.both.oneMany"
      : sharedCount === 1
        ? "deleteAccount.summary.both.manyOne"
        : "deleteAccount.summary.both.manyMany";
  return t(bothKey, { owned: ownedCount, shared: sharedCount });
}
