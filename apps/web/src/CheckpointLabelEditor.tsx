import { useRef, useState } from "react";
import type { Checkpoint } from "@forge/shared";
import { renameCheckpoint } from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";

/**
 * Inline click-to-rename for a Time Machine checkpoint's own label -- a
 * checkpoint only ever got the automatic label build/refine gave it
 * ("Initial build", "Refine: <instruction>"), with no way to give an
 * important one a name that's actually memorable months later (e.g.
 * "before the pricing overhaul"). Mirrors EntityLabelEditor.tsx's own
 * click-to-edit/Enter-or-blur-saves/Escape-cancels pattern exactly,
 * including the same spurious-save-on-unmount guard.
 */
export function CheckpointLabelEditor({
  checkpoint,
  projectId,
  onRenamed,
}: {
  checkpoint: Checkpoint;
  projectId: string;
  onRenamed: (checkpoint: Checkpoint) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelling = useRef(false);

  function startEditing() {
    setDraft(checkpoint.label);
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
    if (!trimmed || trimmed === checkpoint.label) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { checkpoint: renamed } = await renameCheckpoint(projectId, checkpoint.id, trimmed);
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
      <strong className="checkpoint-label" onClick={startEditing} title={t("history.renameLabel")}>
        {checkpoint.label}
        <span className="checkpoint-label-edit-icon" aria-hidden="true">
          ✏️
        </span>
      </strong>
    );
  }

  return (
    <div>
      <form
        className="checkpoint-label-edit"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input
          type="text"
          aria-label={t("history.renameLabel")}
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
