import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { hideBackgroundFromAssistiveTech } from "./domInert.js";

/**
 * Same jsdom-swap technique as useDialogFocusTrap.test.ts (this project's
 * first real DOM test infrastructure, added the same round this file was
 * written). No React rendering is needed here -- domInert.ts only touches
 * the DOM directly -- so this only needs document/HTMLElement on the
 * global scope, not the full act()/event-dispatch dance the React-based
 * test needs.
 */
function withJsdom<T>(fn: () => T): T {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const { window } = dom;
  const replacements: Record<string, unknown> = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
  };
  const originalDescriptors: Record<string, PropertyDescriptor | undefined> = {};
  for (const key of Object.keys(replacements)) {
    originalDescriptors[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      value: replacements[key],
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(replacements)) {
      const original = originalDescriptors[key];
      if (original) Object.defineProperty(globalThis, key, original);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

/** Builds `<body><div id=root><header id=header/><main id=main><div id=sibling1/><div id=dialog/><div id=sibling2/></main></div></body>` and returns the named nodes. */
function buildTree() {
  document.body.innerHTML = `
    <div id="root">
      <header id="header"></header>
      <main id="main">
        <div id="sibling1"></div>
        <div id="dialog"></div>
        <div id="sibling2"></div>
      </main>
    </div>
  `;
  return {
    root: document.getElementById("root")!,
    header: document.getElementById("header")!,
    main: document.getElementById("main")!,
    sibling1: document.getElementById("sibling1")!,
    dialog: document.getElementById("dialog")!,
    sibling2: document.getElementById("sibling2")!,
  };
}

test("hideBackgroundFromAssistiveTech marks every sibling of every ancestor as inert/aria-hidden, but never the dialog or its own ancestor chain", () => {
  withJsdom(() => {
    const { header, main, sibling1, dialog, sibling2 } = buildTree();

    hideBackgroundFromAssistiveTech(dialog);

    // Siblings of the dialog itself, within <main>.
    assert.equal(sibling1.getAttribute("aria-hidden"), "true");
    assert.ok(sibling1.hasAttribute("inert"));
    assert.equal(sibling2.getAttribute("aria-hidden"), "true");
    assert.ok(sibling2.hasAttribute("inert"));

    // A sibling one level further up (<header>, sibling of <main> under #root).
    assert.equal(header.getAttribute("aria-hidden"), "true");
    assert.ok(header.hasAttribute("inert"));

    // The dialog's own ancestor chain must stay fully reachable.
    assert.equal(main.hasAttribute("inert"), false, "an ancestor of the dialog must never be hidden");
    assert.equal(main.hasAttribute("aria-hidden"), false);
    assert.equal(dialog.hasAttribute("inert"), false, "the dialog itself must never be hidden");
  });
});

test("hideBackgroundFromAssistiveTech's cleanup function removes exactly what it added, restoring a prior aria-hidden value instead of stripping it", () => {
  withJsdom(() => {
    const { header, main, sibling1, dialog, sibling2 } = buildTree();
    // A decoy element that was already aria-hidden/inert for some unrelated
    // reason before the dialog ever opened (e.g. a disabled placeholder).
    sibling2.setAttribute("aria-hidden", "true");
    sibling2.setAttribute("inert", "");

    const restore = hideBackgroundFromAssistiveTech(dialog);
    restore();

    assert.equal(header.hasAttribute("aria-hidden"), false);
    assert.equal(header.hasAttribute("inert"), false);
    assert.equal(sibling1.hasAttribute("aria-hidden"), false);
    assert.equal(sibling1.hasAttribute("inert"), false);

    // sibling2's PRE-EXISTING state must survive the restore, not be wiped.
    assert.equal(sibling2.getAttribute("aria-hidden"), "true");
    assert.ok(sibling2.hasAttribute("inert"));

    assert.equal(main.hasAttribute("inert"), false);
    assert.equal(dialog.hasAttribute("inert"), false);
  });
});
