import { useEffect } from "react";

/**
 * Warns before a tab close, refresh, or navigation away discards real
 * in-progress form input -- the far more common way work gets lost than
 * the Escape-key discard this app's data-escape-handled-locally convention
 * already guards against (see useDialogFocusTrap.ts). `active` is meant to
 * be the exact same "would a user actually lose something real" boolean a
 * caller already computes for its own Escape guard (e.g. AutomationsPanel.tsx's
 * own hasUnsavedDraft), reused here rather than recomputed, so the two
 * protections can't drift out of sync with each other. Browsers ignore the
 * dialog's own text and show their own fixed wording, but `preventDefault`
 * plus a non-empty `returnValue` is still required to trigger it at all.
 */
export function useBeforeUnloadWarning(active: boolean) {
  useEffect(() => {
    if (!active) return;
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [active]);
}
