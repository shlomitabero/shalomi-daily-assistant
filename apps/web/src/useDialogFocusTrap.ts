import { useEffect, useRef } from "react";
import { hideBackgroundFromAssistiveTech } from "./domInert.js";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
    };
  }, []);

  return containerRef;
}
