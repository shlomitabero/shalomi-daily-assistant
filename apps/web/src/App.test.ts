import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { transformSync } from "esbuild";
import type { AgentStepEvent, Entity, Project } from "@forge/shared";
import {
  filterAndSortProjects,
  formatProjectCreatedDate,
  formatRefineTimestamp,
  specProviderLabel,
  summarizeRefineImpact,
} from "./App.js";

const t = (key: string) => key;

test("summarizeRefineImpact reads the newEntities/changedEntities detail off the successful Architect event", () => {
  const events: AgentStepEvent[] = [
    { agent: "Architect", status: "running", message: "…" },
    {
      agent: "Architect",
      status: "success",
      message: "…",
      detail: {
        newEntities: [{ name: "Invoice", label: "Invoices" }],
        changedEntities: [{ name: "Customer", label: "Customers", newFieldNames: ["loyaltyPoints"] }],
      },
    },
  ];
  const summary = summarizeRefineImpact(events, t);
  assert.match(summary, /Invoices/);
  assert.match(summary, /Customers/);
  assert.match(summary, /loyaltyPoints/);
});

test("summarizeRefineImpact returns the no-summary key when no successful Architect event exists", () => {
  const events: AgentStepEvent[] = [{ agent: "Architect", status: "failed", message: "…" }];
  assert.equal(summarizeRefineImpact(events, t), "preview.refineHistory.noSummary");
});

test("summarizeRefineImpact prefers the LAST successful Architect event, not the first, so a Debug Agent recovery's corrected detail wins", () => {
  // Mirrors the real pipeline.ts behavior (architectEvent() called a
  // second time after a Debug Agent recovery, see the "Re-emit the
  // Architect summary after a Debug Agent recovery" commit): a
  // Database-step failure the Debug Agent fixes by renaming a field
  // yields a first, stale Architect success event (still describing the
  // broken name) followed by a second, corrected one. The refine-history
  // summary shown in chat must reflect the field that was actually built.
  const events: AgentStepEvent[] = [
    {
      agent: "Architect",
      status: "success",
      message: "…",
      detail: {
        newEntities: [],
        changedEntities: [{ name: "Customer", label: "Customers", newFieldNames: ["order; DROP TABLE x"] }],
      },
    },
    { agent: "Database", status: "failed", message: "…" },
    { agent: "Debug", status: "success", message: "…" },
    {
      agent: "Architect",
      status: "success",
      message: "…",
      detail: {
        newEntities: [],
        changedEntities: [{ name: "Customer", label: "Customers", newFieldNames: ["orderNote"] }],
      },
    },
  ];
  const summary = summarizeRefineImpact(events, t);
  assert.match(summary, /orderNote/);
  assert.doesNotMatch(summary, /DROP TABLE/);
});

/**
 * New in this round: a search box narrows "Your projects" by name once
 * there are enough of them to matter. filterAndSortProjects is the pure
 * function driving it -- case-insensitive substring match, then the same
 * pinned-first ordering pinnedProjects.test.ts already covers in
 * isolation, applied together in the order the UI actually needs them
 * (narrow first, THEN reorder what's left -- not the other way around,
 * which would still work here but is the more fragile order to compose in
 * general, e.g. if a future match ever depended on position).
 */
test("filterAndSortProjects narrows by a case-insensitive substring match on the project name", () => {
  const alpha = { ...makeProject([]), id: "p1", name: "Alpha CRM" };
  const beta = { ...makeProject([]), id: "p2", name: "Beta Inventory" };
  const gamma = { ...makeProject([]), id: "p3", name: "Gamma Scheduling" };
  const projects = [alpha, beta, gamma];

  assert.deepEqual(
    filterAndSortProjects(projects, "beta", new Set()).map((p) => p.id),
    ["p2"],
  );
  assert.deepEqual(
    filterAndSortProjects(projects, "CRM", new Set()).map((p) => p.id),
    ["p1"],
    "must match case-insensitively",
  );
  assert.deepEqual(
    filterAndSortProjects(projects, "  ", new Set()).map((p) => p.id),
    ["p1", "p2", "p3"],
    "a blank/whitespace-only query must show everything, not match nothing",
  );
  assert.deepEqual(filterAndSortProjects(projects, "nonexistent", new Set()), []);
});

