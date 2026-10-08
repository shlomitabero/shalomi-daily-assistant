import { useRef, useState } from "react";
import type { Entity, Field, Project } from "@forge/shared";
import {
  addAssumption,
  addEntity,
  addField,
  addRole,
  removeAssumption,
  removeEntity,
  removeField,
  removeRole,
  renameAssumption,
  renameEntityLabel,
  renameFieldLabel,
  renameRole,
} from "./api.js";
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

/**
 * Click-to-rename for a role/assumption's own text, mirroring
 * EntityLabelEditor/CheckpointLabelEditor's own click-to-edit/Enter-or-
 * blur-saves/Escape-cancels pattern exactly, including the same spurious-
 * save-on-unmount guard. Remove-then-re-add was previously the only way to
 * fix a typo or wording in an existing role/assumption -- correct in the
 * end, but it silently moved the item to the end of its own list (a new
 * POST always appends) and briefly violated roles' own .min(1) floor if it
 * was the last one. This edits it in place instead.
 */
function useRenamableSpecItem(
  currentValue: string,
  rename: (value: string) => Promise<{ project: Project }>,
  onRenamed: (project: Project) => void,
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelling = useRef(false);

  function startEditing() {
    setDraft(currentValue);
    setError(null);
    setEditing(true);
  }

  function cancelEditing() {
    cancelling.current = true;
    setEditing(false);
  }

  async function save() {
    if (cancelling.current) {
      cancelling.current = false;
      return;
    }
    const trimmed = draft.trim();
    if (!trimmed || trimmed === currentValue) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { project } = await rename(trimmed);
      onRenamed(project);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return { editing, draft, setDraft, busy, error, startEditing, cancelEditing, save };
}

export function RoleChip({
  role,
  projectId,
  index,
  canRemove,
  onRenamed,
  onRemoved,
}: {
  role: string;
  projectId: string;
  index: number;
  /** False once this is the only remaining role -- the API rejects removing it (ProductSpecSchema requires roles.min(1)), so the button is disabled instead of letting the user hit that error. */
  canRemove: boolean;
  onRenamed: (project: Project) => void;
  onRemoved: (project: Project) => void;
}) {
  const { t } = useTranslation();
  const { busy, error, handleRemove } = useRemovableSpecItem(() => removeRole(projectId, index, role), onRemoved);
  const rename = useRenamableSpecItem(role, (value) => renameRole(projectId, index, value, role), onRenamed);

  if (rename.editing) {
    return (
      <span className="chip chip-removable chip-rename-edit">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            rename.save();
          }}
        >
          <input
            type="text"
            aria-label={t("spec.roles.rename")}
            value={rename.draft}
            autoFocus
            disabled={rename.busy}
            onChange={(e) => rename.setDraft(e.target.value)}
            onBlur={rename.save}
            onKeyDown={(e) => {
              if (e.key === "Escape") rename.cancelEditing();
            }}
          />
        </form>
        {rename.error && <span className="error small">{rename.error}</span>}
      </span>
    );
  }

  return (
    <span className="chip chip-removable">
      <span
        className="chip-text"
        onClick={rename.startEditing}
        title={t("spec.roles.rename")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          rename.startEditing();
        }}
      >
        {role}
      </span>
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
  onRenamed,
  onRemoved,
}: {
  assumption: string;
  projectId: string;
  index: number;
  onRenamed: (project: Project) => void;
  onRemoved: (project: Project) => void;
}) {
  const { t } = useTranslation();
  const { busy, error, handleRemove } = useRemovableSpecItem(
    () => removeAssumption(projectId, index, assumption),
    onRemoved,
  );
  const rename = useRenamableSpecItem(
    assumption,
    (value) => renameAssumption(projectId, index, value, assumption),
    onRenamed,
  );

  if (rename.editing) {
    return (
      <li className="assumption-item assumption-rename-edit">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            rename.save();
          }}
        >
          <input
            type="text"
            aria-label={t("spec.assumptions.rename")}
            value={rename.draft}
            autoFocus
            disabled={rename.busy}
            onChange={(e) => rename.setDraft(e.target.value)}
            onBlur={rename.save}
            onKeyDown={(e) => {
              if (e.key === "Escape") rename.cancelEditing();
            }}
          />
        </form>
        {rename.error && <span className="error small">{rename.error}</span>}
      </li>
    );
  }

  return (
    <li className="assumption-item">
      <span
        className="assumption-text"
        onClick={rename.startEditing}
        title={t("spec.assumptions.rename")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          rename.startEditing();
        }}
      >
        {assumption}
      </span>
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
 * to be built) used to be the one part of this page with no correction
 * path at all beyond removal -- an AI-mislabeled entity (a generic
 * "Record" instead of "Customer", say) could only be talked into a
 * relabel via the free-text "additional request" box and hoping the next
 * build actually picks it up, or fixed after the fact in EntityPanel.tsx's
 * own EntityLabelEditor once already built. Reuses that same
 * renameEntityLabel endpoint (a pure spec.entities[].label write, no
 * migration) so a mislabeled entity can be corrected before committing to
 * a full build, not only after. `summary` is passed in already-formatted
 * (App.tsx's own formatEntityFieldSummary) rather than computed here, to
 * avoid a circular import between App.tsx and this file. `canRemove`
 * mirrors RoleChip's own convention: false once this is the only
 * remaining entity (ProductSpecSchema requires entities.min(1), same
 * floor as roles), so the button is disabled instead of letting the user
 * hit the API's 400.
 */
export function EntitySummaryItem({
  entity,
  fieldsSummary,
  projectId,
  canRemove,
  onRenamed,
  onRemoved,
}: {
  entity: Entity;
  /** Formatted via App.tsx's own formatEntityFieldSummary, applied as an aria-label on the fields row below so a screen reader gets one flat sentence instead of navigating each chip individually. Computed there rather than here to avoid a circular import between App.tsx and this file (see AddEntityForm's own comment below). */
  fieldsSummary: string;
  projectId: string;
  canRemove: boolean;
  onRenamed: (project: Project) => void;
  onRemoved: (project: Project) => void;
}) {
  const { t } = useTranslation();
  const { busy, error, handleRemove } = useRemovableSpecItem(() => removeEntity(projectId, entity.name), onRemoved);
  const rename = useRenamableSpecItem(
    entity.label ?? entity.name,
    (value) => renameEntityLabel(projectId, entity.name, value),
    onRenamed,
  );

  if (rename.editing) {
    return (
      <div className="entity-summary entity-summary-rename-edit">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            rename.save();
          }}
        >
          <input
            type="text"
            aria-label={t("spec.entities.rename")}
            value={rename.draft}
            autoFocus
            disabled={rename.busy}
            onChange={(e) => rename.setDraft(e.target.value)}
            onBlur={rename.save}
            onKeyDown={(e) => {
              if (e.key === "Escape") rename.cancelEditing();
            }}
          />
        </form>
        {rename.error && <span className="error small">{rename.error}</span>}
      </div>
    );
  }

  return (
    <div className="entity-summary">
      <div className="entity-summary-header">
        <strong
          className="entity-summary-label"
          onClick={rename.startEditing}
          title={t("spec.entities.rename")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            rename.startEditing();
          }}
        >
          {entity.label ?? entity.name}
        </strong>
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
      </div>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      <div className="entity-summary-fields chips" aria-label={fieldsSummary}>
        {entity.fields.map((field) => (
          <FieldChip
            key={field.name}
            field={field}
            projectId={projectId}
            entityName={entity.name}
            canRemove={entity.fields.length > 1}
            onChanged={onRenamed}
          />
        ))}
      </div>
      <AddFieldForm projectId={projectId} entityName={entity.name} onAdded={onRenamed} />
    </div>
  );
}

