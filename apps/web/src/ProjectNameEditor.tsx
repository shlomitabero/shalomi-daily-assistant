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
export function ProjectNameEditor({
  project,
  onRenamed,
  readOnly = false,
}: {
  project: Project;
  onRenamed: (project: Project) => void;
  /** True for a "viewer" collaborator -- the server already rejects this rename with 403 VIEWER_READ_ONLY; this just renders the title as plain, non-editable text instead of a click target that can only ever fail. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Escape sets editing false directly, unmounting the input. The native
   * DOM does dispatch a real "blur" on it as a side effect of losing focus
   * (confirmed with a direct Playwright probe against real Chromium:
   * removing a focused element does dispatch "blur", even though jsdom --
   * used by this file's own test -- does NOT reproduce that behavior, so
   * this exact race can't be caught by a jsdom-rendered test; see
   * ProjectNameEditor.test.ts's own comment). This ref was built to let
   * save() recognize and skip exactly one such spurious post-cancel call.
   *
   * Round 1087's own further Playwright probe found that blur never
   * actually redelivers to React's onBlur once the fiber it belonged to
   * has already been unmounted in the same commit -- so that spurious
   * save() call this ref was built to catch never arrives, and the flag
   * it sets just stays true forever. Left alone, that silently swallows
   * the very NEXT real save on this same instance (type something, Enter
   * or blur to save -- the keystrokes go in, but nothing is sent and the
   * edit box doesn't even close), with no error and no visible sign
   * anything went wrong. Resetting the flag at the start of every fresh
   * edit session, in startEditing() below, fixes this regardless of
   * whether that spurious call ever shows up.
   */
  const cancelling = useRef(false);

  function startEditing() {
    cancelling.current = false;
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

  if (readOnly) {
    return <h1 className="project-name">{project.name}</h1>;
  }

  if (!editing) {
    return (
      <h1
        className="project-name"
        onClick={startEditing}
        title={t("preview.renameProject")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          startEditing();
        }}
      >
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
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
