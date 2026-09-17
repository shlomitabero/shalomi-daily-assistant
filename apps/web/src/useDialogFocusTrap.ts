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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    function getFocusable(): HTMLElement[] {
      return Array.from(container!.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    }

    if (!container.contains(document.activeElement)) {
      const [first] = getFocusable();
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