/**
 * The per-field counterpart to RoleChip above, mirroring its remove/rename
 * shape exactly (a real DELETE for removal, reusing the existing
 * renameFieldLabel PATCH -- already used post-build in FieldLabelEditor.tsx
 * -- for click-to-rename), rather than the flat, non-interactive
 * `formatEntityFieldSummary` string EntitySummaryItem used to render in its
 * place. `onChanged` is a single callback (unlike RoleChip's separate
 * onRenamed/onRemoved) since both call sites in EntitySummaryItem above
 * pass the exact same setProject-style function for either outcome -- a
 * field add/remove/rename all just replace the whole project the same way.
 */
export function FieldChip({
  field,
  projectId,
  entityName,
  canRemove,
  onChanged,
}: {
  field: Field;
  projectId: string;
  entityName: string;
  /** False once this is the only remaining field on the entity -- the API rejects removing it (EntitySchema requires fields.min(1)), so the button is disabled instead of letting the user hit that error. */
  canRemove: boolean;
  onChanged: (project: Project) => void;
}) {
  const { t } = useTranslation();
  const { busy, error, handleRemove } = useRemovableSpecItem(
    () => removeField(projectId, entityName, field.name),
    onChanged,
  );
  const rename = useRenamableSpecItem(
    field.label ?? field.name,
    (value) => renameFieldLabel(projectId, entityName, field.name, value),
    onChanged,
  );

  if (rename.editing) {
    return (
      <span className="chip chip-removable chip-rename-edit">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            rename.save();
          }}
        >
          <input
            type="text"
            aria-label={t("spec.fields.rename")}
            value={rename.draft}
            autoFocus
            disabled={rename.busy}
            onChange={(e) => rename.setDraft(e.target.value)}
            onBlur={rename.save}
            onKeyDown={(e) => {
              if (e.key === "Escape") rename.cancelEditing();
            }}
          />
        </form>
        {rename.error && <span className="error small">{rename.error}</span>}
      </span>
    );
  }

  return (
    <span className="chip chip-removable">
      <span
        className="chip-text"
        onClick={rename.startEditing}
        title={t("spec.fields.rename")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          rename.startEditing();
        }}
      >
        {field.label ?? field.name}
        {field.required ? " *" : ""}
      </span>
      <button
        type="button"
        className="chip-remove"
        onClick={handleRemove}
        disabled={busy || !canRemove}
        aria-label={t("spec.fields.remove")}
        title={canRemove ? t("spec.fields.remove") : t("spec.fields.lastOneHint")}
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