test("filterAndSortProjects applies the pinned-first sort to whatever the search already narrowed down to", () => {
  const alpha = { ...makeProject([]), id: "p1", name: "Alpha Project" };
  const beta = { ...makeProject([]), id: "p2", name: "Beta Project" };
  const gamma = { ...makeProject([]), id: "p3", name: "Gamma Project" };
  const projects = [alpha, beta, gamma];

  assert.deepEqual(
    filterAndSortProjects(projects, "project", new Set(["gamma-does-not-exist"])).map((p) => p.id),
    ["p1", "p2", "p3"],
    "pinning an id not present in the list must not crash or reorder anything",
  );
  assert.deepEqual(
    filterAndSortProjects(projects, "project", new Set(["p3"])).map((p) => p.id),
    ["p3", "p1", "p2"],
    "the pinned match must move to the front of the already-narrowed results",
  );
});

/**
 * New in this round: each project card on the home screen now shows its own
 * creation date, so a returning user with several projects can tell at a
 * glance which is the recent one they were just working on vs. an old one
 * from months ago -- information the card never surfaced before. Confirms
 * the real locale each language actually renders with (matching the same
 * LOCALE-map convention HistoryPanel/CollaboratorsPanel/WhatsAppPanel
 * already use), not just that SOME string comes back.
 */
test("formatProjectCreatedDate renders a real locale-formatted date, in each language's own locale", () => {
  const createdAt = "2026-03-15T14:32:00.000Z";
  const expectedHe = new Date(createdAt).toLocaleDateString("he-IL");
  const expectedEn = new Date(createdAt).toLocaleDateString("en-US");

  assert.equal(formatProjectCreatedDate(createdAt, "he"), expectedHe);
  assert.equal(formatProjectCreatedDate(createdAt, "en"), expectedEn);
  assert.notEqual(
    formatProjectCreatedDate(createdAt, "he"),
    formatProjectCreatedDate(createdAt, "en"),
    "the two locales must not silently render the exact same string -- that would mean the language argument is being ignored",
  );
});

/**
 * New in this round: createProject's own response has always carried a
 * real providerName ("heuristic" / "anthropic" / "anthropic-fallback" --
 * see generateSpec's own doc comment in spec-engine), but the client only
 * ever destructured `{ project }` off it, discarding the one honest
 * signal for whether the spec was actually AI-generated, the deterministic
 * engine took over as normal, or a real AI failure silently degraded.
 * specProviderLabel is the pure mapping from that raw value to what the
 * spec-review screen actually shows.
 */
test("specProviderLabel maps each real providerName to its own distinct label, and null (a re-opened project) to no label at all", () => {
  assert.equal(specProviderLabel("anthropic", t), "spec.provider.ai");
  assert.equal(specProviderLabel("anthropic-fallback", t), "spec.provider.aiFallback");
  assert.equal(specProviderLabel("heuristic", t), "spec.provider.heuristic");
  assert.equal(
    specProviderLabel(null, t),
    null,
    "a re-opened existing project never captured this, so there's nothing honest to show -- must not silently claim any provider",
  );
  assert.notEqual(
    specProviderLabel("anthropic", t),
    specProviderLabel("anthropic-fallback", t),
    "a real AI failure that silently fell back must never be shown as an indistinguishable success",
  );
});

/**
 * New in this round: each entry in the refine history chat log (the
 * running record of every "Improve the app" instruction and its real
 * impact) never showed WHEN it happened -- with several refines in the
 * same session, there was no way to tell which was the one from five
 * minutes ago vs. the first one from an hour earlier. Confirms the real
 * locale/time each language actually renders with, not just that some
 * string comes back (mirrors formatProjectCreatedDate's own test above,
 * but toLocaleString -- date AND time -- since multiple refines can land
 * on the same day, unlike project creation dates).
 */
test("formatRefineTimestamp renders a real locale-formatted date+time, in each language's own locale", () => {
  const completedAt = "2026-03-15T14:32:00.000Z";
  const expectedHe = new Date(completedAt).toLocaleString("he-IL");
  const expectedEn = new Date(completedAt).toLocaleString("en-US");

  assert.equal(formatRefineTimestamp(completedAt, "he"), expectedHe);
  assert.equal(formatRefineTimestamp(completedAt, "en"), expectedEn);
  assert.notEqual(
    formatRefineTimestamp(completedAt, "he"),
    formatRefineTimestamp(completedAt, "en"),
    "the two locales must not silently render the exact same string -- that would mean the language argument is being ignored",
  );
});

