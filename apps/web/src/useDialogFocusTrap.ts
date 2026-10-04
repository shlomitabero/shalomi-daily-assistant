import { useEffect, useRef } from "react";
import { hideBackgroundFromAssistiveTech } from "./domInert.js";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// EntityPanel.tsx never unmounts while an overlay dialog (History, WhatsApp,
// Collaborators, Business Twin, Global Search, Shortcuts, ...) is open on
// top of it (see App.tsx -- it renders as a sibling, not conditionally), so
// its own window-level j/k/n/x/Delete/d keyboard shortcuts kept firing
// underneath an open dialog whenever focus landed on something other than a
// text input inside it -- e.g. ShortcutsPanel's own Close button, which is
// exactly where useDialogFocusTrap's own focus-move-in logic puts focus on
// open, since that panel has no text input at all. Pressing "n"/"Delete"/"d"
// while just reading the shortcuts cheat-sheet silently discarded an
// in-progress edit, popped a delete confirmation over the open dialog, or
// duplicated a record the user wasn't even looking at. A module-scoped count
// (not component state) is deliberate: EntityPanel's own effects need to
// read "is ANY dialog open right now" synchronously inside a native
// `window` keydown handler, not re-render in response to one.
let openDialogCount = 0;

export function isAnyDialogOpen(): boolean {
  return openDialogCount > 0;
}

/**
 * Real dialog behavior for the app's overlay panels (History, Business
 * Twin, WhatsApp, global search): a CSS overlay alone doesn't give a
 * keyboard or screen-reader user what role="dialog"/aria-modal implies.
 * This moves focus into the panel when it opens (unless something inside
 * it, like a search box's own autoFocus, already has focus), keeps
 * Tab/Shift+Tab cycling within the panel instead of leaking into the
 * (visually hidden but still focusable) content behind it, marks that
 * background content inert/aria-hidden so a screen reader's virtual
 * cursor can't reach it either (see domInert.ts -- Tab-trapping alone
 * only blocks sequential keyboard navigation, not a screen reader's own
 * swipe/arrow-key browsing of the page, which ignores tabindex entirely),
 * and returns focus to whatever triggered the panel once it closes.
 *
 * Also closes on Escape when `onClose` is given (round 290): this used to
 * be App.tsx's own job, via a single window-level keydown handler that
 * enumerated six of this app's eight dialogs by hand (History, Business
 * Twin, WhatsApp, Collaborators, Global Search, Shortcuts) -- ChangePassword
 * and DeleteAccount were simply missing from that list, AND that handler
 * only ran while `view === "preview"`, while both of those two panels are
 * reachable from every view via the topbar. Centralizing Escape here means
 * every dialog built on this hook gets it uniformly, with no separate list
 * to keep in sync. `onClose` is read through a ref (not a `useEffect`
 * dependency) so a caller passing a fresh inline arrow function on every
 * render -- the norm here, e.g. `onClose={() => setShowX(false)}` --
 * doesn't force the Tab-trap/inert-background setup below to re-run.
 */
export function useDialogFocusTrap<T extends HTMLElement>(onClose?: () => void) {
  const containerRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Captured during render, not inside the effect below: an effect runs
  // as a passive effect *after* React has already committed the DOM for
  // this render, which includes applying any autoFocus inside the dialog
  // (see GlobalSearchPanel.tsx's search input). By the time an effect ran,
  // document.activeElement would already be that autoFocus'd element, not
  // the real trigger (e.g. the toolbar button the user clicked to open the
  // dialog) -- so focus would never actually return to the trigger on
  // close. Render-phase code runs before this dialog's own DOM exists at
  // all, so it reliably captures whatever had focus beforehand.
  const previouslyFocusedRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const previouslyFocused = previouslyFocusedRef.current;
    const restoreBackground = hideBackgroundFromAssistiveTech(container);
    openDialogCount += 1;

    function getFocusable(): HTMLElement[] {
      return Array.from(container!.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    }

    if (!container.contains(document.activeElement)) {
      const [first] = getFocusable();
      if (!first) {
        // A plain element ignores .focus() unless it's given a tabIndex
        // first (per the DOM spec) -- every current caller always renders
        // at least a close button, so this fallback path isn't hit today,
        // but the hook's own contract ("moves focus into the panel when it
        // opens") should hold for any dialog built on it, including one
        // with no focusable content yet.
        container.tabIndex = -1;
      }
      (first ?? container).focus();
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // An inner control (a search box clearing itself, an inline rename
        // reverting its draft) can opt out of this by marking itself with
        // data-escape-handled-locally -- e.g. CheckpointLabelEditor.tsx's
        // own rename input, or HistoryPanel.tsx's own search box. This
        // listener is a plain native addEventListener on this container
        // DOM node, which real bubbling reaches BEFORE the event ever gets
        // to wherever React's own root listener lives (always further up
        // the real DOM tree, e.g. the #root div in main.tsx) -- so by the
        // time this fires, no inner element's own React onKeyDown has run
        // yet, and nothing it does (including e.stopPropagation()) can
        // suppress this call; only checking the target *before* deciding
        // to close actually works. Returning here (not stopping
        // propagation) still lets the event keep bubbling up to React
        // afterward, so the inner control's own onKeyDown still fires
        // completely normally and handles its local Escape as usual.
        const target = e.target as HTMLElement | null;
        if (target?.closest("[data-escape-handled-locally]")) return;
        onCloseRef.current?.();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    container.addEventListener("keydown", handleKeyDown);
    return () => {
      container.removeEventListener("keydown", handleKeyDown);
      restoreBackground();
      previouslyFocused?.focus();
      openDialogCount -= 1;
    };
  }, []);

  return containerRef;
}
