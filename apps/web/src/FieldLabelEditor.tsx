import { useRef, useState } from "react";
import type { Field, Project } from "@forge/shared";
import { renameFieldLabel } from "./api.js";
import { fieldDisplayLabel } from "./entityFormatting.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useBeforeUnloadWarning } from "./useBeforeUnloadWarning.js";

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
  labelOccurrences,
  readOnly = false,
}: {
  entityName: string;
  field: Field;
  projectId: string;
  onRenamed: (project: Project) => void;
  labelOccurrences: Map<string, number>;
  /** True for a "viewer" collaborator -- the server already rejects this rename with 403 VIEWER_READ_ONLY; this just hides the edit button instead of showing one that can only ever fail. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelling = useRef(false);

  // The raw stored label -- used for the editing draft's initial value and
  // the no-op comparison in save(), since saving the disambiguated display
  // form below (e.g. "Amount (subtotal)") would literally rename the field
  // to that suffixed text instead of leaving its real label untouched.
  const currentLabel = field.label ?? field.name;
  const displayLabel = fieldDisplayLabel(field, labelOccurrences);

  // Round 1552: mirrors ProjectDescriptionEditor.tsx's own round-1477 fix --
  // a tab close/refresh/navigation while a typed-but-unsubmitted rename is
  // sitting in this draft silently discards it with no warning, the exact
  // gap that round already closed for the sibling description editor.
  useBeforeUnloadWarning(editing && draft.trim() !== "" && draft.trim() !== currentLabel);

  function startEditing(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
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
      const { project } = await renameFieldLabel(projectId, entityName, field.name, trimmed);
      onRenamed(project);
      setEditing(false);
    } catch (err) {
      // Round 1892: mirrors EntityLabelEditor.tsx's own identical fix --
      // another tab/collaborator's refine can remove this exact field
      // (FIELD_NOT_FOUND) or its whole entity (ENTITY_NOT_FOUND --
      // routes/projects.ts's field-label route resolves the entity via
      // findEntity before even reaching findField, so a removed entity
      // surfaces as that code here, not FIELD_NOT_FOUND) between this tab
      // loading it and this save. Either way the target is genuinely,
      // permanently gone, so this closes the editor instead of leaving a
      // stuck, endlessly-repeatable error for an outcome that will never
      // change.
      const code = (err as Error & { code?: string }).code;
      if (code === "ENTITY_NOT_FOUND" || code === "FIELD_NOT_FOUND") {
        setEditing(false);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <span className="field-label">
        {displayLabel}
        {field.required ? " *" : ""}
        {!readOnly && (
          <button
            type="button"
            className="field-label-edit-btn"
            onClick={startEditing}
            title={t("entity.renameFieldLabel")}
            aria-label={t("entity.renameFieldLabel")}
          >
            ✏️
          </button>
        )}
      </span>
    );
  }

  return (
    <span className="field-label-edit" onClick={(e) => e.stopPropagation()}>
      <input
        type="text"
        aria-label={t("entity.renameFieldLabel")}
        value={draft}
        autoFocus
        disabled={busy}
        maxLength={200}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Round 1358: this input used to live inside its own nested
          // <form>, itself nested inside EntityPanel.tsx's own record
          // <form> -- invalid HTML (a <form> cannot be a descendant of
          // another <form>) that made Enter here trigger a genuine native
          // page reload instead of React's onSubmit handler, discarding
          // the whole in-progress record edit. Confirmed live via
          // Playwright: the nested-form submit reached the browser's
          // default navigation before React's synthetic onSubmit's own
          // preventDefault() could run. Removing the inner <form> and
          // handling Enter directly here (same preventDefault+
          // stopPropagation pattern Escape already used below, for the
          // same reason: this input is still a descendant of the outer
          // record-form, whose own single-line inputs intentionally let
          // Enter submit the record -- see that form's onKeyDown comment)
          // fixes both: no more invalid nesting, and Enter now only
          // confirms this rename instead of submitting the whole record.
          if (e.key === "Escape") {
            e.stopPropagation();
            cancelEditing();
          } else if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            save();
          }
        }}
      />
      {error && (
        <span className="error small" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