/**
 * Regression test: each of the five overlay panels (History, Business
 * Twin, WhatsApp, Collaborators, Search) -- each a full-screen backdrop --
 * used to be opened by setting only its own "show" boolean to true, with no
 * regard for whether another panel's boolean was already true. Clicking,
 * say, "Business Twin" while History was already open (from an earlier
 * click, or Ctrl+K for search) stacked two full-screen overlays instead of
 * replacing one with the other. Extracts the real openPanel function from
 * App.tsx, strips its TypeScript with esbuild, and runs it with mock
 * setShowX functions to confirm every open closes the other four.
 */
test("App's openPanel closes every other overlay panel when opening one, instead of letting them stack", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(
    / {2}function openPanel\(panel: "history" \| "twin" \| "whatsapp" \| "collaborators" \| "search"\) \{[\s\S]*?\n {2}\}\n/,
  );
  assert.ok(handlerMatch, "expected to find openPanel in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(panel: string) {
    const state = { history: false, twin: false, whatsapp: false, collaborators: false, search: false };
    const fn = new Function(
      "setShowHistory",
      "setShowTwin",
      "setShowWhatsApp",
      "setShowCollaborators",
      "setShowSearch",
      `${code}\nreturn openPanel;`,
    )(
      (v: boolean) => (state.history = v),
      (v: boolean) => (state.twin = v),
      (v: boolean) => (state.whatsapp = v),
      (v: boolean) => (state.collaborators = v),
      (v: boolean) => (state.search = v),
    ) as (panel: string) => void;
    fn(panel);
    return state;
  }

  assert.deepEqual(run("history"), { history: true, twin: false, whatsapp: false, collaborators: false, search: false });
  assert.deepEqual(run("twin"), { history: false, twin: true, whatsapp: false, collaborators: false, search: false });
  assert.deepEqual(run("whatsapp"), { history: false, twin: false, whatsapp: true, collaborators: false, search: false });
  assert.deepEqual(run("collaborators"), { history: false, twin: false, whatsapp: false, collaborators: true, search: false });
  assert.deepEqual(run("search"), { history: false, twin: false, whatsapp: false, collaborators: false, search: true });
});

/**
 * Regression test for a real behavioral choice in openExistingProject
 * (the handler the new "Your projects" home-screen list uses to jump back
 * into a project someone already created or was added to as a
 * collaborator): a "built" project should open straight to the live
 * preview, but a project that was only ever created/answered but never
 * built has no real database behind it yet, so it must open to the spec
 * review screen instead -- opening a draft straight to "preview" would
 * show a live-preview screen with no working CRUD behind it. Extracts the
 * real function from App.tsx (not a reimplementation) the same way the
 * openPanel test above does.
 */
test("App's openExistingProject routes a built project to the live preview and a draft project back to spec review", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}function openExistingProject\(p: Project\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find openExistingProject in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(project: Project) {
    const state: { project: Project | null; activeEntity: string | null; view: string | null; specProvider: string | null } = {
      project: null,
      activeEntity: null,
      view: null,
      specProvider: "unset",
    };
    const fn = new Function(
      "setProject",
      "setActiveEntity",
      "setSpecProvider",
      "setView",
      `${code}\nreturn openExistingProject;`,
    )(
      (p: Project) => (state.project = p),
      (name: string | null) => (state.activeEntity = name),
      (v: string | null) => (state.specProvider = v),
      (v: string) => (state.view = v),
    ) as (p: Project) => void;
    fn(project);
    return state;
  }

  const builtProject = makeProject([makeEntity("Customer")]);
  builtProject.status = "built";
  assert.deepEqual(run(builtProject), { project: builtProject, activeEntity: "Customer", view: "preview", specProvider: null });

  const draftProject = makeProject([makeEntity("Customer")]);
  draftProject.status = "draft";
  assert.deepEqual(run(draftProject), { project: draftProject, activeEntity: "Customer", view: "spec", specProvider: null });
});

