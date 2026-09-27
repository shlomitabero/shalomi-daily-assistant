import { useState } from "react";
import type { Entity, Project } from "@forge/shared";
import { addAssumption, addRole, removeAssumption, removeEntity, removeRole } from "./api.js";
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
 * request/busy/error pattern. Removal alone was one-directional -- there
 * was no way to add back a role or assumption the engine missed entirely
 * -- so AddRoleForm/AddAssumptionForm below are the other half of the same
 * correction workflow, a plain text input + submit calling the matching
 * POST endpoint.
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

/**
 * The spec review screen's "entities" section (the list of screens about
 * to be built) was the one part of this page with no correction path at
 * all -- unlike roles/assumptions above, an unwanted entity the heuristic
 * or AI invented (an "Courier" screen on a business with no delivery, say)
 * could only be talked out of existence via the free-text "additional
 * request" box and hoping the next build actually drops it, never a
 * guaranteed removal. `summary` is passed in already-formatted (App.tsx's
 * own formatEntityFieldSummary) rather than computed here, to avoid a
 * circular import between App.tsx and this file. `canRemove` mirrors
 * RoleChip's own convention: false once this is the only remaining entity
 * (ProductSpecSchema requires entities.min(1), same floor as roles), so
 * the button is disabled instead of letting the user hit the API's 400.
 */
export function EntitySummaryItem({
  entity,
  summary,
  projectId,
  canRemove,
  onRemoved,
}: {
  entity: Entity;
  summary: string;
  projectId: string;
  canRemove: boolean;
  onRemoved: (project: Project) => void;
}) {
  const { t } = useTranslation();
  const { busy, error, handleRemove } = useRemovableSpecItem(() => removeEntity(projectId, entity.name), onRemoved);
  return (
    <div className="entity-summary">
      <strong>{entity.label ?? entity.name}</strong>
      <span className="muted"> — {summary}</span>
      <button
        type="button"
        className="entity-summary-remove"
        onClick={handleRemove}
        disabled={busy || !canRemove}
        aria-label={t("spec.entities.remove")}
        title={canRemove ? t("spec.entities.remove") : t("spec.entities.lastOneHint")}
      >
        ×
      </button>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function useAddableSpecItem(add: (value: string) => Promise<{ project: Project }>, onAdded: (project: Project) => void) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await add(trimmed);
      onAdded(project);
      setValue("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return { value, setValue, busy, error, handleSubmit };
}

export function AddRoleForm({ projectId, onAdded }: { projectId: string; onAdded: (project: Project) => void }) {
  const { t } = useTranslation();
  const { value, setValue, busy, error, handleSubmit } = useAddableSpecItem(
    (role) => addRole(projectId, role),
    onAdded,
  );
  return (
    <form className="spec-add-item-form" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("spec.roles.addPlaceholder")}
        aria-label={t("spec.roles.addPlaceholder")}
        disabled={busy}
      />
      <button type="submit" className="secondary" disabled={busy || !value.trim()}>
        {t("spec.roles.add")}
      </button>
      {error && (
        <span className="error small" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

export function AddAssumptionForm({ projectId, onAdded }: { projectId: string; onAdded: (project: Project) => void }) {
  const { t } = useTranslation();
  const { value, setValue, busy, error, handleSubmit } = useAddableSpecItem(
    (assumption) => addAssumption(projectId, assumption),
    onAdded,
  );
  return (
    <form className="spec-add-item-form" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("spec.assumptions.addPlaceholder")}
        aria-label={t("spec.assumptions.addPlaceholder")}
        disabled={busy}
      />
      <button type="submit" className="secondary" disabled={busy || !value.trim()}>
        {t("spec.assumptions.add")}
      </button>
      {error && (
        <span className="error small" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}
