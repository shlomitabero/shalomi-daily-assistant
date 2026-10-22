import { useRef, useState } from "react";
import type { Entity, Field, Project } from "@forge/shared";
import { FIELD_TYPES } from "@forge/shared";
import {
  addAssumption,
  addEntity,
  addField,
  addPersona,
  addRole,
  removeAssumption,
  removeEntity,
  removeField,
  removePersona,
  removeRole,
  renameAssumption,
  renameEntityLabel,
  renameFieldLabel,
  renamePersona,
  renameRole,
  setFieldRequired,
  setFieldType,
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
  readOnly = false,
}: {
  role: string;
  projectId: string;
  index: number;
  /** False once this is the only remaining role -- the API rejects removing it (ProductSpecSchema requires roles.min(1)), so the button is disabled instead of letting the user hit that error. */
  canRemove: boolean;
  onRenamed: (project: Project) => void;
  onRemoved: (project: Project) => void;
  /** A viewer collaborator can land on the spec review screen (it's shown for any unbuilt project, regardless of role) -- the server already rejects a rename/remove with 403 VIEWER_READ_ONLY, but without this the chip still looked and behaved like a live rename/remove control up until that rejection. Mirrors CheckpointLabelEditor's own `if (readOnly) return <strong>...` pattern. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const { busy, error, handleRemove } = useRemovableSpecItem(() => removeRole(projectId, index, role), onRemoved);
  const rename = useRenamableSpecItem(role, (value) => renameRole(projectId, index, value, role), onRenamed);

  if (readOnly) {
    return <span className="chip">{role}</span>;
  }

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
  readOnly = false,
}: {
  assumption: string;
  projectId: string;
  index: number;
  onRenamed: (project: Project) => void;
  onRemoved: (project: Project) => void;
  /** See RoleChip's own comment -- same gap, same fix. */
  readOnly?: boolean;
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

  if (readOnly) {
    return <li className="assumption-item">{assumption}</li>;
  }

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
 * Round 775: `personas` (ProductSpecSchema's own string[], alongside
 * roles/assumptions) is generated by both spec providers and persisted on
 * every project, but had no render anywhere on this screen at all -- let
 * alone a correction path -- unlike roles/assumptions right above, which
 * each got full add/rename/remove treatment many rounds ago. Mirrors
 * AssumptionItem exactly (same shape: a plain string with no identity
 * beyond array position), down to the readOnly/rename/remove markup, since
 * personas carries no `.min(1)` floor on ProductSpecSchema either -- no
 * `canRemove` prop needed, same as AssumptionItem.
 */
export function PersonaItem({
  persona,
  projectId,
  index,
  onRenamed,
  onRemoved,
  readOnly = false,
}: {
  persona: string;
  projectId: string;
  index: number;
  onRenamed: (project: Project) => void;
  onRemoved: (project: Project) => void;
  /** See RoleChip's own comment -- same gap, same fix. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const { busy, error, handleRemove } = useRemovableSpecItem(() => removePersona(projectId, index, persona), onRemoved);
  const rename = useRenamableSpecItem(persona, (value) => renamePersona(projectId, index, value, persona), onRenamed);

  if (readOnly) {
    return <li className="persona-item">{persona}</li>;
  }

  if (rename.editing) {
    return (
      <li className="persona-item persona-rename-edit">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            rename.save();
          }}
        >
          <input
            type="text"
            aria-label={t("spec.personas.rename")}
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
    <li className="persona-item">
      <span
        className="persona-text"
        onClick={rename.startEditing}
        title={t("spec.personas.rename")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          rename.startEditing();
        }}
      >
        {persona}
      </span>
      <button
        type="button"
        className="persona-remove"
        onClick={handleRemove}
        disabled={busy}
        aria-label={t("spec.personas.remove")}
        title={t("spec.personas.remove")}
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
  allEntities,
  fieldsSummary,
  projectId,
  canRemove,
  onRenamed,
  onRemoved,
  readOnly = false,
}: {
  entity: Entity;
  /** The project's full entity list -- threaded through to AddFieldForm below so a newly-added "relation" field can offer a real dropdown of valid targets (including this same entity, for a legitimate self-relation like "reports to"), rather than a free-text name with no way to tell a deliberate reference from a typo. */
  allEntities: Entity[];
  /** Formatted via App.tsx's own formatEntityFieldSummary, applied as an aria-label on the fields row below so a screen reader gets one flat sentence instead of navigating each chip individually. Computed there rather than here to avoid a circular import between App.tsx and this file (see AddEntityForm's own comment below). */
  fieldsSummary: string;
  projectId: string;
  canRemove: boolean;
  onRenamed: (project: Project) => void;
  onRemoved: (project: Project) => void;
  /** See RoleChip's own comment -- same gap, same fix. Threaded through to each FieldChip below and AddFieldForm is omitted entirely, the same way EntityPanel's own record form is hidden (not just disabled) for a read-only viewer. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const { busy, error, handleRemove } = useRemovableSpecItem(() => removeEntity(projectId, entity.name), onRemoved);
  const rename = useRenamableSpecItem(
    entity.label ?? entity.name,
    (value) => renameEntityLabel(projectId, entity.name, value),
    onRenamed,
  );

  if (readOnly) {
    return (
      <div className="entity-summary">
        <div className="entity-summary-header">
          <strong className="entity-summary-label">{entity.label ?? entity.name}</strong>
        </div>
        <div className="entity-summary-fields chips" aria-label={fieldsSummary}>
          {entity.fields.map((field) => (
            <FieldChip
              key={field.name}
              field={field}
              projectId={projectId}
              entityName={entity.name}
              canRemove={entity.fields.length > 1}
              onChanged={onRenamed}
              allEntities={allEntities}
              readOnly
            />
          ))}
        </div>
      </div>
    );
  }

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
            allEntities={allEntities}
          />
        ))}
      </div>
      <AddFieldForm projectId={projectId} entityName={entity.name} allEntities={allEntities} onAdded={onRenamed} />
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
  allEntities,
  canRemove,
  onChanged,
  readOnly = false,
}: {
  field: Field;
  projectId: string;
  entityName: string;
  /** For the relation-target dropdown when switching this field's type to "relation" -- see AddFieldForm's own identical use. */
  allEntities: Entity[];
  /** False once this is the only remaining field on the entity -- the API rejects removing it (EntitySchema requires fields.min(1)), so the button is disabled instead of letting the user hit that error. */
  canRemove: boolean;
  onChanged: (project: Project) => void;
  /** See RoleChip's own comment -- same gap, same fix. */
  readOnly?: boolean;
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

  // A field's `required` flag was otherwise set once at spec generation
  // and rendered as plain, non-interactive " *" text -- the one property
  // on this chip removal/rename already fixed with no correction path at
  // all. A real toggle, the same busy/error shape as handleRemove above,
  // just flipping a boolean through its own PATCH route instead of
  // removing the field entirely.
  const [requiredBusy, setRequiredBusy] = useState(false);
  const [requiredError, setRequiredError] = useState<string | null>(null);

  async function handleToggleRequired() {
    setRequiredBusy(true);
    setRequiredError(null);
    try {
      const { project } = await setFieldRequired(projectId, entityName, field.name, !field.required);
      onChanged(project);
    } catch (err) {
      setRequiredError((err as Error).message);
    } finally {
      setRequiredBusy(false);
    }
  }

  // The last correction gap in this family: an existing field's own
  // *type*, which round 675 only ever let you set for a brand-new field.
  // `draftType` is non-null only while actively changing to "enum" or
  // "relation" -- those need a value/target picked first, so unlike every
  // other type the select commits immediately on change (there's nothing
  // more to ask for a plain text/number/date/boolean/file switch).
  const [draftType, setDraftType] = useState<Field["type"] | null>(null);
  const [draftEnumValues, setDraftEnumValues] = useState("");
  const [draftRelationTo, setDraftRelationTo] = useState(allEntities[0]?.name ?? "");
  const [typeBusy, setTypeBusy] = useState(false);
  const [typeError, setTypeError] = useState<string | null>(null);

  async function commitTypeChange(type: Field["type"], opts?: { enumValues?: string; relationTo?: string }) {
    setTypeBusy(true);
    setTypeError(null);
    try {
      const { project } = await setFieldType(projectId, entityName, field.name, type, opts);
      onChanged(project);
      setDraftType(null);
    } catch (err) {
      setTypeError((err as Error).message);
    } finally {
      setTypeBusy(false);
    }
  }

  // Shared by handleTypeSelectChange's enum/relation branch below and the
  // "edit values"/"edit target" button rendered when the field is ALREADY
  // that type (see that button's own comment for why a type-switch away
  // and back can't substitute for this -- the server's own /type route
  // wipes the old enumValues/relationTo the instant the type changes away).
  function openDraftFor(type: "enum" | "relation") {
    setDraftType(type);
    setDraftEnumValues(field.enumValues?.join(", ") ?? "");
    setDraftRelationTo(field.relationTo ?? allEntities[0]?.name ?? "");
  }

  function handleTypeSelectChange(newType: Field["type"]) {
    if (newType === field.type) {
      setDraftType(null);
      return;
    }
    if (newType === "enum" || newType === "relation") {
      openDraftFor(newType);
      return;
    }
    void commitTypeChange(newType);
  }

  function handleConfirmTypeChange(e: React.FormEvent) {
    e.preventDefault();
    if (!draftType) return;
    if (draftType === "enum" && !draftEnumValues.trim()) return;
    if (draftType === "relation" && !draftRelationTo) return;
    void commitTypeChange(draftType, {
      enumValues: draftType === "enum" ? draftEnumValues : undefined,
      relationTo: draftType === "relation" ? draftRelationTo : undefined,
    });
  }

  if (readOnly) {
    return (
      <span className="chip">
        {field.label ?? field.name}
        {field.required ? " *" : ""}
      </span>
    );
  }

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
      <select
        className="chip-field-type"
        value={draftType ?? field.type}
        disabled={typeBusy}
        onChange={(e) => handleTypeSelectChange(e.target.value as Field["type"])}
        aria-label={t("spec.fields.type")}
      >
        {FIELD_TYPES.map((ft) => (
          <option key={ft} value={ft}>
            {t(`spec.fields.type.${ft}`)}
          </option>
        ))}
      </select>
      {/*
        Without this, a field that's ALREADY "enum"/"relation" had no way
        to edit its own enumValues/relationTo at all: re-picking the type
        <select>'s already-selected option fires no onChange (a native
        <select> never fires change for its current value), and switching
        away to another type and back loses the original values outright
        -- the server's own /type route wipes enumValues/relationTo the
        instant the type changes away (see that route's own doc comment).
        Hidden while a draft is already open so this doesn't duplicate the
        type-switch path's own entry into the same form below.
      */}
      {draftType === null && (field.type === "enum" || field.type === "relation") && (
        <button
          type="button"
          className="chip-field-edit-values"
          onClick={() => openDraftFor(field.type as "enum" | "relation")}
          disabled={typeBusy}
          title={field.type === "enum" ? t("spec.fields.enumValues.edit") : t("spec.fields.relationTo.edit")}
          aria-label={field.type === "enum" ? t("spec.fields.enumValues.edit") : t("spec.fields.relationTo.edit")}
        >
          ✏️
        </button>
      )}
      {draftType === "enum" && (
        <form className="chip-field-type-confirm" onSubmit={handleConfirmTypeChange}>
          <input
            type="text"
            value={draftEnumValues}
            onChange={(e) => setDraftEnumValues(e.target.value)}
            placeholder={t("spec.fields.enumValues.placeholder")}
            aria-label={t("spec.fields.enumValues.placeholder")}
            disabled={typeBusy}
            autoFocus
          />
          <button type="submit" className="secondary small" disabled={typeBusy || !draftEnumValues.trim()}>
            {t("spec.fields.type.confirm")}
          </button>
        </form>
      )}
      {draftType === "relation" && (
        <form className="chip-field-type-confirm" onSubmit={handleConfirmTypeChange}>
          <select
            value={draftRelationTo}
            onChange={(e) => setDraftRelationTo(e.target.value)}
            disabled={typeBusy}
            aria-label={t("spec.fields.relationTo")}
          >
            {allEntities.map((e) => (
              <option key={e.name} value={e.name}>
                {e.label ?? e.name}
              </option>
            ))}
          </select>
          <button type="submit" className="secondary small" disabled={typeBusy || !draftRelationTo}>
            {t("spec.fields.type.confirm")}
          </button>
        </form>
      )}
      <label className="chip-field-required" title={t("spec.fields.required")}>
        <input
          type="checkbox"
          checked={field.required}
          disabled={requiredBusy}
          onChange={handleToggleRequired}
          aria-label={t("spec.fields.required")}
        />
        {t("spec.fields.requiredShort")}
      </label>
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
      {requiredError && (
        <span className="error small" role="alert">
          {requiredError}
        </span>
      )}
      {typeError && (
        <span className="error small" role="alert">
          {typeError}
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

export function AddRoleForm({
  projectId,
  onAdded,
  readOnly = false,
}: {
  projectId: string;
  onAdded: (project: Project) => void;
  /** See RoleChip's own comment -- same gap, same fix: hidden entirely, the same way EntityPanel's own record form is hidden (not just disabled) for a read-only viewer. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const { value, setValue, busy, error, handleSubmit } = useAddableSpecItem(
    (role) => addRole(projectId, role),
    onAdded,
  );
  if (readOnly) return null;
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
export function AddEntityForm({
  projectId,
  onAdded,
  readOnly = false,
}: {
  projectId: string;
  onAdded: (project: Project) => void;
  /** See AddRoleForm's own comment -- same gap, same fix. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const { value, setValue, busy, error, handleSubmit } = useAddableSpecItem(
    (label) => addEntity(projectId, label),
    onAdded,
  );
  if (readOnly) return null;
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
 * The other half of FieldChip's own removal/rename correction workflow.
 * Originally matched AddEntityForm's shape exactly -- a single free-text
 * label, always born as a plain optional text field -- which meant the
 * one thing you could never actually fix here was a wrong field *type*
 * (an enum the AI only described in prose, a relation it missed, a
 * number/date/boolean it got wrong): the only path was delete-and-
 * recreate as the same plain text field, i.e. no real fix at all. Now
 * offers a real type `<select>` (FIELD_TYPES, the same set every other
 * field in this app already uses) plus the two type-specific follow-ups
 * FieldSchema itself already requires -- enum values (one comma-separated
 * input, split server-side, the natural way to type "New, In Progress,
 * Done" without needing to know this becomes an array) and a relation
 * target. The relation target is a `<select>` of this entity's real
 * sibling names (allEntities, including this entity itself for a
 * legitimate self-relation), never a free-text field -- there is no
 * "typo vs. deliberate forward reference" ambiguity to resolve (the
 * already-rejected round-415 concern) when the only choices offered are
 * entities that already exist in this exact project.
 */
export function AddFieldForm({
  projectId,
  entityName,
  allEntities,
  onAdded,
  readOnly = false,
}: {
  projectId: string;
  entityName: string;
  allEntities: Entity[];
  onAdded: (project: Project) => void;
  /** See AddRoleForm's own comment -- same gap, same fix. Not actually threaded in from App.tsx (EntitySummaryItem's own readOnly branch above omits AddFieldForm entirely instead), but declared the same way as every sibling Add*Form for consistency and in case a future caller renders it directly. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState("");
  const [type, setType] = useState<Field["type"]>("text");
  const [enumValues, setEnumValues] = useState("");
  const [relationTo, setRelationTo] = useState(allEntities[0]?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedLabel = label.trim();
    if (!trimmedLabel) return;
    if (type === "enum" && !enumValues.trim()) return;
    if (type === "relation" && !relationTo) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await addField(projectId, entityName, trimmedLabel, {
        type,
        enumValues: type === "enum" ? enumValues : undefined,
        relationTo: type === "relation" ? relationTo : undefined,
      });
      onAdded(project);
      setLabel("");
      setType("text");
      setEnumValues("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (readOnly) return null;

  return (
    <form className="spec-add-item-form spec-add-field-form" onSubmit={handleSubmit}>
      <input
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={t("spec.fields.addPlaceholder")}
        aria-label={t("spec.fields.addPlaceholder")}
        disabled={busy}
      />
      <select value={type} onChange={(e) => setType(e.target.value as Field["type"])} disabled={busy} aria-label={t("spec.fields.type")}>
        {FIELD_TYPES.map((ft) => (
          <option key={ft} value={ft}>
            {t(`spec.fields.type.${ft}`)}
          </option>
        ))}
      </select>
      {type === "enum" && (
        <input
          type="text"
          value={enumValues}
          onChange={(e) => setEnumValues(e.target.value)}
          placeholder={t("spec.fields.enumValues.placeholder")}
          aria-label={t("spec.fields.enumValues.placeholder")}
          disabled={busy}
        />
      )}
      {type === "relation" && (
        <select value={relationTo} onChange={(e) => setRelationTo(e.target.value)} disabled={busy} aria-label={t("spec.fields.relationTo")}>
          {allEntities.map((e) => (
            <option key={e.name} value={e.name}>
              {e.label ?? e.name}
            </option>
          ))}
        </select>
      )}
      <button
        type="submit"
        className="secondary"
        disabled={busy || !label.trim() || (type === "enum" && !enumValues.trim()) || (type === "relation" && !relationTo)}
      >
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

export function AddAssumptionForm({
  projectId,
  onAdded,
  readOnly = false,
}: {
  projectId: string;
  onAdded: (project: Project) => void;
  /** See AddRoleForm's own comment -- same gap, same fix. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const { value, setValue, busy, error, handleSubmit } = useAddableSpecItem(
    (assumption) => addAssumption(projectId, assumption),
    onAdded,
  );
  if (readOnly) return null;
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

/** The other half of PersonaItem's own correction workflow. See AddAssumptionForm's own comment -- identical shape. */
export function AddPersonaForm({
  projectId,
  onAdded,
  readOnly = false,
}: {
  projectId: string;
  onAdded: (project: Project) => void;
  /** See AddRoleForm's own comment -- same gap, same fix. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const { value, setValue, busy, error, handleSubmit } = useAddableSpecItem(
    (persona) => addPersona(projectId, persona),
    onAdded,
  );
  if (readOnly) return null;
  return (
    <form className="spec-add-item-form" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("spec.personas.addPlaceholder")}
        aria-label={t("spec.personas.addPlaceholder")}
        disabled={busy}
      />
      <button type="submit" className="secondary" disabled={busy || !value.trim()}>
        {t("spec.personas.add")}
      </button>
      {error && (
        <span className="error small" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}
