import { useRef, useState } from "react";
import type { Project } from "@forge/shared";
import { updateProjectDescription } from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";

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
}: {
  project: Project;
  onChanged: (project: Project) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancelling = useRef(false);

  function startEditing() {
    setDraft(project.description);
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
