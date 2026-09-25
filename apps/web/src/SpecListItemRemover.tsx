import { useState } from "react";
import type { Project } from "@forge/shared";
import { removeAssumption, removeRole } from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";

/**
 * The spec review screen's "roles" chips and "assumptions" list were
 * otherwise entirely static -- generated once and never correctable, even
 * when the AI/heuristic engine clearly misread the idea (e.g. inventing a
 * "Manager" role for a single-person app, or assuming something untrue).
 * Both are plain string[] entries removed the same way (a real DELETE call,
 * then the returned project replaces the stale one), differing only in
 * which endpoint to call and which markup wraps them -- a chip <span> vs a
 * <li> -- so the busy/error/remove logic lives here once and each shape is
 * its own tiny component below, mirroring EntityLabelEditor's own
 * request/busy/error pattern.
 */
function useRemovableSpecItem(remove: () => Promise<{ project: Project }>, onRemoved: (project: Project) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRemove() {
    setBusy(true);
    setError(null);
    try {
      const { project } = await remove();
      onRemoved(project);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return { busy, error, handleRemove };
}

export function RoleChip({
  role,
  projectId,
  index,
  canRemove,
  onRemoved,
}: {
  role: string;
  projectId: string;
  index: number;
  /** False once this is the only remaining role -- the API rejects removing it (ProductSpecSchema requires roles.min(1)), so the button is disabled instead of letting the user hit that error. */
  canRemove: boolean;
  onRemoved: (project: Project) => void;
}) {
  const { t } = useTranslation();
  const { busy, error, handleRemove } = useRemovableSpecItem(() => removeRole(projectId, index), onRemoved);
  return (
    <span className="chip chip-removable">
      {role}
      <button
        type="button"
        className="chip-remove"
        onClick={handleRemove}
        disabled={busy || !canRemove}
        aria-label={t("spec.roles.remove")}
        title={canRemove ? t("spec.roles.remove") : t("spec.roles.lastOneHint")}
      >
        ×
      </button>
      {error && (
        <span className="error small" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

export function AssumptionItem({
  assumption,
  projectId,
  index,
  onRemoved,
}: {
  assumption: string;
  projectId: string;
  index: number;
  onRemoved: (project: Project) => void;
}) {
  const { t } = useTranslation();
  const { busy, error, handleRemove } = useRemovableSpecItem(() => removeAssumption(projectId, index), onRemoved);
  return (
    <li className="assumption-item">
      <span>{assumption}</span>
      <button
        type="button"
        className="assumption-remove"
        onClick={handleRemove}
        disabled={busy}
        aria-label={t("spec.assumptions.remove")}
        title={t("spec.assumptions.remove")}
      >
        ×
      </button>
      {error && (
        <span className="error small" role="alert">
          {error}
        </span>
      )}
    </li>
  );
}
