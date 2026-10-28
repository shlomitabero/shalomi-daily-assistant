import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { entityDisplayLabel, entityLabelOccurrences, fieldDisplayLabel, fieldLabelOccurrences } from "./entityFormatting.js";
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

  // Exposed so a caller with sibling error states of its own (FieldChip's
  // requiredError/typeError -- see round 931) can clear this one too when
  // one of those siblings starts; unused by every other caller of this hook.
  return { busy, error, handleRemove, clearError: () => setError(null) };
}

/**
 * Click-to-rename for a role/assumption's own text, mirroring
 * EntityLabelEditor/CheckpointLabelEditor's own click-to-edit/Enter-or-
 * blur-saves/Escape-cancels pattern exactly, including the same spurious-
 * save-on-unmount guard (see ProjectNameEditor.tsx's own doc comment for
 * the round-1087 finding that the guard's flag never actually gets reset
 * by the spurious call it was built for -- real-browser blur doesn't
 * redeliver to an already-unmounted fiber's onBlur at all -- so it must
 * also be reset explicitly in startEditing() below, or it swallows the
 * very next real save). Remove-then-re-add was previously the only way to
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
    cancelling.current = false;
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
  siblingActionBusy = false,
  onBusyChange,
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
  /** Round 1133: see FieldChip's own siblingActionBusy comment for the
   * general shape -- true while a SIBLING role's own remove/rename, or
   * AddRoleForm, is in flight, so this chip's own controls wait on an
   * unrelated role's in-flight action too, the same cross-gate
   * EntitySummaryItem/FieldChip already got (rounds 1026/1059/1063), just
   * never extended to this file's three plain string-list sibling
   * families (roles/personas/assumptions) at all. */
  siblingActionBusy?: boolean;
  /** Reports this chip's own busy state up to App.tsx, which folds every
   * mounted RoleChip's own state into one aggregate fed back via
   * siblingActionBusy above and AddRoleForm's own disabled prop -- the
   * other half of the same cross-gate. Keyed by `index` (roles/personas/
   * assumptions have no stable identity beyond array position, the same
   * identity useRemovableSpecItem/useRenamableSpecItem already close over). */
  onBusyChange?: (index: number, busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const { busy, error, handleRemove, clearError } = useRemovableSpecItem(() => removeRole(projectId, index, role), onRemoved);
  const rename = useRenamableSpecItem(role, (value) => renameRole(projectId, index, value, role), onRenamed);

  // Round 1133: see FieldChip's own fieldChipBusy comment -- this chip's
  // own remove/rename each independently PATCH/DELETE then call
  // onRemoved/onRenamed -> App.tsx's setProject(project) full-state
  // replace, the same unguarded read-modify-write race FieldChip already
  // had closed for fields (rounds 1026/1027). ORs in siblingActionBusy so
  // a DIFFERENT role's action (or AddRoleForm) also disables this chip.
  const chipBusy = busy || siblingActionBusy;

  // Round 932: clearError() lives on the OTHER hook (useRemovableSpecItem)
  // from the one startEditing() belongs to (useRenamableSpecItem), which
  // has no knowledge of it -- so, same shape as round 931's
  // handleRemoveField, the cross-clear has to wrap startEditing here. A
  // stale remove error is hidden (not cleared) while rename.editing is
  // true, since this chip's two error states render in mutually exclusive
  // branches -- so without this, it would silently reappear the moment a
  // completely unrelated, successful rename returns to this branch.
  // Round 1133: also guards against starting a rename while chipBusy --
  // see FieldChip's own handleStartRename comment for why guarding just
  // this entry point (rather than disabling the chip-text span, which has
  // no disabled attribute) closes the whole gap: once rename.editing is
  // true, the remove button is unrendered entirely (see the editing
  // branch below).
  function handleStartRename() {
    if (chipBusy) return;
    clearError();
    rename.startEditing();
  }

  // Round 1133: reports this chip's own busy state (both actions -- unlike
  // chipBusy above, which doesn't need rename.busy since starting a rename
  // is already separately guarded by handleStartRename above) up to
  // App.tsx on every change, keyed by this role's own stable `index`. A
  // second effect, mount/unmount-only, clears this chip's own entry when
  // it unmounts (the role was removed, or the whole list re-keyed by a
  // sibling's removal) so a stale "busy" entry doesn't linger in the
  // parent's aggregate forever -- mirrors FieldChip's own identical pair.
  //
  // Round 1147: round 1133's own `ownBusy` here never included
  // `rename.editing` -- only `rename.busy` (true while the save PATCH is
  // actually in flight). So opening this chip's rename editor (typing a
  // draft, not yet submitted) never disabled a SIBLING's own remove
  // button. Removing a sibling then shifts every later chip's own array
  // index, changing this chip's own `key={`${index}-${role}`}` in
  // App.tsx -- React unmounts this chip on the key change, silently
  // discarding the open editor and its unsaved draft with no warning.
  // Including `rename.editing` here closes the gap the same way every
  // other cross-gate in this file already closes it: block the sibling
  // action for as long as this chip has unsaved state, so the array can
  // never shift out from under an open edit.
  const ownBusy = busy || rename.busy || rename.editing;
  useEffect(() => {
    onBusyChange?.(index, ownBusy);
  }, [index, ownBusy, onBusyChange]);
  useEffect(() => {
    return () => onBusyChange?.(index, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, onBusyChange]);

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
        {rename.error && (
          <span className="error small" role="alert">
            {rename.error}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="chip chip-removable">
      <span
        className="chip-text"
        onClick={handleStartRename}
        title={t("spec.roles.rename")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          handleStartRename();
        }}
      >
        {role}
      </span>
      <button
        type="button"
        className="chip-remove"
        onClick={handleRemove}
        disabled={chipBusy || !canRemove}
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
  siblingActionBusy = false,
  onBusyChange,
}: {
  assumption: string;
  projectId: string;
  index: number;
  onRenamed: (project: Project) => void;
  onRemoved: (project: Project) => void;
  /** See RoleChip's own comment -- same gap, same fix. */
  readOnly?: boolean;
  /** See RoleChip's own siblingActionBusy comment -- same gap, same fix. */
  siblingActionBusy?: boolean;
  /** See RoleChip's own onBusyChange comment -- same gap, same fix. */
  onBusyChange?: (index: number, busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const { busy, error, handleRemove, clearError } = useRemovableSpecItem(
    () => removeAssumption(projectId, index, assumption),
    onRemoved,
  );
  const rename = useRenamableSpecItem(
    assumption,
    (value) => renameAssumption(projectId, index, value, assumption),
    onRenamed,
  );

  // Round 1133: see RoleChip's own chipBusy comment -- same gap, same fix.
  const itemBusy = busy || siblingActionBusy;

  /** Round 932: see RoleChip's own handleStartRename -- same gap, same fix. Round 1133: also guards against chipBusy, same gap, same fix. */
  function handleStartRename() {
    if (itemBusy) return;
    clearError();
    rename.startEditing();
  }

  // Round 1133: see RoleChip's own ownBusy/onBusyChange effect pair -- same gap, same fix.
  // Round 1147: see RoleChip's own `ownBusy` doc comment -- same missing
  // `rename.editing` gap, same fix.
  const ownBusy = busy || rename.busy || rename.editing;
  useEffect(() => {
    onBusyChange?.(index, ownBusy);
  }, [index, ownBusy, onBusyChange]);
  useEffect(() => {
    return () => onBusyChange?.(index, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, onBusyChange]);

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
        {rename.error && (
          <span className="error small" role="alert">
            {rename.error}
          </span>
        )}
      </li>
    );
  }

  return (
    <li className="assumption-item">
      <span
        className="assumption-text"
        onClick={handleStartRename}
        title={t("spec.assumptions.rename")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          handleStartRename();
        }}
      >
        {assumption}
      </span>
      <button
        type="button"
        className="assumption-remove"
        onClick={handleRemove}
        disabled={itemBusy}
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
  siblingActionBusy = false,
  onBusyChange,
}: {
  persona: string;
  projectId: string;
  index: number;
  onRenamed: (project: Project) => void;
  onRemoved: (project: Project) => void;
  /** See RoleChip's own comment -- same gap, same fix. */
  readOnly?: boolean;
  /** See RoleChip's own siblingActionBusy comment -- same gap, same fix. */
  siblingActionBusy?: boolean;
  /** See RoleChip's own onBusyChange comment -- same gap, same fix. */
  onBusyChange?: (index: number, busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const { busy, error, handleRemove, clearError } = useRemovableSpecItem(
    () => removePersona(projectId, index, persona),
    onRemoved,
  );
  const rename = useRenamableSpecItem(persona, (value) => renamePersona(projectId, index, value, persona), onRenamed);

  // Round 1133: see RoleChip's own chipBusy comment -- same gap, same fix.
  const itemBusy = busy || siblingActionBusy;

  /** Round 932: see RoleChip's own handleStartRename -- same gap, same fix. Round 1133: also guards against chipBusy, same gap, same fix. */
  function handleStartRename() {
    if (itemBusy) return;
    clearError();
    rename.startEditing();
  }

  // Round 1133: see RoleChip's own ownBusy/onBusyChange effect pair -- same gap, same fix.
  // Round 1147: see RoleChip's own `ownBusy` doc comment -- same missing
  // `rename.editing` gap, same fix.
  const ownBusy = busy || rename.busy || rename.editing;
  useEffect(() => {
    onBusyChange?.(index, ownBusy);
  }, [index, ownBusy, onBusyChange]);
  useEffect(() => {
    return () => onBusyChange?.(index, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, onBusyChange]);

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
        {rename.error && (
          <span className="error small" role="alert">
            {rename.error}
          </span>
        )}
      </li>
    );
  }

  return (
    <li className="persona-item">
      <span
        className="persona-text"
        onClick={handleStartRename}
        title={t("spec.personas.rename")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          handleStartRename();
        }}
      >
        {persona}
      </span>
      <button
        type="button"
        className="persona-remove"
        onClick={handleRemove}
        disabled={itemBusy}
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
  siblingActionBusy = false,
  onBusyChange,
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
  /** Round 1063: see this entity's own anyChildOrSelfBusy comment below --
   * true while a SIBLING entity's own remove/rename (or AddEntityForm) is
   * in flight, the other half of round 1059's own deliberately-deferred
   * gap. Folded into anyChildOrSelfBusy so this entity's whole edit
   * surface (itself, its fields, its add-field form) also waits on an
   * unrelated entity's own in-flight action, the same way a field's own
   * action already waits on a sibling field's. */
  siblingActionBusy?: boolean;
  /** Reports this entity's own anyChildOrSelfBusy state up to App.tsx,
   * which folds every mounted EntitySummaryItem's own state into the same
   * aggregate it feeds back via siblingActionBusy above and AddEntityForm's
   * own disabled prop -- the other half of the same cross-gate. */
  onBusyChange?: (entityName: string, busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const { busy, error, handleRemove, clearError } = useRemovableSpecItem(() => removeEntity(projectId, entity.name), onRemoved);
  const rename = useRenamableSpecItem(
    entity.label ?? entity.name,
    (value) => renameEntityLabel(projectId, entity.name, value),
    onRenamed,
  );
  // Round 1039: renameEntityLabel/renameFieldLabel (both used right on this
  // screen, via click-to-rename) have no server-side uniqueness check --
  // the same gap already fixed for this exact ambiguity in ~12 other
  // surfaces (GlobalSearchPanel, searchReport.ts, automationsReport.ts,
  // print sheets, board cards, CSV/.ics export, impact warnings, rounds
  // 635-642/952 among others). Without this, two sibling fields (or two
  // entities) renamed to the identical label render two identical-looking
  // chips with nothing in the DOM to tell them apart -- including each
  // chip's own bare, confirmation-free "x" remove button. The rename
  // draft's own initial value below is deliberately left as the plain,
  // non-disambiguated label (round 642's own established distinction),
  // so saving it right back unchanged never silently renames the field to
  // "Amount (subtotal)".
  const entityOccurrences = useMemo(() => entityLabelOccurrences(allEntities), [allEntities]);
  const fieldOccurrences = useMemo(() => fieldLabelOccurrences(entity.fields), [entity.fields]);

  /**
   * Round 1059: the other half of round 1027's own gap, one level up.
   * Round 1027 only cross-gated this entity's own remove vs. rename against
   * each other -- it never considered a concurrent FIELD-level action
   * (FieldChip's required/type/remove/rename, or AddFieldForm adding a new
   * one) on one of THIS entity's own fields, even though that races the
   * exact same way: every field route is also a plain, unguarded, name-
   * keyed read-modify-write of the whole project.spec (confirmed by reading
   * routes/projects.ts's own .../fields and .../fields/:fieldName/* handlers
   * -- none of them call assertIndexStillMatches either), so whichever
   * response the browser *receives* last -- not necessarily the one the
   * server processed last -- silently overwrites the other via the same
   * onRenamed/onAdded -> setProject full-state replace. Remove this entity
   * while a sibling field's required-toggle is still in flight, and if that
   * toggle's (now-stale) response arrives after the removal's, the
   * just-deleted entity resurfaces with the field intact. `fieldBusyMap`
   * collects every mounted FieldChip's own busy state (reported up via its
   * new onBusyChange prop below) and `addFieldBusy` tracks AddFieldForm's;
   * folded together with this entity's own busy/rename.busy into one
   * `anyChildOrSelfBusy` flag that now gates every control on this entity's
   * whole edit surface -- itself, each field chip, and the add-field form.
   */
  const [fieldBusyMap, setFieldBusyMap] = useState<Record<string, boolean>>({});
  const handleFieldBusyChange = useCallback((fieldName: string, isFieldBusy: boolean) => {
    setFieldBusyMap((prev) => {
      if (Boolean(prev[fieldName]) === isFieldBusy) return prev;
      if (!isFieldBusy) {
        const { [fieldName]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [fieldName]: true };
    });
  }, []);
  const [addFieldBusy, setAddFieldBusy] = useState(false);
  // Round 1063: now also ORs in siblingActionBusy -- see that prop's own
  // comment above for why a DIFFERENT entity's action (or AddEntityForm)
  // needs to disable this entity's whole edit surface too, not just this
  // entity's own children against each other.
  // Round 1194: also ORs in rename.editing -- see RoleChip's own `ownBusy`
  // doc comment (round 1147) for the general gap. It applies here too,
  // and more severely: anyChildOrSelfBusy is the value this component
  // reports up via onBusyChange below, which becomes a SIBLING entity's
  // own siblingActionBusy -- without rename.editing in it, opening this
  // entity's rename editor and leaving it open (unsaved) left every
  // sibling entity's remove button enabled the whole time, and entity
  // remove/rename routes have no server-side staleness check at all (see
  // handleStartRename's own round-1027 comment below) -- client busy-
  // gating is the only protection against the exact same stale-response
  // resurrection race round 1147 already closed for RoleChip/
  // AssumptionItem/PersonaItem.
  const anyChildOrSelfBusy = busy || rename.busy || rename.editing || addFieldBusy || Object.keys(fieldBusyMap).length > 0 || siblingActionBusy;

  // Round 1063: reports this entity's own anyChildOrSelfBusy state (which
  // already includes every one of its own children -- fields and
  // AddFieldForm -- via the aggregation above) up to App.tsx on every
  // change, keyed by this entity's own stable `name` (never changed by a
  // label-only rename, same guarantee FieldChip's own identical reporting
  // below relies on). A second effect, mount/unmount-only, clears this
  // entity's own entry when it unmounts (the entity was removed) so a
  // stale "busy" entry doesn't linger in App.tsx's aggregate forever.
  useEffect(() => {
    onBusyChange?.(entity.name, anyChildOrSelfBusy);
  }, [entity.name, anyChildOrSelfBusy, onBusyChange]);
  useEffect(() => {
    return () => onBusyChange?.(entity.name, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.name, onBusyChange]);

  /**
   * Round 932: see RoleChip's own handleStartRename -- same gap, same fix.
   * Round 1027: unlike RoleChip/AssumptionItem/PersonaItem (whose server
   * routes re-validate against an `expect` index and reject a stale
   * request with an error, never a stale success -- see those routes'
   * own assertIndexStillMatches calls), this entity's own remove/rename
   * routes are both plain, unguarded read-modify-writes keyed by stable
   * entity name, with no staleness check at all. Clicking remove, then --
   * before that DELETE's response lands -- clicking this label to rename
   * and submitting, fires a concurrent PATCH .../label; whichever
   * response the browser *receives* last (not necessarily the one the
   * server processed last) silently overwrites the other's result via
   * the shared onRemoved/onRenamed -> setProject full-state replace, up
   * to and including resurrecting a just-deleted entity in the UI with
   * its new label. Guarding this entry point against `busy` (remove's
   * own in-flight flag) closes it -- the remove button is unreachable
   * once rename.editing is true (see that branch above), so this is the
   * only direction that needs a guard.
   * Round 1059: now guards against `anyChildOrSelfBusy` instead of just
   * `busy` -- see that flag's own comment above for why a field-level
   * action racing this entity's own rename needs the same guard.
   */
  function handleStartRename() {
    if (anyChildOrSelfBusy) return;
    clearError();
    rename.startEditing();
  }

  if (readOnly) {
    return (
      <div className="entity-summary">
        <div className="entity-summary-header">
          <strong className="entity-summary-label">{entityDisplayLabel(entity, entityOccurrences)}</strong>
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
              labelOccurrences={fieldOccurrences}
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
        {rename.error && (
          <span className="error small" role="alert">
            {rename.error}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="entity-summary">
      <div className="entity-summary-header">
        <strong
          className="entity-summary-label"
          onClick={handleStartRename}
          title={t("spec.entities.rename")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            handleStartRename();
          }}
        >
          {entityDisplayLabel(entity, entityOccurrences)}
        </strong>
        <button
          type="button"
          className="entity-summary-remove"
          onClick={handleRemove}
          disabled={anyChildOrSelfBusy || !canRemove}
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
            labelOccurrences={fieldOccurrences}
            siblingActionBusy={anyChildOrSelfBusy}
            onBusyChange={handleFieldBusyChange}
          />
        ))}
      </div>
      <AddFieldForm
        projectId={projectId}
        entityName={entity.name}
        allEntities={allEntities}
        onAdded={onRenamed}
        disabled={anyChildOrSelfBusy}
        onBusyChange={setAddFieldBusy}
      />
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
  labelOccurrences,
  readOnly = false,
  siblingActionBusy = false,
  onBusyChange,
}: {
  field: Field;
  projectId: string;
  entityName: string;
  /** For the relation-target dropdown when switching this field's type to "relation" -- see AddFieldForm's own identical use. */
  allEntities: Entity[];
  /** False once this is the only remaining field on the entity -- the API rejects removing it (EntitySchema requires fields.min(1)), so the button is disabled instead of letting the user hit that error. */
  canRemove: boolean;
  onChanged: (project: Project) => void;
  /** Round 1039: see EntitySummaryItem's own comment -- computed once there (from this field's own sibling fields) via fieldLabelOccurrences, so a chip whose label collides with a sibling's renders disambiguated by its own unique field name, matching the same convention EntityPanel.tsx already applies everywhere a field label is shown. */
  labelOccurrences: Map<string, number>;
  /** See RoleChip's own comment -- same gap, same fix. */
  readOnly?: boolean;
  /** Round 1059: see EntitySummaryItem's own anyChildOrSelfBusy comment -- true while this entity's own remove/rename, a SIBLING field's own action, or AddFieldForm is in flight, folded into this chip's own fieldChipBusy below so a legitimate concurrent edit elsewhere on this entity disables this chip's controls too, not just this chip's own three actions against each other (round 1026). */
  siblingActionBusy?: boolean;
  /** Reports this chip's own busy state up to EntitySummaryItem, which folds every mounted chip's own state into the same aggregate it feeds back via siblingActionBusy above -- the other half of the same cross-gate. Omitted (readOnly's own render never passes it) since a read-only chip has no actions to report. */
  onBusyChange?: (fieldName: string, busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const { busy, error, handleRemove, clearError } = useRemovableSpecItem(
    () => removeField(projectId, entityName, field.name),
    onChanged,
  );
  const rename = useRenamableSpecItem(
    field.label ?? field.name,
    (value) => renameFieldLabel(projectId, entityName, field.name, value),
    onChanged,
  );
  // Round 1039: see EntitySummaryItem's own identical comment -- this
  // chip's own relation-target dropdown (below) offers every OTHER
  // entity by its label, with the same unresolved collision risk if two
  // entities share one.
  const relationEntityOccurrences = useMemo(() => entityLabelOccurrences(allEntities), [allEntities]);

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
    // Round 931: this chip renders `error`/requiredError/typeError all
    // unconditionally together below, with nothing indicating which
    // action produced which -- mirroring WhatsAppPanel's own
    // handleRetry/handleDeleteMessage cross-clear (rounds 902/909),
    // starting any one of this chip's three actions clears the other
    // two's stale banners too, so a failed required-toggle's error can't
    // outlive a later, unrelated successful type change (or removal).
    setTypeError(null);
    clearError();
    try {
      const { project } = await setFieldRequired(projectId, entityName, field.name, !field.required);
      onChanged(project);
    } catch (err) {
      setRequiredError((err as Error).message);
    } finally {
      setRequiredBusy(false);
    }
  }

  // Round 931: handleRemove comes from the shared useRemovableSpecItem
  // hook above (reused by RoleChip/AssumptionItem/PersonaItem too), which
  // has no knowledge of this chip's own requiredError/typeError -- so the
  // cross-clear has to wrap it here instead of living inside the hook.
  async function handleRemoveField() {
    setRequiredError(null);
    setTypeError(null);
    await handleRemove();
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

  // Round 1026: this chip's own three actions (remove, required-toggle,
  // type-change) each PATCH/DELETE independently and each eventually call
  // the same onChanged(project) -- a full project-state replace, the same
  // shape CollaboratorsPanel's own role-change/remove/invite already
  // cross-gate against each other (rounds 680/930) for exactly this
  // reason. Starting a second action here before the first's response
  // lands means whichever response is *received* last silently overwrites
  // the other's result in React state with no error shown -- the server
  // itself processes both correctly (better-sqlite3 is fully synchronous,
  // no real await inside either route), but network delivery order isn't
  // guaranteed to match request order. Round 931 already cross-cleared
  // these three actions' error banners for the identical reason but never
  // cross-disabled their busy states, leaving the actual race (not just
  // the cosmetic stale-banner issue) open -- this closes it the same way
  // CollaboratorsPanel's own controls already reference every sibling
  // action's busy flag, not just their own.
  // Round 1059: now also ORs in siblingActionBusy -- see this prop's own
  // comment above for why a DIFFERENT field's action (or AddFieldForm, or
  // this entity's own remove/rename) needs to disable this chip too, not
  // just this chip's own three actions against each other.
  const fieldChipBusy = busy || requiredBusy || typeBusy || siblingActionBusy;

  // Round 1059: reports this chip's own busy state (all four of its own
  // actions, including rename -- unlike fieldChipBusy above, which doesn't
  // need rename.busy since starting a rename is already separately guarded
  // by handleStartRename below) up to EntitySummaryItem on every change,
  // keyed by this field's own stable `name` (never changed by a label-only
  // rename). A second effect, mount/unmount-only, clears this chip's own
  // entry when it unmounts (the field was removed) so a stale "busy" entry
  // doesn't linger in the parent's aggregate forever.
  // Round 1194: this aggregate's own doc comment above already claimed
  // "including rename", but only ever ORed in rename.busy (true once the
  // PATCH is in flight), never rename.editing (true the moment the editor
  // opens, before anything is submitted) -- see RoleChip's own `ownBusy`
  // doc comment (round 1147) for the general gap this chip was missed by.
  // Leaving this field's rename editor open (unsaved) left a sibling
  // field's remove/type-change, or this entity's own remove, fully
  // enabled the whole time, racing the eventual rename PATCH with no
  // server-side staleness check on either route to catch it.
  const ownBusy = busy || requiredBusy || typeBusy || rename.busy || rename.editing;
  useEffect(() => {
    onBusyChange?.(field.name, ownBusy);
  }, [field.name, ownBusy, onBusyChange]);
  useEffect(() => {
    return () => onBusyChange?.(field.name, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.name, onBusyChange]);

  async function commitTypeChange(type: Field["type"], opts?: { enumValues?: string; relationTo?: string }) {
    setTypeBusy(true);
    setTypeError(null);
    // Round 931: mirrors handleToggleRequired's own cross-clear above --
    // same chip, same three unconditionally-rendered error spans.
    setRequiredError(null);
    clearError();
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

  // Round 932: see RoleChip's own handleStartRename for the general shape
  // -- this chip just has three siblings to cross-clear instead of one.
  // Round 1027: fieldChipBusy's own cross-gate (round 1026) disables the
  // type select/required checkbox/remove button while any of the three is
  // in flight, but nothing stopped a rename from STARTING during that
  // window -- the field label here has no disabled attribute at all (it's
  // a clickable span, not a form control), and starting one fires a PATCH
  // .../label concurrently with whichever of the other three is still
  // pending. Both routes read-modify-write the same field with no
  // staleness guard, so whichever response the browser *receives* last
  // (not necessarily the one the server processed last) silently
  // overwrites the other's result via the shared onChanged(project) full-
  // state replace. Once rename.editing is true the other three controls
  // are unrendered entirely (see the editing branch below), so guarding
  // just this entry point closes the whole gap.
  function handleStartRename() {
    if (fieldChipBusy) return;
    clearError();
    setRequiredError(null);
    setTypeError(null);
    rename.startEditing();
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
        {fieldDisplayLabel(field, labelOccurrences)}
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
        {rename.error && (
          <span className="error small" role="alert">
            {rename.error}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="chip chip-removable">
      <span
        className="chip-text"
        onClick={handleStartRename}
        title={t("spec.fields.rename")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          handleStartRename();
        }}
      >
        {fieldDisplayLabel(field, labelOccurrences)}
        {field.required ? " *" : ""}
      </span>
      <select
        className="chip-field-type"
        value={draftType ?? field.type}
        disabled={fieldChipBusy}
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
          disabled={fieldChipBusy}
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
            disabled={fieldChipBusy}
            autoFocus
            // Every structurally-identical sibling editor in this file
            // (RoleChip, AssumptionItem, PersonaItem, EntitySummaryItem's
            // label editor, FieldChip's own rename form just above) wires
            // this same Escape-cancels pattern -- this draft form was the
            // one left without it, with no way to back out once opened
            // except submitting (an unwanted network round-trip) or
            // picking a different plain type (which commits immediately
            // and silently wipes enumValues/relationTo server-side).
            onKeyDown={(e) => {
              if (e.key === "Escape") setDraftType(null);
            }}
          />
          <button type="submit" className="secondary small" disabled={fieldChipBusy || !draftEnumValues.trim()}>
            {t("spec.fields.type.confirm")}
          </button>
          <button type="button" className="link-button small" disabled={fieldChipBusy} onClick={() => setDraftType(null)}>
            {t("spec.fields.type.cancel")}
          </button>
        </form>
      )}
      {draftType === "relation" && (
        <form className="chip-field-type-confirm" onSubmit={handleConfirmTypeChange}>
          <select
            value={draftRelationTo}
            onChange={(e) => setDraftRelationTo(e.target.value)}
            disabled={fieldChipBusy}
            aria-label={t("spec.fields.relationTo")}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDraftType(null);
            }}
          >
            {allEntities.map((e) => (
              <option key={e.name} value={e.name}>
                {entityDisplayLabel(e, relationEntityOccurrences)}
              </option>
            ))}
          </select>
          <button type="submit" className="secondary small" disabled={fieldChipBusy || !draftRelationTo}>
            {t("spec.fields.type.confirm")}
          </button>
          <button type="button" className="link-button small" disabled={fieldChipBusy} onClick={() => setDraftType(null)}>
            {t("spec.fields.type.cancel")}
          </button>
        </form>
      )}
      <label className="chip-field-required" title={t("spec.fields.required")}>
        <input
          type="checkbox"
          checked={field.required}
          disabled={fieldChipBusy}
          onChange={handleToggleRequired}
          aria-label={t("spec.fields.required")}
        />
        {t("spec.fields.requiredShort")}
      </label>
      <button
        type="button"
        className="chip-remove"
        onClick={handleRemoveField}
        disabled={fieldChipBusy || !canRemove}
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
  disabled = false,
  onBusyChange,
}: {
  projectId: string;
  onAdded: (project: Project) => void;
  /** See RoleChip's own comment -- same gap, same fix: hidden entirely, the same way EntityPanel's own record form is hidden (not just disabled) for a read-only viewer. */
  readOnly?: boolean;
  /** Round 1133: see AddEntityForm's own disabled comment -- same gap, same fix, one level down (roles rather than entities). True while any role's own remove/rename is in flight. */
  disabled?: boolean;
  /** Reports this form's own busy state up to App.tsx, which folds it into the same aggregate it feeds back via each RoleChip's own siblingActionBusy prop -- the other half of the same cross-gate. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const { value, setValue, busy, error, handleSubmit } = useAddableSpecItem(
    (role) => addRole(projectId, role),
    onAdded,
  );
  const formDisabled = busy || disabled;

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  if (readOnly) return null;
  return (
    <form className="spec-add-item-form" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("spec.roles.addPlaceholder")}
        aria-label={t("spec.roles.addPlaceholder")}
        disabled={formDisabled}
      />
      <button type="submit" className="secondary" disabled={formDisabled || !value.trim()}>
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
  disabled = false,
  onBusyChange,
}: {
  projectId: string;
  onAdded: (project: Project) => void;
  /** See AddRoleForm's own comment -- same gap, same fix. */
  readOnly?: boolean;
  /** Round 1063: the other half of round 1059's own deliberately-deferred
   * gap -- that round cross-gated AddFieldForm against its own entity's
   * sibling FieldChips, but explicitly left this entity-level pairing
   * (AddEntityForm vs. every EntitySummaryItem's own remove/rename) open
   * since closing it means lifting busy state up through App.tsx. True
   * while any entity's own remove/rename -- or a sibling field action
   * underneath one -- is in flight; folded into this form's own local
   * `busy` below so adding a new entity no longer races a concurrent
   * entity removal/rename the same way round 1059 already closed one
   * level down for fields. */
  disabled?: boolean;
  /** Reports this form's own busy state up to App.tsx, which folds it into
   * the same aggregate it feeds back via each EntitySummaryItem's own
   * siblingActionBusy prop -- the other half of the same cross-gate. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const { value, setValue, busy, error, handleSubmit } = useAddableSpecItem(
    (label) => addEntity(projectId, label),
    onAdded,
  );
  const formDisabled = busy || disabled;

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  if (readOnly) return null;
  return (
    <form className="spec-add-item-form" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("spec.entities.addPlaceholder")}
        aria-label={t("spec.entities.addPlaceholder")}
        disabled={formDisabled}
      />
      <button type="submit" className="secondary" disabled={formDisabled || !value.trim()}>
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
  disabled = false,
  onBusyChange,
}: {
  projectId: string;
  entityName: string;
  allEntities: Entity[];
  onAdded: (project: Project) => void;
  /** See AddRoleForm's own comment -- same gap, same fix. Not actually threaded in from App.tsx (EntitySummaryItem's own readOnly branch above omits AddFieldForm entirely instead), but declared the same way as every sibling Add*Form for consistency and in case a future caller renders it directly. */
  readOnly?: boolean;
  /** Round 1059: see EntitySummaryItem's own anyChildOrSelfBusy comment -- true while this entity's own remove/rename, or any sibling FieldChip's own action, is in flight. Folded into this form's own local `busy` below so a legitimate concurrent edit to an existing field no longer races this form's add -- the forward direction of the same gap round 1026/1027 only closed within FieldChip's own three actions. */
  disabled?: boolean;
  /** Reports this form's own busy state up to EntitySummaryItem, which folds it into the same aggregate it feeds back via FieldChip's siblingActionBusy and this form's own disabled prop above -- the other half of the same cross-gate. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState("");
  const [type, setType] = useState<Field["type"]>("text");
  const [enumValues, setEnumValues] = useState("");
  const [relationTo, setRelationTo] = useState(allEntities[0]?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Round 1039: see EntitySummaryItem's own identical comment -- this
  // form's own relation-target dropdown (below) has the same unresolved
  // collision risk as FieldChip's identical dropdown if two entities
  // share a label.
  const entityOccurrences = useMemo(() => entityLabelOccurrences(allEntities), [allEntities]);
  // Round 1059: see this form's own `disabled` prop comment above.
  const formDisabled = busy || disabled;

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (formDisabled) return;
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
        disabled={formDisabled}
      />
      <select value={type} onChange={(e) => setType(e.target.value as Field["type"])} disabled={formDisabled} aria-label={t("spec.fields.type")}>
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
          disabled={formDisabled}
        />
      )}
      {type === "relation" && (
        <select value={relationTo} onChange={(e) => setRelationTo(e.target.value)} disabled={formDisabled} aria-label={t("spec.fields.relationTo")}>
          {allEntities.map((e) => (
            <option key={e.name} value={e.name}>
              {entityDisplayLabel(e, entityOccurrences)}
            </option>
          ))}
        </select>
      )}
      <button
        type="submit"
        className="secondary"
        disabled={formDisabled || !label.trim() || (type === "enum" && !enumValues.trim()) || (type === "relation" && !relationTo)}
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
  disabled = false,
  onBusyChange,
}: {
  projectId: string;
  onAdded: (project: Project) => void;
  /** See AddRoleForm's own comment -- same gap, same fix. */
  readOnly?: boolean;
  /** See AddRoleForm's own disabled comment -- same gap, same fix. */
  disabled?: boolean;
  /** See AddRoleForm's own onBusyChange comment -- same gap, same fix. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const { value, setValue, busy, error, handleSubmit } = useAddableSpecItem(
    (assumption) => addAssumption(projectId, assumption),
    onAdded,
  );
  const formDisabled = busy || disabled;

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  if (readOnly) return null;
  return (
    <form className="spec-add-item-form" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("spec.assumptions.addPlaceholder")}
        aria-label={t("spec.assumptions.addPlaceholder")}
        disabled={formDisabled}
      />
      <button type="submit" className="secondary" disabled={formDisabled || !value.trim()}>
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
  disabled = false,
  onBusyChange,
}: {
  projectId: string;
  onAdded: (project: Project) => void;
  /** See AddRoleForm's own comment -- same gap, same fix. */
  readOnly?: boolean;
  /** See AddRoleForm's own disabled comment -- same gap, same fix. */
  disabled?: boolean;
  /** See AddRoleForm's own onBusyChange comment -- same gap, same fix. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const { value, setValue, busy, error, handleSubmit } = useAddableSpecItem(
    (persona) => addPersona(projectId, persona),
    onAdded,
  );
  const formDisabled = busy || disabled;

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  if (readOnly) return null;
  return (
    <form className="spec-add-item-form" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("spec.personas.addPlaceholder")}
        aria-label={t("spec.personas.addPlaceholder")}
        disabled={formDisabled}
      />
      <button type="submit" className="secondary" disabled={formDisabled || !value.trim()}>
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