/**
 * The other half of EntitySummaryItem's own removal/rename correction
 * workflow, matching AddRoleForm/AddAssumptionForm's shape exactly (a
 * single free-text input, appended on submit). The typed text becomes the
 * new entity's human-facing `label` -- the server derives a valid ASCII
 * `name` and a starter "name" field from it (see deriveEntityName in
 * apps/api/src/routes/projects.ts), so nothing more than a label is needed
 * here, the same as adding a role or assumption needs nothing more than
 * their own single string.
 */
export function AddEntityForm({ projectId, onAdded }: { projectId: string; onAdded: (project: Project) => void }) {
  const { t } = useTranslation();
  const { value, setValue, busy, error, handleSubmit } = useAddableSpecItem(
    (label) => addEntity(projectId, label),
    onAdded,
  );
  return (
    <form className="spec-add-item-form" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("spec.entities.addPlaceholder")}
        aria-label={t("spec.entities.addPlaceholder")}
        disabled={busy}
      />
      <button type="submit" className="secondary" disabled={busy || !value.trim()}>
        {t("spec.entities.add")}
      </button>
      {error && (
        <span className="error small" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

/**
 * The other half of FieldChip's own removal/rename correction workflow,
 * matching AddEntityForm's shape exactly (a single free-text label,
 * appended). The typed text becomes the new field's human-facing `label`
 * -- the server derives a valid camelCase ASCII `name` from it (see
 * deriveFieldName in apps/api/src/routes/projects.ts) and the field starts
 * as a plain optional text field, the same starting point a newly-added
 * entity's own first field gets.
 */
export function AddFieldForm({
  projectId,
  entityName,
  onAdded,
}: {
  projectId: string;
  entityName: string;
  onAdded: (project: Project) => void;
}) {
  const { t } = useTranslation();
  const { value, setValue, busy, error, handleSubmit } = useAddableSpecItem(
    (label) => addField(projectId, entityName, label),
    onAdded,
  );
  return (
    <form className="spec-add-item-form spec-add-field-form" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("spec.fields.addPlaceholder")}
        aria-label={t("spec.fields.addPlaceholder")}
        disabled={busy}
      />
      <button type="submit" className="secondary" disabled={busy || !value.trim()}>
        {t("spec.fields.add")}
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
