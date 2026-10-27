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
  onEditStart,
  onBusyChange,
  disabled = false,
  readOnly = false,
}: {
  checkpoint: Checkpoint;
  projectId: string;
  onRenamed: (checkpoint: Checkpoint) => void;
  /**
   * Round 933: HistoryPanel's own error/restoreWarning/deleteError (from
   * handleRestore/handleDelete) render unconditionally at the top of the
   * dialog -- unlike this editor's own `error` just below, they're never
   * hidden by entering edit mode. Without this, a stale one of those
   * three could sit there, fully visible, right through a completely
   * unrelated, successful rename -- this is the hook that lets
   * HistoryPanel clear them the moment editing starts, same as
   * handleRestore/handleDelete already do for each other (round 903).
   */
  onEditStart?: () => void;
  /**
   * Round 1120: the reverse half of `disabled` just below -- HistoryPanel's
   * own Restore/Delete buttons are already disabled for ALL rows while
   * ANY row's restore/delete is in flight (see their own comment), but had
   * no way to know a rename was in flight too. Fired with `true` the
   * instant the real renameCheckpoint request starts and `false` once it
   * settles, so HistoryPanel can fold this into that same "any one busy
   * blocks all" guard.
   */
  onBusyChange?: (busy: boolean) => void;
  /**
   * Round 1120: HistoryPanel's own Restore/Delete buttons are disabled for
   * ALL rows while ANY row's restore/delete is in flight, but nothing
   * stopped clicking this label (even this exact checkpoint's own,
   * mid-restore-or-delete) to start a concurrent renameCheckpoint request
   * -- a rename landing after a delete already removed the row either
   * 404s, or (if the delete hasn't committed yet) races it entirely.
   */
  disabled?: boolean;
  /** True for a "viewer" collaborator -- the server already rejects this rename with 403 VIEWER_READ_ONLY; this just renders the label as plain, non-editable text instead of a click target that can only ever fail. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelling = useRef(false);

  function startEditing() {
    // Round 1120: see this component's own `disabled` prop doc comment --
    // a restore/delete of ANY checkpoint (including this one) still in
    // flight must block starting a rename.
    if (disabled) return;
    // Round 1087: see ProjectNameEditor.tsx's own doc comment -- the
    // cancelling flag's spurious post-cancel save() call never actually
    // arrives in a real browser, so it must be reset here too or it
    // silently swallows the very next real save.
    cancelling.current = false;
    setDraft(checkpoint.label);
    setError(null);
    onEditStart?.();
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
    onBusyChange?.(true);
    setError(null);
    try {
      const { checkpoint: renamed } = await renameCheckpoint(projectId, checkpoint.id, trimmed);
      onRenamed(renamed);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  if (readOnly || disabled) {
    return <strong className="checkpoint-label">{checkpoint.label}</strong>;
  }

  if (!editing) {
    return (
      <strong
        className="checkpoint-label"
        onClick={startEditing}
        title={t("history.renameLabel")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          startEditing();
        }}
      >
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
          data-escape-handled-locally
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
