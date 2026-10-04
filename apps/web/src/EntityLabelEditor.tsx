import { useRef, useState } from "react";
import type { Entity, Project } from "@forge/shared";
import { renameEntityLabel } from "./api.js";
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
  projectId,
  onRenamed,
}: {
  entity: Entity;
  projectId: string;
  onRenamed: (project: Project) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelling = useRef(false);

  const currentLabel = entity.label ?? entity.name;

  function startEditing() {
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

  if (!editing) {
    return (
      <h3 className="entity-label" onClick={startEditing} title={t("entity.renameLabel")}>
        {currentLabel}
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
