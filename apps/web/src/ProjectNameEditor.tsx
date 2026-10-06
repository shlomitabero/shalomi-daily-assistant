import { useRef, useState } from "react";
import type { Project } from "@forge/shared";
import { renameProject } from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";

/**
 * Inline click-to-rename for the preview screen's project title. A
 * project's name was otherwise only ever set once, at creation
 * (deriveName's auto-derived first few words of the description) --
 * including a clone's generic "(copy)" suffix (see App.tsx's
 * handleDuplicateProject) -- with no way to fix it.
 */
export function ProjectNameEditor({ project, onRenamed }: { project: Project; onRenamed: (project: Project) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Escape sets editing false directly, unmounting the input -- which
   * fires a real blur event on it as a side effect of losing focus
   * (confirmed with a direct Playwright probe against real Chromium:
   * removing a focused element does dispatch "blur", even though jsdom
   * -- used by this file's own test -- does NOT reproduce that behavior,
   * so this exact race can't be caught by a jsdom-rendered test; see
   * ProjectNameEditor.test.ts's own comment). That blur would otherwise
   * also trigger save() (bound to onBlur) and rename the project right
   * after the user explicitly cancelled. This ref lets save() recognize
   * and skip exactly that one spurious call.
   */
  const cancelling = useRef(false);

  function startEditing() {
    setDraft(project.name);
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
    // An empty/whitespace-only draft just cancels back to the current name
    // instead of sending a request the server would reject anyway (a
    // blank name isn't valid) -- avoids a confusing error for what's
    // really just "changed my mind".
    if (!trimmed || trimmed === project.name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { project: renamed } = await renameProject(project.id, trimmed);
      onRenamed(renamed);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <h1 className="project-name" onClick={startEditing} title={t("preview.renameProject")}>
        {project.name}
        <span className="project-name-edit-icon" aria-hidden="true">
          ✏️
        </span>
      </h1>
    );
  }

  return (
    <div>
      <form
        className="project-name-edit"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input
          type="text"
          aria-label={t("preview.renameProject")}
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
