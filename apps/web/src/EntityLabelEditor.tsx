import { useMemo, useRef, useState } from "react";
import type { Entity, Project } from "@forge/shared";
import { renameEntityLabel } from "./api.js";
import { entityDisplayLabel, entityLabelOccurrences } from "./entityFormatting.js";
import { useTranslation } from "./i18n/LanguageContext.js";

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
      setError((err as Error).message);
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
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancelEditing();
          }}
        />
      </form>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
