import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Real dialog behavior for the app's overlay panels (History, Business
 * Twin, WhatsApp, global search): a CSS overlay alone doesn't give a
 * keyboard or screen-reader user what role="dialog"/aria-modal implies.
 * This moves focus into the panel when it opens (unless something inside
 * it, like a search box's own autoFocus, already has focus), keeps
 * Tab/Shift+Tab cycling within the panel instead of leaking into the
 * (visually hidden but still focusable) content behind it, and returns
 * focus to whatever triggered the panel once it closes.
 */
export function useDialogFocusTrap<T extends HTMLElement>() {
  const containerRef = useRef<T>(null);
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
      previouslyFocused?.focus();
    };
  }, []);

  return containerRef;
}
