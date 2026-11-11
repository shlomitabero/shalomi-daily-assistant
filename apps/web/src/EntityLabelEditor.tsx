import { useMemo, useRef, useState } from "react";
import type { Entity, Project } from "@forge/shared";
import { renameEntityLabel } from "./api.js";
import { entityDisplayLabel, entityLabelOccurrences } from "./entityFormatting.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useBeforeUnloadWarning } from "./useBeforeUnloadWarning.js";

/**
 * Inline click-to-rename for an entity's display label (e.g. "Customer"
 * shown as "לקוחות") in the live preview's entity tab/heading. A label was
 * otherwise only ever set once, by spec generation, with no way to fix an
 * awkward one short of a full natural-language Refine round-trip -- even
 * though a label is pure display metadata (EntitySchema's own comment)
 * that never touches the entity's real name or its real data table.
 * Mirrors ProjectNameEditor's own click-to-edit/Enter-or-blur-saves/
 * Escape-cancels pattern exactly, including the same spurious-save-on-
 * unmount guard -- see that component's own comment on why jsdom can't
 * reproduce the real-blur-on-unmount race this guards against.
 */
export function EntityLabelEditor({
  entity,
  allEntities,
  projectId,
  onRenamed,
  readOnly = false,
}: {
  entity: Entity;
  /**
   * Round 1040: EntitySchema only enforces uniqueness on an entity's
   * `name`, never its `label` -- confirmed via entityLabelOccurrences'
   * own doc comment, and `PATCH .../entities/:entityName/label`
   * (routes/projects.ts) has zero uniqueness check. Without this, two
   * entities renamed to an identical label (trivially reachable: open
   * this exact editor on each and retype the same text) rendered
   * byte-identical `<h3>` headers here -- and, since this heading is the
   * only confirmation of which entity's panel you're actually looking at
   * after clicking its tab in App.tsx's own entity-tab bar (same gap,
   * fixed alongside this one), there was no way to tell which entity's
   * data was on screen. Mirrors the already-established
   * entityLabelOccurrences/entityDisplayLabel fix pattern this codebase
   * already applies in AutomationsPanel.tsx, WhatsAppPanel.tsx,
   * checkpointDiff.ts, and (as of round 1039) SpecListItemRemover.tsx.
   */
  allEntities: Entity[];
  projectId: string;
  onRenamed: (project: Project) => void;
  /** True for a "viewer" collaborator -- the server already rejects this rename with 403 VIEWER_READ_ONLY; this just renders the label as plain, non-editable text instead of a click target that can only ever fail. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelling = useRef(false);

  const currentLabel = entity.label ?? entity.name;
  // Disambiguated DISPLAY text only -- the rename draft below is
  // deliberately seeded from the plain `currentLabel`, not this, the same
  // round-642 convention every other fix in this family already follows,
  // so saving a no-op rename never silently renames the entity to the
  // literal text "Customer (Lead)".
  const occurrences = useMemo(() => entityLabelOccurrences(allEntities), [allEntities]);
  const displayLabel = entityDisplayLabel(entity, occurrences);

  // Round 1552: mirrors ProjectDescriptionEditor.tsx's own round-1477 fix --
  // a tab close/refresh/navigation while a typed-but-unsubmitted rename is
  // sitting in this draft silently discards it with no warning, the exact
  // gap that round already closed for the sibling description editor.
  useBeforeUnloadWarning(editing && draft.trim() !== "" && draft.trim() !== currentLabel);

  function startEditing() {
    // Round 1087: see ProjectNameEditor.tsx's own doc comment -- the
    // cancelling flag's spurious post-cancel save() call never actually
    // arrives in a real browser, so it must be reset here too or it
    // silently swallows the very next real save.
    cancelling.current = false;
    setDraft(currentLabel);
    setError(null);
    setEditing(true);
  }

  function cancelEditing() {
    cancelling.current = true;
    setEditing(false);
  }

  async function save() {
    // See ProjectNameEditor.tsx's own comment on this exact guard: a
    // browser forces this still-focused input to blur the instant it
    // becomes disabled (which setBusy(true) below triggers), and that
    // blur re-invokes this same save() a second time without it.
    if (busy) return;
    if (cancelling.current) {
      cancelling.current = false;
      return;
    }
    const trimmed = draft.trim();
    if (!trimmed || trimmed === currentLabel) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { project } = await renameEntityLabel(projectId, entity.name, trimmed);
      onRenamed(project);
      setEditing(false);
    } catch (err) {
      // Round 1892: another tab/collaborator's refine can remove this
      // exact entity from the project's spec between this tab loading it
      // and this save -- routes/projects.ts's findEntity throws
      // ENTITY_NOT_FOUND for that, a real and reachable 404 (entity/field
      // removal on an already-built project is a documented refine
      // capability, see App.tsx's own handleBuildComplete comment), not
      // a hypothetical. A retry can never succeed once the entity is
      // genuinely gone, so unlike every other failure here, this closes
      // the editor with no error instead of leaving a stuck, endlessly-
      // repeatable error for an outcome that will never change -- the
      // same "ghost target" pattern rounds 1884/1885/1890/1891 already
      // close for other deferred actions.
      if ((err as Error & { code?: string }).code === "ENTITY_NOT_FOUND") {
        setEditing(false);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (readOnly) {
    return <h3 className="entity-label">{displayLabel}</h3>;
  }

  if (!editing) {
    return (
      <h3
        className="entity-label"
        onClick={startEditing}
        title={t("entity.renameLabel")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          startEditing();
        }}
      >
        {displayLabel}
        <span className="entity-label-edit-icon" aria-hidden="true">
          ✏️
        </span>
      </h3>
    );
  }

  return (
    <div>
      <form
        className="entity-label-edit"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input
          type="text"
          aria-label={t("entity.renameLabel")}
          value={draft}
          autoFocus
          disabled={busy}
          maxLength={200}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancelEditing();
          }}
        />
      </form>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