/**
 * Regression test for handleDeleteProject (the home-screen "Your
 * projects" list's delete button): a real, irreversible action gated
 * behind window.confirm -- declining the confirm must leave everything
 * untouched (no API call, myProjects list unchanged), while confirming
 * must call the real deleteProject API function and then remove exactly
 * the deleted project from myProjects, leaving every other project alone.
 * Extracts the real function from App.tsx the same way the openPanel and
 * openExistingProject tests above do, rather than reimplementing its logic.
 */
test("App's handleDeleteProject only calls the API and updates myProjects after window.confirm returns true, and leaves everything untouched when the user cancels", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}async function handleDeleteProject\(p: Project\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleDeleteProject in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(
    project: Project,
    initialMyProjects: Project[],
    opts: { confirmReturns: boolean; deleteProjectFn: (id: string) => Promise<void> },
  ) {
    const state: { myProjects: Project[]; deletingId: string | null; error: string | null } = {
      myProjects: initialMyProjects,
      deletingId: "not-yet-called",
      error: "not-yet-called",
    };
    const confirmCalls: string[] = [];
    const fn = new Function(
      "window",
      "t",
      "deleteProject",
      "setDeletingId",
      "setError",
      "setMyProjects",
      `${code}\nreturn handleDeleteProject;`,
    )(
      { confirm: (message: string) => (confirmCalls.push(message), opts.confirmReturns) },
      (key: string) => key,
      opts.deleteProjectFn,
      (v: string | null) => (state.deletingId = v),
      (v: string | null) => (state.error = v),
      (updater: (prev: Project[]) => Project[]) => (state.myProjects = updater(state.myProjects)),
    ) as (p: Project) => Promise<void>;
    return { fn, state, confirmCalls };
  }

  const target = makeProject([makeEntity("Customer")]);
  target.id = "delete-me";
  const other = makeProject([makeEntity("Customer")]);
  other.id = "keep-me";

  // Declining the confirm dialog must call neither the API nor any setter.
  let deleteApiCalls = 0;
  const declined = run(target, [target, other], {
    confirmReturns: false,
    deleteProjectFn: async () => {
      deleteApiCalls += 1;
    },
  });
  await declined.fn(target);
  assert.equal(deleteApiCalls, 0, "declining the confirm must never call the delete API");
  assert.deepEqual(declined.state.myProjects, [target, other], "myProjects must be untouched when cancelled");
  assert.equal(declined.state.deletingId, "not-yet-called", "setDeletingId must never be called when cancelled");

  // Confirming must call the real API function and remove only the deleted project.
  deleteApiCalls = 0;
  let deletedId: string | null = null;
  const confirmed = run(target, [target, other], {
    confirmReturns: true,
    deleteProjectFn: async (id: string) => {
      deleteApiCalls += 1;
      deletedId = id;
    },
  });
  await confirmed.fn(target);
  assert.equal(deleteApiCalls, 1);
  assert.equal(deletedId, "delete-me");
  assert.deepEqual(confirmed.state.myProjects, [other], "only the deleted project should be removed from the list");
  assert.equal(confirmed.state.deletingId, null, "deletingId must be cleared again once the delete finishes");
  assert.equal(confirmed.state.error, null);
});

function makeEntity(name: string): Entity {
  return { name, fields: [{ name: "name", type: "text", required: true }] };
}

