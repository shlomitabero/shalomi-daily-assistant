import { useRef, useState } from "react";
import type { Field, Project } from "@forge/shared";
import { renameFieldLabel } from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";

/**
 * Inline click-to-rename for a single field's display label (e.g. a
 * "phone" field shown as "טלפון נייד") in the record-add/edit form. Same
 * story as EntityLabelEditor (round 126): a label was otherwise only ever
 * set once by spec generation, with no way to fix it short of a full
 * Refine round-trip, even though it's pure display metadata that never
 * touches the field's real column.
 *
 * Unlike ProjectNameEditor/EntityLabelEditor, this doesn't make the whole
 * label text clickable -- it lives inside a `<label>` that already wraps
 * the actual form input (for correct label/input association), and a
 * native `<label>` forwards a click anywhere inside it to that input.
 * Making the label text itself the edit-trigger would also refocus the
 * field's real input on every click. A dedicated `<button>` instead: a
 * `<label>` only forwards its default click behavior when the click
 * lands on non-interactive content, so a button absorbs the click
 * without also focusing the sibling input (confirmed with this round's
 * Playwright pass, not just assumed).
 */
export function FieldLabelEditor({
  entityName,
  field,
  projectId,
  onRenamed,
}: {
  entityName: string;
  field: Field;
  projectId: string;
  onRenamed: (project: Project) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelling = useRef(false);

  const currentLabel = field.label ?? field.name;

  function startEditing(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
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
      const { project } = await renameFieldLabel(projectId, entityName, field.name, trimmed);
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
      <span className="field-label">
        {currentLabel}
        {field.required ? " *" : ""}
        <button
          type="button"
          className="field-label-edit-btn"
          onClick={startEditing}
          title={t("entity.renameFieldLabel")}
          aria-label={t("entity.renameFieldLabel")}
        >
          ✏️
        </button>
      </span>
    );
  }

  return (
    <span className="field-label-edit" onClick={(e) => e.stopPropagation()}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          save();
        }}
      >
        <input
          type="text"
          aria-label={t("entity.renameFieldLabel")}
          value={draft}
          autoFocus
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancelEditing();
          }}
        />
      </form>
      {error && <span className="error small">{error}</span>}
    </span>
  );
}
