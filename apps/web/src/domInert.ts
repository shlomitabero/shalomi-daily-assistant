const INERT_MARKER = "data-forge-dialog-inert";

/**
 * Marks everything behind `dialogElement` -- every sibling of every
 * ancestor, up to (not including) document.body -- as inert and
 * aria-hidden, so a screen reader's virtual cursor (and a real browser's
 * own inert-driven focus/pointer blocking) can't reach content that's only
 * *visually* hidden behind an open overlay panel. React 18.3.1 (this
 * project's version) has no JSX `inert` prop -- that landed in React 19 --
 * so this sets the real DOM attribute directly via a ref, the same way any
 * plain-JS dialog library does it.
 *
 * Returns a cleanup function that restores exactly what this call changed:
 * an element that already had `inert` set for some unrelated reason keeps
 * it after cleanup, and an element with a prior `aria-hidden` value gets
 * that value back rather than having the attribute stripped outright. An
 * element already marked by this same call (INERT_MARKER) is skipped on a
 * later ancestor level, so a deeply nested structure never gets touched
 * twice.
 */
export function hideBackgroundFromAssistiveTech(dialogElement: HTMLElement): () => void {
  const restorers: (() => void)[] = [];
  let node: HTMLElement | null = dialogElement;

  while (node && node !== document.body) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      if (sibling.hasAttribute(INERT_MARKER)) continue;

      const hadInert = sibling.hasAttribute("inert");
      const priorAriaHidden = sibling.getAttribute("aria-hidden");
      sibling.setAttribute(INERT_MARKER, "");
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
      restorers.push(() => {
        sibling.removeAttribute(INERT_MARKER);
        if (!hadInert) sibling.removeAttribute("inert");
        if (priorAriaHidden === null) sibling.removeAttribute("aria-hidden");
        else sibling.setAttribute("aria-hidden", priorAriaHidden);
      });
    }
    node = parent;
  }

  return () => {
    for (const restore of restorers) restore();
  };
}
