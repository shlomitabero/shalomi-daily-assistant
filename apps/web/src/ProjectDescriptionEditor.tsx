import { useRef, useState } from "react";
import type { Project } from "@forge/shared";
import { updateProjectDescription } from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useBeforeUnloadWarning } from "./useBeforeUnloadWarning.js";

/**
 * Inline click-to-edit for a project's original description, shown on the
 * spec-review screen right under the AI-generated summary. The description
 * was otherwise set exactly once, at creation, with no way to ever fix it
 * -- unlike the name (see ProjectNameEditor, which this mirrors) and every
 * role/entity/assumption on this same screen, all of which already have a
 * real edit path. That's a real gap: this text isn't just a record of what
 * the user originally typed, it's silently re-sent as context on every
 * future /refine and /answers call (see App.tsx's own combinedDescription
 * construction), so a typo or wrong requirement here keeps compounding
 * into every future AI call with no way to correct it.
 *
 * Mirrors ProjectNameEditor's exact interaction model (click to edit,
 * save on blur, Escape cancels without saving, including the same
 * `cancelling` ref guard against a real-browser blur-on-unmount race --
 * see that component's own comment for the full Playwright-confirmed
 * rationale), swapping its single-line `<input>` for a `<textarea>` since
 * a description is routinely multiple sentences.
 */
export function ProjectDescriptionEditor({
  project,
  onChanged,
  readOnly = false,
}: {
  project: Project;
  onChanged: (project: Project) => void;
  /** True for a "viewer" collaborator -- the server already rejects this edit with 403 VIEWER_READ_ONLY; this just renders the description as plain, non-editable text instead of a click target that can only ever fail. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancelling = useRef(false);

  // Round 1477: this is the app's single longest free-text input (5000
  // chars) saved only on blur/submit, never as-you-type -- unlike the home
  // screen's idea textarea, which ideaDraft.ts already autosaves to
  // localStorage on every keystroke. A tab close/refresh/navigation before
  // blurring silently discards the edit with no draft to recover.
  useBeforeUnloadWarning(editing && draft.trim() !== "" && draft.trim() !== project.description);

  function startEditing() {
    // Round 1087: see ProjectNameEditor.tsx's own doc comment -- the
    // cancelling flag's spurious post-cancel save() call never actually
    // arrives in a real browser, so it must be reset here too or it
    // silently swallows the very next real save.
    cancelling.current = false;
    setDraft(project.description);
    setError(null);
    setEditing(true);
  }

  function cancelEditing() {
    cancelling.current = true;
    setEditing(false);
  }

  async function save() {
    // See ProjectNameEditor.tsx's own comment on this exact guard: a
    // browser forces this still-focused textarea to blur the instant it
    // becomes disabled (which setBusy(true) below triggers), and that
    // blur re-invokes this same save() a second time without it.
    if (busy) return;
    if (cancelling.current) {
      cancelling.current = false;
      return;
    }
    const trimmed = draft.trim();
    // An empty/whitespace-only draft just cancels back to the current
    // description instead of sending a request the server would reject
    // anyway (an empty description isn't valid) -- avoids a confusing
    // error for what's really just "changed my mind".
    if (!trimmed || trimmed === project.description) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { project: updated } = await updateProjectDescription(project.id, trimmed);
      onChanged(updated);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (readOnly) {
    return <p className="project-description">{project.description}</p>;
  }

  if (!editing) {
    return (
      <p
        className="project-description"
        onClick={startEditing}
        title={t("spec.description.edit")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          startEditing();
        }}
      >
        {project.description}
        <span className="project-description-edit-icon" aria-hidden="true">
          ✏️
        </span>
      </p>
    );
  }

  return (
    <div>
      <form
        className="project-description-edit"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <textarea
          aria-label={t("spec.description.edit")}
          value={draft}
          autoFocus
          disabled={busy}
          rows={3}
          maxLength={5000}
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