function makeProject(entities: Entity[]): Project {
  return {
    id: "proj1",
    ownerId: "user1",
    name: "Test Project",
    description: "d",
    spec: {
      summary: "s",
      personas: [],
      roles: ["Admin"],
      entities,
      screens: [],
      assumptions: [],
      openQuestions: [],
    },
    status: "built",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Regression test: after a refine completes, handleBuildComplete kept
 * whatever entity tab was active before the refine ran unconditionally
 * (`setActiveEntity((prev) => prev ?? ...)` only falls back to the first
 * entity when `prev` was null in the first place -- otherwise it always
 * keeps `prev` as-is). A refine's regenerated spec is free to drop an
 * entity the previous one had (e.g. an instruction like "remove deals
 * tracking, focus on invoices"), so if the entity that was active before
 * the refine isn't in the new spec at all, the preview pane's own
 * `.filter((e) => e.name === activeEntity)` finds nothing -- the pane goes
 * blank with no tab visibly selected, exactly the "stale activeEntity"
 * failure mode handleLogout's own cleanup already guards against
 * elsewhere in this same file, just not here.
 */
test("App's handleBuildComplete falls back to the first entity when the previously-active one was dropped by a refine, but keeps it when it's still present", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}function handleBuildComplete\(builtProject: Project\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBuildComplete in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function runHandleBuildComplete(initialActiveEntity: string | null, builtProject: Project) {
    let activeEntity: string | null = initialActiveEntity;
    const fn = new Function(
      "refineRunning",
      "pendingRefineInstruction",
      "refineEvents",
      "t",
      "summarizeRefineImpact",
      "setRefineHistory",
      "setProject",
      "setActiveEntity",
      "setRefineText",
      "setAdditionalRequest",
      "setRefineRunning",
      "setView",
      `${code}\nreturn handleBuildComplete;`,
    )(
      false, // refineRunning: false keeps this focused on the activeEntity logic itself, which runs unconditionally either way
      { current: null },
      { current: [] },
      (key: string) => key,
      summarizeRefineImpact,
      () => {},
      () => {},
      (updater: string | null | ((prev: string | null) => string | null)) => {
        activeEntity = typeof updater === "function" ? (updater as (prev: string | null) => string | null)(activeEntity) : updater;
      },
      () => {},
      () => {},
      () => {},
      () => {},
    ) as (builtProject: Project) => void;
    fn(builtProject);
    return activeEntity;
  }

  const rebuiltWithoutDeal = makeProject([makeEntity("Customer"), makeEntity("Invoice")]);
  assert.equal(
    runHandleBuildComplete("Deal", rebuiltWithoutDeal),
    "Customer",
    "a dropped active entity must fall back to the new spec's first entity, not stay stale",
  );

  const rebuiltWithCustomer = makeProject([makeEntity("Invoice"), makeEntity("Customer")]);
  assert.equal(
    runHandleBuildComplete("Customer", rebuiltWithCustomer),
    "Customer",
    "an active entity that's still present in the new spec must be kept, not reset to the first one",
  );
});

/**
 * New in this round: the spec-review screen (the "Here's what we
 * understood" step between describing an idea and building it) had no way
 * back to the home screen at all -- only forward, via "Build the app".
 * Extracts the real handleBackToHome function the same way the other
 * App.tsx handler tests above do, and confirms it does the full, correct
 * reset: switches the view, clears the now-abandoned draft project and its
 * open-question answers/additional-request text (both tied to that
 * specific draft, not whatever gets created next) -- but does NOT touch
 * `description`, so the idea text the user already typed is still there
 * to tweak and resubmit rather than being wiped.
 */
test("App's handleBackToHome resets view/project/selectedAnswers/additionalRequest, but leaves description untouched", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}function handleBackToHome\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBackToHome in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const state: {
    view: string;
    project: Project | null;
    specProvider: string | null;
    selectedAnswers: Record<string, string>;
    additionalRequest: string;
  } = {
    view: "spec",
    project: makeProject([makeEntity("Customer")]),
    specProvider: "anthropic",
    selectedAnswers: { "Which plan?": "Pro" },
    additionalRequest: "also add a discount field",
  };

  let setDescriptionCalls = 0;
  const fn = new Function(
    "setView",
    "setProject",
    "setSpecProvider",
    "setSelectedAnswers",
    "setAdditionalRequest",
    "setDescription",
    `${code}\nreturn handleBackToHome;`,
  )(
    (v: string) => (state.view = v),
    (p: Project | null) => (state.project = p),
    (v: string | null) => (state.specProvider = v),
    (a: Record<string, string>) => (state.selectedAnswers = a),
    (r: string) => (state.additionalRequest = r),
    () => {
      setDescriptionCalls += 1;
    },
  ) as () => void;

  fn();

  assert.equal(state.view, "home", "must navigate back to the home view");
  assert.equal(state.project, null, "must clear the abandoned draft project, not leave it lingering in state");
  assert.equal(state.specProvider, null, "must clear the abandoned draft's own spec-provider info, not leave it lingering for whatever gets created next");
  assert.deepEqual(state.selectedAnswers, {}, "must clear answers tied to the abandoned draft's own open questions");
  assert.equal(state.additionalRequest, "", "must clear the additional-request text tied to the abandoned draft");
  assert.equal(setDescriptionCalls, 0, "must never touch description -- the typed idea text should survive going back");
});
