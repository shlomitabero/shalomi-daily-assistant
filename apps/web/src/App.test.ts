import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { transformSync } from "esbuild";
import type { AgentStepEvent, Entity, Field, OpenQuestion, Project } from "@forge/shared";
import type { AutomationRuleView, WhatsAppMessageLogEntry } from "./api.js";
import {
  canNavigateHome,
  countAnsweredOpenQuestions,
  filterAndSortProjects,
  filterProjectsByStatus,
  filterRefineHistory,
  formatEntityFieldSummary,
  formatMyProjectsCount,
  enhanceProviderLabel,
  extractRefineProviderName,
  formatOpenQuestionsProgress,
  formatProjectCreatedDate,
  formatRefineTimestamp,
  isEditableEventTarget,
  maybeNotifyFailingAutomations,
  maybeNotifyNewWhatsAppMessages,
  removeRefineHistoryEntry,
  specProviderLabel,
  summarizeRefineImpact,
} from "./App.js";
import { reorderColumns } from "./columnOrder.js";
import { translate } from "./i18n/language.js";
import { visibleSelectedIds } from "./projectSelection.js";

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

/**
 * Regression test for a real gap found by round 377's Explore survey:
 * pipeline.ts's computeImpact now reports entities the refine dropped
 * from the spec (see pipeline.test.ts), but that detail is useless if
 * nothing in the UI ever reads it. Confirms the refine-history chat
 * summary (not just the live AI Team screen's own detail panel) surfaces
 * a removed entity, not just newEntities/changedEntities.
 */
test("summarizeRefineImpact reports an entity the refine dropped from the spec, not just what it added or changed", () => {
  const events: AgentStepEvent[] = [
    {
      agent: "Architect",
      status: "success",
      message: "…",
      detail: {
        newEntities: [],
        changedEntities: [],
        removedEntities: [{ name: "Deal", label: "Deal" }],
      },
    },
  ];
  const summary = summarizeRefineImpact(events, t);
  assert.match(summary, /Deal/);
  assert.match(summary, /build\.detail\.architect\.entityRemoved/);
});

/**
 * Regression test for a real gap found by round 397's Explore survey:
 * computeImpact's changedEntities (pipeline.ts) already computed
 * removedFieldNames alongside newFieldNames, but this chat-history
 * summary never read it -- an entity that only lost a field (gained
 * nothing) rendered an empty "gained new fields: " part with nothing
 * after the colon, the exact same gap as BuildProgress.tsx's own panel.
 */
test("summarizeRefineImpact reports a field the refine dropped from an entity that still exists, not an empty 'gained fields' part", () => {
  const events: AgentStepEvent[] = [
    {
      agent: "Architect",
      status: "success",
      message: "…",
      detail: {
        newEntities: [],
        changedEntities: [{ name: "Order", label: "Order", newFieldNames: [], removedFieldNames: ["notes"] }],
      },
    },
  ];
  const summary = summarizeRefineImpact(events, t);
  assert.match(summary, /Order/);
  assert.match(summary, /notes/);
  assert.match(summary, /build\.detail\.architect\.lostFields/);
  assert.doesNotMatch(
    summary,
    /build\.detail\.architect\.gainedFields/,
    "an entity that only lost a field must not produce an empty 'gained fields' part implying it gained something",
  );
});

/**
 * Regression test for a real gap found by round 398's Explore survey:
 * computeImpact's changedEntities (pipeline.ts) now also computes
 * tightenedFieldNames for a field that became required or lost an enum
 * value, but this chat-history summary never read it -- an entity whose
 * only change was a tightened field produced no summary part at all, the
 * same gap as BuildProgress.tsx's own panel.
 */
test("summarizeRefineImpact reports a field the refine tightened on an entity that still exists", () => {
  const events: AgentStepEvent[] = [
    {
      agent: "Architect",
      status: "success",
      message: "…",
      detail: {
        newEntities: [],
        changedEntities: [{ name: "Deal", label: "Deal", newFieldNames: [], tightenedFieldNames: ["title", "stage"] }],
      },
    },
  ];
  const summary = summarizeRefineImpact(events, t);
  assert.match(summary, /Deal/);
  assert.match(summary, /title/);
  assert.match(summary, /stage/);
  assert.match(summary, /build\.detail\.architect\.tightenedFields/);
});

function question(text: string): OpenQuestion {
  return { question: text, options: ["Yes", "No"] };
}

test("countAnsweredOpenQuestions counts a question answered whether the value came from a chip click or the free-text input, since both write the same selectedAnswers slot", () => {
  const questions = [question("Q1"), question("Q2"), question("Q3")];
  const result = countAnsweredOpenQuestions(questions, { "0": "Yes", "1": "a custom answer" });
  assert.deepEqual(result, { answered: 2, total: 3 });
});

test("countAnsweredOpenQuestions treats a blank or whitespace-only value as unanswered", () => {
  const questions = [question("Q1"), question("Q2")];
  const result = countAnsweredOpenQuestions(questions, { "0": "   ", "1": "" });
  assert.deepEqual(result, { answered: 0, total: 2 });
});

test("countAnsweredOpenQuestions returns zero total for a spec with no open questions", () => {
  assert.deepEqual(countAnsweredOpenQuestions([], {}), { answered: 0, total: 0 });
});

/**
 * Round 776: selectedAnswers is keyed by each question's own array index,
 * not its text, specifically so two unrelated open questions that happen
 * to share identical wording (OpenQuestionSchema has no uniqueness
 * constraint, unlike entity names) don't collide on the same slot. Before
 * that fix, keying by `q.question` meant the SECOND of two
 * identically-worded questions would already read as answered the moment
 * the first one was, from a single click -- this confirms they're now
 * counted independently, by position.
 */
test("countAnsweredOpenQuestions counts two identically-worded questions independently, by position, not by colliding on their shared text", () => {
  const questions = [question("Which plan?"), question("Which plan?")];
  const result = countAnsweredOpenQuestions(questions, { "0": "Pro" });
  assert.deepEqual(result, { answered: 1, total: 2 }, "only the first of the two identically-worded questions was actually answered");
});

test("formatOpenQuestionsProgress picks the 'none answered' phrasing when nothing is answered yet", () => {
  const questions = [question("Q1"), question("Q2")];
  const tr = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(formatOpenQuestionsProgress(questions, {}, tr), "You haven't answered any of the 2 questions yet — that's fine, they're optional");
});

test("formatOpenQuestionsProgress picks the 'answered N of M' phrasing partway through", () => {
  const questions = [question("Q1"), question("Q2"), question("Q3")];
  const tr = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(formatOpenQuestionsProgress(questions, { "0": "Yes" }, tr), "Answered 1 of 3 questions");
});

test("formatOpenQuestionsProgress picks the 'all answered' phrasing once every question has a value, in Hebrew", () => {
  const questions = [question("Q1"), question("Q2")];
  const tr = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  assert.equal(formatOpenQuestionsProgress(questions, { "0": "כן", "1": "לא" }, tr), "ענית על כל 2 השאלות ✓");
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
 * Regression test for round 406: /refine calls the exact same
 * generateSpec() as project creation and the enhance step, but discarded
 * its providerName entirely until now -- pipeline.ts's runBuildPipeline
 * attaches it to the very first ("Architect"/"running") event's own
 * `detail`, and this is the client-side counterpart that reads it back
 * out of a completed refine's raw event list.
 */
test("extractRefineProviderName reads providerName off the first Architect/running event's detail", () => {
  const events: AgentStepEvent[] = [
    { agent: "Architect", status: "running", message: "…", detail: { providerName: "anthropic-fallback" } },
    { agent: "Architect", status: "success", message: "…", detail: { newEntities: [], changedEntities: [] } },
  ];
  assert.equal(extractRefineProviderName(events), "anthropic-fallback");
});

test("extractRefineProviderName returns null when the first event has no detail at all (a plain /build run, which never passes providerName)", () => {
  const events: AgentStepEvent[] = [
    { agent: "Architect", status: "running", message: "…" },
    { agent: "Architect", status: "success", message: "…", detail: { newEntities: [], changedEntities: [] } },
  ];
  assert.equal(extractRefineProviderName(events), null);
});

test("extractRefineProviderName returns null for an empty event list instead of throwing", () => {
  assert.equal(extractRefineProviderName([]), null);
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
 * New in this round: "Your projects" only ever had one real order
 * (newest-first, per listProjectsForUser's own createdAt DESC) with no
 * way to switch to alphabetical. sortMode defaults to "recent" (the
 * existing behavior, untouched) so every call above this in the file
 * keeps working unchanged; "alphabetical" sorts by name WITHIN each of
 * sortByPinned's own pinned/unpinned groups, rather than abandoning
 * pinning -- a pinned project still floats to the top even in
 * alphabetical mode, just alphabetized among the other pinned ones.
 */
test("filterAndSortProjects's 'alphabetical' sortMode sorts by name within each pinned/unpinned group, keeping pinned projects on top", () => {
  const zed = { ...makeProject([]), id: "p1", name: "Zed Project" };
  const amy = { ...makeProject([]), id: "p2", name: "Amy Project" };
  const mid = { ...makeProject([]), id: "p3", name: "Mid Project" };
  const projects = [zed, amy, mid];

  assert.deepEqual(
    filterAndSortProjects(projects, "", new Set(), "alphabetical").map((p) => p.id),
    ["p2", "p3", "p1"],
    "with nothing pinned, 'alphabetical' must sort every project by name: Amy, Mid, Zed",
  );

  assert.deepEqual(
    filterAndSortProjects(projects, "", new Set(["p1"]), "alphabetical").map((p) => p.id),
    ["p1", "p2", "p3"],
    "pinning Zed must still float it to the very top even in alphabetical mode -- pinning always wins over the name sort",
  );

  assert.deepEqual(
    filterAndSortProjects(projects, "", new Set(), "recent").map((p) => p.id),
    ["p1", "p2", "p3"],
    "'recent' (the default) must leave the original createdAt-DESC order untouched, not silently alphabetize it",
  );
});

test("formatMyProjectsCount reports a plain total when nothing is filtered out", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(formatMyProjectsCount(5, 5, tr), "5 projects");
});

test("formatMyProjectsCount reports 'shown of total' once a search has narrowed the list, in Hebrew", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  assert.equal(formatMyProjectsCount(2, 8, tr), "2 מתוך 8 פרויקטים");
});

/**
 * New in this round: the "Draft" chip (round 149) marks a not-yet-built
 * project one card at a time, but with enough projects there was no way to
 * see only the drafts, or hide them entirely -- filterProjectsByStatus is
 * the pure function driving the new status-filter dropdown on the home
 * screen, mirroring filterCheckpointsByType's own "all" passthrough
 * convention (checkpointDiff.ts) rather than inventing a new one.
 */
test("filterProjectsByStatus passes every project through untouched for 'all'", () => {
  const built = { ...makeProject([]), id: "p1", status: "built" as const };
  const draft = { ...makeProject([]), id: "p2", status: "draft" as const };
  assert.deepEqual(filterProjectsByStatus([built, draft], "all").map((p) => p.id), ["p1", "p2"]);
});

test("filterProjectsByStatus narrows to only the built projects, or only the drafts", () => {
  const built = { ...makeProject([]), id: "p1", status: "built" as const };
  const draft = { ...makeProject([]), id: "p2", status: "draft" as const };
  const projects = [built, draft];

  assert.deepEqual(filterProjectsByStatus(projects, "built").map((p) => p.id), ["p1"]);
  assert.deepEqual(filterProjectsByStatus(projects, "draft").map((p) => p.id), ["p2"]);
});

test("filterProjectsByStatus composes with filterAndSortProjects the same way the home screen actually calls them -- status filter first, then search+sort", () => {
  const builtAlpha = { ...makeProject([]), id: "p1", name: "Alpha", status: "built" as const };
  const draftAlpha = { ...makeProject([]), id: "p2", name: "Alpha Draft", status: "draft" as const };
  const draftBeta = { ...makeProject([]), id: "p3", name: "Beta Draft", status: "draft" as const };
  const projects = [builtAlpha, draftAlpha, draftBeta];

  const drafts = filterAndSortProjects(filterProjectsByStatus(projects, "draft"), "alpha", new Set());
  assert.deepEqual(
    drafts.map((p) => p.id),
    ["p2"],
    "must apply the status filter AND the search narrowing together, not just one of the two",
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
 * Round 402: enhanceIdea's own response carries the exact same honest
 * providerName signal as createProject's (see enhancePrompt's doc comment
 * in spec-engine), but handleEnhanceAndBuild only ever destructured
 * `{ enhanced }` off it, discarding whether the idea rewrite itself came
 * from real AI or the offline heuristic silently took over -- the same
 * gap specProviderLabel closed for the later build step, left unfixed one
 * function below it. enhanceProviderLabel is the pure mapping, mirroring
 * specProviderLabel's own shape exactly.
 */
test("enhanceProviderLabel maps each real providerName to its own distinct label, and null (no enhance step used) to no label at all", () => {
  assert.equal(enhanceProviderLabel("anthropic", t), "enhance.provider.ai");
  assert.equal(enhanceProviderLabel("anthropic-fallback", t), "enhance.provider.aiFallback");
  assert.equal(enhanceProviderLabel("heuristic", t), "enhance.provider.heuristic");
  assert.equal(
    enhanceProviderLabel(null, t),
    null,
    "a plain (non-enhanced) build never captured this, so there's nothing honest to show -- must not silently claim any provider",
  );
  assert.notEqual(
    enhanceProviderLabel("anthropic", t),
    enhanceProviderLabel("anthropic-fallback", t),
    "a real AI failure during the rewrite that silently fell back must never be shown as an indistinguishable success",
  );
});

/**
 * Round 402: handleEnhanceAndBuild makes two separate provider-tagged API
 * calls (enhanceIdea, then createProject on the rewritten text) -- this
 * confirms each one's own providerName lands in its own separate state
 * (enhanceProvider vs specProvider), rather than the enhance step's signal
 * being silently discarded the way it was before this round. Extracts the
 * real function from App.tsx the same way the handleDeleteProject test
 * above does, mocking both API calls.
 */
test("App's handleEnhanceAndBuild captures enhanceIdea's own providerName into enhanceProvider, separately from createProject's into specProvider", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}async function handleEnhanceAndBuild\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleEnhanceAndBuild in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(opts: {
    enhanceIdeaFn: (idea: string) => Promise<{ enhanced: string; providerName: string }>;
    createProjectFn: (description: string) => Promise<{ project: Project; providerName: string }>;
    busy?: boolean;
    templateBusy?: string | null;
  }) {
    const state: {
      description: string;
      project: Project | null;
      specProvider: string | null;
      enhanceProvider: string | null;
      view: string | null;
      enhanceBusy: boolean;
      error: string | null;
    } = {
      description: "a crm for my shop",
      project: null,
      specProvider: "unset",
      enhanceProvider: "unset",
      view: null,
      enhanceBusy: false,
      error: null,
    };
    const fn = new Function(
      "description",
      "user",
      "busy",
      "templateBusy",
      "setEnhanceBusy",
      "setError",
      "enhanceIdea",
      "setDescription",
      "saveIdeaDraft",
      "setEnhanceProvider",
      "createProject",
      "setProject",
      "setMyRole",
      "setSpecProvider",
      "setView",
      `${code}\nreturn handleEnhanceAndBuild;`,
    )(
      state.description,
      { id: "user1" },
      opts.busy ?? false,
      opts.templateBusy ?? null,
      (v: boolean) => (state.enhanceBusy = v),
      (v: string | null) => (state.error = v),
      opts.enhanceIdeaFn,
      (v: string) => (state.description = v),
      (_userId: string, _v: string) => {},
      (v: string | null) => (state.enhanceProvider = v),
      opts.createProjectFn,
      (p: Project) => (state.project = p),
      (_role: string) => {},
      (v: string | null) => (state.specProvider = v),
      (v: string) => (state.view = v),
    ) as () => Promise<void>;
    return { fn, state };
  }

  const builtProject = makeProject([makeEntity("Customer")]);
  const { fn, state } = run({
    enhanceIdeaFn: async () => ({ enhanced: "a detailed CRM idea", providerName: "anthropic-fallback" }),
    createProjectFn: async () => ({ project: builtProject, providerName: "anthropic" }),
  });
  await fn();

  assert.equal(state.enhanceProvider, "anthropic-fallback", "the enhance step's own providerName must land in enhanceProvider");
  assert.equal(state.specProvider, "anthropic", "the later createProject call's providerName must land in specProvider, independently of enhanceProvider");
  assert.notEqual(
    state.enhanceProvider,
    state.specProvider,
    "the two calls' provider signals must never be conflated into one -- each step can independently succeed or fall back",
  );
  assert.equal(state.description, "a detailed CRM idea", "the enhanced text must replace the original description");
  assert.equal(state.project, builtProject);
  assert.equal(state.view, "spec");
});

/**
 * Round 1131: this home screen has three independent project-creation
 * entry points (handleDescribe/busy; this handler/enhanceBusy;
 * handleUseTemplate/templateBusy), none of which used to block the other
 * two -- a user could click Build, then (while that request was still in
 * flight) click Enhance & Build, firing two independent, real
 * POST /projects.../POST /projects/from-template calls that both end by
 * writing to the exact same shared project/view state. Confirms
 * handleEnhanceAndBuild now refuses to run at all -- neither enhanceIdea
 * nor createProject is even called -- when either sibling flag is
 * already busy, mirroring the identical cross-gate convention this file
 * already established for handleDeleteProject/handleDuplicateProject/
 * handleBulkDeleteProjects (rounds 1041/1043).
 */
test("App's handleEnhanceAndBuild refuses to run while the Build submit button or a template card is already busy", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}async function handleEnhanceAndBuild\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleEnhanceAndBuild in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(opts: { busy?: boolean; templateBusy?: string | null }) {
    const state = { enhanceIdeaCalled: false, createProjectCalled: false, enhanceBusySet: "untouched" as unknown };
    const fn = new Function(
      "description",
      "user",
      "busy",
      "templateBusy",
      "setEnhanceBusy",
      "setError",
      "enhanceIdea",
      "setDescription",
      "saveIdeaDraft",
      "setEnhanceProvider",
      "createProject",
      "setProject",
      "setMyRole",
      "setSpecProvider",
      "setView",
      `${code}\nreturn handleEnhanceAndBuild;`,
    )(
      "a crm for my shop",
      { id: "user1" },
      opts.busy ?? false,
      opts.templateBusy ?? null,
      (v: boolean) => (state.enhanceBusySet = v),
      () => {},
      async () => {
        state.enhanceIdeaCalled = true;
        return { enhanced: "x", providerName: "anthropic" };
      },
      () => {},
      () => {},
      () => {},
      async () => {
        state.createProjectCalled = true;
        return { project: makeProject([]), providerName: "anthropic" };
      },
      () => {},
      () => {},
      () => {},
      () => {},
    ) as () => Promise<void>;
    return { fn, state };
  }

  const { fn: fnWhileBuildBusy, state: stateWhileBuildBusy } = run({ busy: true });
  await fnWhileBuildBusy();
  assert.equal(stateWhileBuildBusy.enhanceIdeaCalled, false, "must never call enhanceIdea while the plain Build submit is already in flight");
  assert.equal(stateWhileBuildBusy.createProjectCalled, false, "must never call createProject either");
  assert.equal(stateWhileBuildBusy.enhanceBusySet, "untouched", "must not even set its own busy flag, since it never started");

  const { fn: fnWhileTemplateBusy, state: stateWhileTemplateBusy } = run({ templateBusy: "template-1" });
  await fnWhileTemplateBusy();
  assert.equal(stateWhileTemplateBusy.enhanceIdeaCalled, false, "must never call enhanceIdea while a template card is already in flight");
  assert.equal(stateWhileTemplateBusy.createProjectCalled, false, "must never call createProject either");
});

/**
 * Round 1131: handleDescribe (the plain Build submit button) is the third
 * leg of the same three-way cross-gate -- see handleEnhanceAndBuild's own
 * identical test just above for the full race this closes. No dedicated
 * extracted-function test existed for handleDescribe before this round.
 */
test("App's handleDescribe refuses to run while Enhance & Build or a template card is already busy, but still runs normally otherwise", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}async function handleDescribe\(e: React\.FormEvent\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleDescribe in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(opts: { enhanceBusy?: boolean; templateBusy?: string | null }) {
    const state = { createProjectCalled: false, busySet: "untouched" as unknown, viewSet: "untouched" as unknown, preventDefaultCalled: false };
    const fn = new Function(
      "description",
      "enhanceBusy",
      "templateBusy",
      "setBusy",
      "setError",
      "createProject",
      "setProject",
      "setMyRole",
      "setSpecProvider",
      "setEnhanceProvider",
      "setView",
      `${code}\nreturn handleDescribe;`,
    )(
      "a crm for my shop",
      opts.enhanceBusy ?? false,
      opts.templateBusy ?? null,
      (v: boolean) => (state.busySet = v),
      () => {},
      async () => {
        state.createProjectCalled = true;
        return { project: makeProject([]), providerName: "anthropic" };
      },
      () => {},
      () => {},
      () => {},
      () => {},
      (v: string) => (state.viewSet = v),
    ) as (e: { preventDefault: () => void }) => Promise<void>;
    return { fn, state };
  }

  const fakeEvent = { preventDefault: () => {} };

  const { fn: fnWhileEnhanceBusy, state: stateWhileEnhanceBusy } = run({ enhanceBusy: true });
  await fnWhileEnhanceBusy(fakeEvent);
  assert.equal(stateWhileEnhanceBusy.createProjectCalled, false, "must never call createProject while Enhance & Build is already in flight");
  assert.equal(stateWhileEnhanceBusy.busySet, "untouched", "must not even set its own busy flag, since it never started");

  const { fn: fnWhileTemplateBusy, state: stateWhileTemplateBusy } = run({ templateBusy: "template-1" });
  await fnWhileTemplateBusy(fakeEvent);
  assert.equal(stateWhileTemplateBusy.createProjectCalled, false, "must never call createProject while a template card is already in flight");

  const { fn: fnNormally, state: stateNormally } = run({});
  await fnNormally(fakeEvent);
  assert.equal(stateNormally.createProjectCalled, true, "must still run normally when neither sibling flag is busy");
  assert.equal(stateNormally.viewSet, "spec", "must still navigate to the spec screen on success");
});

/**
 * Round 1131: handleUseTemplate (the Templates Gallery's own one-click
 * path) is the third leg of the same three-way cross-gate, from the
 * opposite direction -- confirms it now refuses to even set its own
 * templateBusy flag while the plain Build or Enhance & Build button is
 * already in flight, closing the one direction of the race the subagent's
 * own report called out explicitly ("Use this template" used to check
 * only its own flag).
 */
test("App's handleUseTemplate refuses to run while the Build submit button or Enhance & Build is already busy, but still runs normally otherwise", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}async function handleUseTemplate\(templateId: string\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleUseTemplate in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(opts: { busy?: boolean; enhanceBusy?: boolean }) {
    const state = { createProjectFromTemplateCalled: false, templateBusySet: "untouched" as unknown, viewSet: "untouched" as unknown };
    const fn = new Function(
      "busy",
      "enhanceBusy",
      "setTemplateBusy",
      "setError",
      "createProjectFromTemplate",
      "lang",
      "setProject",
      "setMyRole",
      "setSpecProvider",
      "setEnhanceProvider",
      "setView",
      `${code}\nreturn handleUseTemplate;`,
    )(
      opts.busy ?? false,
      opts.enhanceBusy ?? false,
      (v: string | null) => (state.templateBusySet = v),
      () => {},
      async () => {
        state.createProjectFromTemplateCalled = true;
        return { project: makeProject([]) };
      },
      "en",
      () => {},
      () => {},
      () => {},
      () => {},
      (v: string) => (state.viewSet = v),
    ) as (templateId: string) => Promise<void>;
    return { fn, state };
  }

  const { fn: fnWhileBuildBusy, state: stateWhileBuildBusy } = run({ busy: true });
  await fnWhileBuildBusy("template-1");
  assert.equal(stateWhileBuildBusy.createProjectFromTemplateCalled, false, "must never call createProjectFromTemplate while the plain Build submit is already in flight");
  assert.equal(stateWhileBuildBusy.templateBusySet, "untouched", "must not even set its own templateBusy flag, since it never started");

  const { fn: fnWhileEnhanceBusy, state: stateWhileEnhanceBusy } = run({ enhanceBusy: true });
  await fnWhileEnhanceBusy("template-1");
  assert.equal(stateWhileEnhanceBusy.createProjectFromTemplateCalled, false, "must never call createProjectFromTemplate while Enhance & Build is already in flight");

  const { fn: fnNormally, state: stateNormally } = run({});
  await fnNormally("template-1");
  assert.equal(stateNormally.createProjectFromTemplateCalled, true, "must still run normally when neither sibling flag is busy");
  assert.equal(stateNormally.viewSet, "spec", "must still navigate to the spec screen on success");
});

/**
 * Regression test for round 407: POST /projects/:id/answers calls the
 * exact same generateSpec() as project creation and /refine (round 406),
 * but until now its own providerName -- round 406's own open follow-up --
 * was discarded on the client the same way /refine's was before that
 * round. Unlike /refine, /answers has no dedicated history to show it in;
 * instead handleBuild now overwrites the existing specProvider state with
 * this second generateSpec() call's own result (when the user actually
 * answered something, since /answers never calls generateSpec() at all in
 * the no-op case), so it's shown on the very next screen (BuildProgress's
 * own specProviderNotice) rather than nowhere at all.
 */
test("App's handleBuild overwrites specProvider with the /answers call's own providerName when the user answered something, but leaves it untouched (and never calls answerQuestions) when there was nothing to answer", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}async function handleBuild\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBuild in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(
    project: Project,
    selectedAnswers: Record<string, string>,
    additionalRequest: string,
    answerQuestionsFn: (
      projectId: string,
      answers: { question: string; answer: string }[],
      additionalRequest?: string,
    ) => Promise<{ project: Project; providerName?: string }>,
  ) {
    const state: { project: Project | null; specProvider: string | null; view: string | null; busy: boolean; error: string | null; calls: number } = {
      project,
      specProvider: "anthropic",
      view: null,
      busy: false,
      error: null,
      calls: 0,
    };
    const fn = new Function(
      "project",
      "selectedAnswers",
      "additionalRequest",
      "setBusy",
      "setError",
      "answerQuestions",
      "setProject",
      "setSpecProvider",
      "setBuildWarning",
      "setView",
      `${code}\nreturn handleBuild;`,
    )(
      state.project,
      selectedAnswers,
      additionalRequest,
      (v: boolean) => (state.busy = v),
      (v: string | null) => (state.error = v),
      (...args: [string, { question: string; answer: string }[], string | undefined]) => {
        state.calls += 1;
        return answerQuestionsFn(...args);
      },
      (p: Project) => (state.project = p),
      (v: string | null) => (state.specProvider = v),
      () => {},
      (v: string) => (state.view = v),
    ) as () => Promise<void>;
    return { fn, state };
  }

  const project = makeProject([makeEntity("Customer")]);
  project.spec.openQuestions = [{ question: "Use Stripe?", options: ["Yes", "No"] }];
  const answeredProject = makeProject([makeEntity("Customer"), makeEntity("Invoice")]);

  const { fn: fnWithAnswers, state: stateWithAnswers } = run(project, { "0": "yes" }, "", async () => ({
    project: answeredProject,
    providerName: "anthropic-fallback",
  }));
  await fnWithAnswers();
  assert.equal(stateWithAnswers.calls, 1, "answering a question must call answerQuestions");
  assert.equal(stateWithAnswers.specProvider, "anthropic-fallback", "the /answers call's own providerName must overwrite the stale specProvider from project creation");
  assert.equal(stateWithAnswers.project, answeredProject);
  assert.equal(stateWithAnswers.view, "building");

  const { fn: fnNoAnswers, state: stateNoAnswers } = run(project, {}, "", async () => ({
    project: answeredProject,
    providerName: "anthropic-fallback",
  }));
  await fnNoAnswers();
  assert.equal(stateNoAnswers.calls, 0, "nothing was answered, so answerQuestions must never be called at all");
  assert.equal(stateNoAnswers.specProvider, "anthropic", "with nothing answered, the original specProvider from project creation must be left exactly as it was");
  assert.equal(stateNoAnswers.view, "building");
});

/**
 * Round 776: handleBuild used to build its `answers` payload straight from
 * `Object.entries(selectedAnswers)`, keyed by question TEXT -- so two open
 * questions sharing identical wording (OpenQuestionSchema has no
 * uniqueness constraint) could never both be sent; the second answer
 * always silently overwrote the first in the plain JS object itself,
 * before the request even left the browser. Confirms the fix: each
 * question's answer is now looked up by its own array index, and sent as
 * an array of distinct {question, answer} pairs -- so two
 * identically-worded questions each keep their own answer.
 */
test("App's handleBuild sends each open question's own answer by position, so two identically-worded questions don't collapse into one", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}async function handleBuild\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBuild in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const project = makeProject([makeEntity("Customer")]);
  project.spec.openQuestions = [
    { question: "Which plan?", options: ["Pro", "Basic"] },
    { question: "Which plan?", options: ["Pro", "Basic"] },
  ];

  let capturedAnswers: { question: string; answer: string }[] | undefined;
  const state: { project: Project | null; specProvider: string | null; view: string | null } = {
    project,
    specProvider: "anthropic",
    view: null,
  };
  const fn = new Function(
    "project",
    "selectedAnswers",
    "additionalRequest",
    "setBusy",
    "setError",
    "answerQuestions",
    "setProject",
    "setSpecProvider",
    "setBuildWarning",
    "setView",
    `${code}\nreturn handleBuild;`,
  )(
    state.project,
    { "0": "Basic", "1": "Pro" },
    "",
    () => {},
    () => {},
    async (_projectId: string, answers: { question: string; answer: string }[]) => {
      capturedAnswers = answers;
      return { project, providerName: "anthropic-fallback" };
    },
    (p: Project) => (state.project = p),
    (v: string | null) => (state.specProvider = v),
    () => {},
    (v: string) => (state.view = v),
  ) as () => Promise<void>;

  await fn();

  assert.deepEqual(
    capturedAnswers,
    [
      { question: "Which plan?", answer: "Basic" },
      { question: "Which plan?", answer: "Pro" },
    ],
    "each identically-worded question must keep its own distinct answer, not collapse into one shared value",
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
 * New in this round: once the conversation-history pane's own refine list
 * (see refineHistory in App.tsx) passes 5 entries, a search box narrows it
 * by instruction text -- the same "Your projects" (filterAndSortProjects)
 * and Time Machine (checkpointDiff.ts's filterCheckpoints) convention,
 * applied to this screen's own unbounded, never-cleared list.
 */
test("filterRefineHistory narrows by a case-insensitive substring match on the instruction text", () => {
  const invoices = { id: "r1", instruction: "Add invoice tracking", summary: "s", completedAt: "2026-01-01", providerName: null };
  const coupons = { id: "r2", instruction: "Add a coupons entity", summary: "s", completedAt: "2026-01-02", providerName: null };
  const reviews = { id: "r3", instruction: "Track customer reviews", summary: "s", completedAt: "2026-01-03", providerName: null };
  const entries = [invoices, coupons, reviews];

  assert.deepEqual(
    filterRefineHistory(entries, "invoice").map((e) => e.id),
    ["r1"],
  );
  assert.deepEqual(
    filterRefineHistory(entries, "COUPONS").map((e) => e.id),
    ["r2"],
    "must match case-insensitively",
  );
  assert.deepEqual(
    filterRefineHistory(entries, "  ").map((e) => e.id),
    ["r1", "r2", "r3"],
    "a blank/whitespace-only query must show everything, not match nothing",
  );
  assert.deepEqual(filterRefineHistory(entries, "nonexistent"), []);
});

test("removeRefineHistoryEntry drops only the matching entry, leaving the rest (and their order) untouched", () => {
  const entries = [
    { id: "r1", instruction: "Add invoice tracking", summary: "s", completedAt: "2026-01-01", providerName: null },
    { id: "r2", instruction: "Add a coupons entity", summary: "s", completedAt: "2026-01-02", providerName: null },
    { id: "r3", instruction: "Track customer reviews", summary: "s", completedAt: "2026-01-03", providerName: null },
  ];

  assert.deepEqual(
    removeRefineHistoryEntry(entries, "r2").map((e) => e.id),
    ["r1", "r3"],
  );
  assert.deepEqual(
    removeRefineHistoryEntry(entries, "nonexistent").map((e) => e.id),
    ["r1", "r2", "r3"],
    "removing an id that isn't in the list must be a no-op, not throw or drop something else",
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
test("App's openPanel closes every other overlay panel when opening one, instead of letting them stack, and zeroes the WhatsApp unread badge only when opening the WhatsApp panel", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(
    / {2}function openPanel\(panel: "history" \| "twin" \| "whatsapp" \| "automations" \| "collaborators" \| "search" \| "shortcuts"\) \{[\s\S]*?\n {2}\}\n/,
  );
  assert.ok(handlerMatch, "expected to find openPanel in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(panel: string) {
    const state = {
      history: false,
      twin: false,
      whatsapp: false,
      automations: false,
      collaborators: false,
      search: false,
      shortcuts: false,
      whatsappUnreadResetCalls: 0,
    };
    const fn = new Function(
      "setShowHistory",
      "setShowTwin",
      "setShowWhatsApp",
      "setShowAutomations",
      "setShowCollaborators",
      "setShowSearch",
      "setShowShortcuts",
      "setWhatsappUnreadCount",
      `${code}\nreturn openPanel;`,
    )(
      (v: boolean) => (state.history = v),
      (v: boolean) => (state.twin = v),
      (v: boolean) => (state.whatsapp = v),
      (v: boolean) => (state.automations = v),
      (v: boolean) => (state.collaborators = v),
      (v: boolean) => (state.search = v),
      (v: boolean) => (state.shortcuts = v),
      (v: number) => {
        assert.equal(v, 0, "openPanel must only ever reset the badge to 0, never any other value");
        state.whatsappUnreadResetCalls += 1;
      },
    ) as (panel: string) => void;
    fn(panel);
    return state;
  }

  const closed = {
    history: false,
    twin: false,
    whatsapp: false,
    automations: false,
    collaborators: false,
    search: false,
    shortcuts: false,
  };
  assert.deepEqual(run("history"), { ...closed, history: true, whatsappUnreadResetCalls: 0 });
  assert.deepEqual(run("twin"), { ...closed, twin: true, whatsappUnreadResetCalls: 0 });
  assert.deepEqual(run("whatsapp"), { ...closed, whatsapp: true, whatsappUnreadResetCalls: 1 });
  assert.deepEqual(run("automations"), { ...closed, automations: true, whatsappUnreadResetCalls: 0 });
  assert.deepEqual(run("collaborators"), { ...closed, collaborators: true, whatsappUnreadResetCalls: 0 });
  assert.deepEqual(run("search"), { ...closed, search: true, whatsappUnreadResetCalls: 0 });
  assert.deepEqual(run("shortcuts"), { ...closed, shortcuts: true, whatsappUnreadResetCalls: 0 });
});

/**
 * Round 367 regression: EntityPanel.tsx's per-record "Send WhatsApp" row
 * action (shown whenever an entity has a phone field with a value) used to
 * open the WhatsApp panel via a bare `setShowWhatsApp(true)`, bypassing
 * openPanel() entirely -- unlike the topbar's own WhatsApp button, which
 * already goes through openPanel("whatsapp"). openPanel's own round-288
 * comment states its WhatsApp-specific guarantee explicitly: opening the
 * panel immediately zeroes the unread badge, "since she's about to see
 * every message right now" -- a guarantee this one entry point silently
 * didn't honor. A real user with, say, 2 unread WhatsApp messages (topbar
 * badge showing "2") who clicks "Send WhatsApp" on a customer record would
 * see the WhatsApp log open -- those same 2 messages right in front of
 * her -- while the topbar badge kept showing "2" for up to the
 * background poll's own interval, instead of clearing immediately like
 * every other way of opening the panel. Extracts the real onSendWhatsApp
 * callback passed to <EntityPanel> and confirms it now routes through the
 * real openPanel("whatsapp") (proving it shares openPanel's own
 * mutual-exclusion and badge-reset guarantee), not a bare setShowWhatsApp.
 */
test("App's onSendWhatsApp (EntityPanel's per-record row action) opens the WhatsApp panel via the real openPanel, not a bare setShowWhatsApp", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const callbackMatch = appSrc.match(/onSendWhatsApp=\{\(phoneNumber\) => \{[\s\S]*?\n\s*\}\}/);
  assert.ok(callbackMatch, "expected to find the onSendWhatsApp callback passed to <EntityPanel>");
  assert.doesNotMatch(
    callbackMatch![0],
    /setShowWhatsApp\(true\)/,
    "onSendWhatsApp must never call setShowWhatsApp directly -- that bypasses openPanel's mutual-exclusion and unread-badge reset",
  );

  const body = callbackMatch![0].replace(/^onSendWhatsApp=\{/, "").replace(/\}$/, "");
  const { code } = transformSync(`const fn = ${body};\nreturn fn;`, { loader: "ts" });
  const calls: { setWhatsappPrefillTo: string[]; openPanel: string[] } = { setWhatsappPrefillTo: [], openPanel: [] };
  const fn = new Function(
    "setWhatsappPrefillTo",
    "openPanel",
    `${code}`,
  )(
    (v: string) => calls.setWhatsappPrefillTo.push(v),
    (panel: string) => calls.openPanel.push(panel),
  ) as (phoneNumber: string) => void;
  fn("0501234567");
  assert.deepEqual(calls, { setWhatsappPrefillTo: ["0501234567"], openPanel: ["whatsapp"] });
});

/** Derives a distinct, strictly-increasing timestamp from the numeric suffix of `id` (m1 < m2 < m3 < ...), mirroring whatsappUnread.test.ts/whatsappNotify.test.ts's own identical convention -- round 1019's own createdAt-fallback logic (maybeNotifyNewWhatsAppMessages' own ref, see below) needs genuine chronological ordering between these messages, not the identical "now" timestamp every call to `new Date()` in quick succession would otherwise produce. */
function timeFor(id: string): string {
  const minute = Number(id.replace(/\D/g, "")) || 0;
  return new Date(2024, 0, 1, 0, minute).toISOString();
}

function whatsAppMsg(overrides: Partial<WhatsAppMessageLogEntry> & { id: string }): WhatsAppMessageLogEntry {
  return {
    direction: "in",
    fromNumber: "972521112233",
    toNumber: "972501234567",
    body: "hello",
    matchedLabel: null,
    matchedEntityName: null,
    matchedRecordId: null,
    status: "received",
    createdAt: timeFor(overrides.id),
    ...overrides,
  };
}

/** Builds a maybeNotifyNewWhatsAppMessages ref baseline -- both the tracked message's id AND its own createdAt, the shape round 1019 moved to (mirroring whatsappUnread.ts's own WhatsAppLastSeen). */
function notifiedRef(id: string, createdAt: string = timeFor(id)): { current: { id: string; createdAt: string } | null } {
  return { current: { id, createdAt } };
}

const notifyT = (key: string, params?: Record<string, string>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;

/**
 * New in this round: a real desktop notification for a WhatsApp message
 * that arrives while the tab is backgrounded -- the topbar unread badge
 * (round 288/289) is invisible then. This is the impure "decide AND fire"
 * glue around findNewInboundMessages' own pure comparison (already unit
 * tested in whatsappNotify.test.ts), extracted out of App.tsx's unread-poll
 * effect specifically so this wiring has its own regression test -- round
 * 292's own lesson that a pure helper's unit tests don't cover the glue
 * code that actually calls it. Stubs a minimal constructible
 * globalThis.Notification to capture what would have been shown, the same
 * "stub the missing browser API" approach round 291's matchMedia stub used.
 */
test("maybeNotifyNewWhatsAppMessages fires a real Notification with the correct title/body when the tab is hidden and permission is granted", () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  const calls: Array<{ title: string; body: string }> = [];
  class FakeNotification {
    static permission = "granted";
    constructor(title: string, options?: { body?: string }) {
      calls.push({ title, body: options?.body ?? "" });
    }
  }
  (globalThis as { Notification: unknown }).Notification = FakeNotification;
  try {
    const messages = [whatsAppMsg({ id: "m2", fromNumber: "972529998888", body: "Are you open tomorrow?" }), whatsAppMsg({ id: "m1" })];
    const ref = notifiedRef("m1");
    maybeNotifyNewWhatsAppMessages(messages, ref, true, notifyT);
    assert.deepEqual(calls, [{ title: 'whatsapp.notification.title.one:{"from":"972529998888"}', body: "Are you open tomorrow?" }]);
    assert.deepEqual(ref.current, { id: "m2", createdAt: timeFor("m2") }, "the ref must advance to the newest message's own id and createdAt");
  } finally {
    (globalThis as { Notification?: unknown }).Notification = originalNotification;
  }
});

/**
 * Round 750: whatsappLog.ts and WhatsAppPanel.tsx both already show
 * "matchedLabel ?? fromNumber" for this exact message everywhere else in
 * the app -- the desktop notification (the one surface specifically
 * meant to alert someone while they're away from the tab) must show the
 * same human label, not a bare, unrecognizable phone number, whenever the
 * inbound number was matched to a real CRM record.
 */
test("maybeNotifyNewWhatsAppMessages shows the matched record's own label in the title instead of the bare phone number, when the message was matched to one", () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  const calls: Array<{ title: string; body: string }> = [];
  class FakeNotification {
    static permission = "granted";
    constructor(title: string, options?: { body?: string }) {
      calls.push({ title, body: options?.body ?? "" });
    }
  }
  (globalThis as { Notification: unknown }).Notification = FakeNotification;
  try {
    const messages = [
      whatsAppMsg({ id: "m2", fromNumber: "972529998888", matchedLabel: "Sarah Cohen", body: "Are you open tomorrow?" }),
      whatsAppMsg({ id: "m1" }),
    ];
    const ref = notifiedRef("m1");
    maybeNotifyNewWhatsAppMessages(messages, ref, true, notifyT);
    assert.deepEqual(calls, [{ title: 'whatsapp.notification.title.one:{"from":"Sarah Cohen"}', body: "Are you open tomorrow?" }]);
  } finally {
    (globalThis as { Notification?: unknown }).Notification = originalNotification;
  }
});

test("maybeNotifyNewWhatsAppMessages never calls Notification when the tab is NOT hidden, even with new messages and granted permission -- but still advances the ref", () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  let constructed = 0;
  class FakeNotification {
    static permission = "granted";
    constructor() {
      constructed++;
    }
  }
  (globalThis as { Notification: unknown }).Notification = FakeNotification;
  try {
    const messages = [whatsAppMsg({ id: "m2" }), whatsAppMsg({ id: "m1" })];
    const ref = notifiedRef("m1");
    maybeNotifyNewWhatsAppMessages(messages, ref, false, notifyT);
    assert.equal(constructed, 0, "must never construct a Notification while the tab is focused");
    assert.deepEqual(ref.current, { id: "m2", createdAt: timeFor("m2") }, "the ref must still advance even though no notification fired");
  } finally {
    (globalThis as { Notification?: unknown }).Notification = originalNotification;
  }
});

test("maybeNotifyNewWhatsAppMessages never calls Notification when permission isn't granted, even while the tab is hidden", () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  let constructed = 0;
  class FakeNotification {
    static permission = "default";
    constructor() {
      constructed++;
    }
  }
  (globalThis as { Notification: unknown }).Notification = FakeNotification;
  try {
    const messages = [whatsAppMsg({ id: "m2" }), whatsAppMsg({ id: "m1" })];
    const ref = notifiedRef("m1");
    maybeNotifyNewWhatsAppMessages(messages, ref, true, notifyT);
    assert.equal(constructed, 0, "must never construct a Notification while permission is merely 'default' (not yet granted)");
  } finally {
    (globalThis as { Notification?: unknown }).Notification = originalNotification;
  }
});

test("maybeNotifyNewWhatsAppMessages shows the 'many' title with a real count when several inbound messages arrived at once", () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  const calls: Array<{ title: string; body: string }> = [];
  class FakeNotification {
    static permission = "granted";
    constructor(title: string, options?: { body?: string }) {
      calls.push({ title, body: options?.body ?? "" });
    }
  }
  (globalThis as { Notification: unknown }).Notification = FakeNotification;
  try {
    const messages = [whatsAppMsg({ id: "m3", body: "newest" }), whatsAppMsg({ id: "m2", body: "middle" }), whatsAppMsg({ id: "m1" })];
    const ref = notifiedRef("m1");
    maybeNotifyNewWhatsAppMessages(messages, ref, true, notifyT);
    assert.deepEqual(calls, [{ title: 'whatsapp.notification.title.many:{"count":"2"}', body: "newest" }]);
  } finally {
    (globalThis as { Notification?: unknown }).Notification = originalNotification;
  }
});

test("maybeNotifyNewWhatsAppMessages does nothing at all on the first-ever check (null ref baseline), even with the tab hidden and permission granted", () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  let constructed = 0;
  class FakeNotification {
    static permission = "granted";
    constructor() {
      constructed++;
    }
  }
  (globalThis as { Notification: unknown }).Notification = FakeNotification;
  try {
    const messages = [whatsAppMsg({ id: "m2" }), whatsAppMsg({ id: "m1" })];
    const ref = { current: null as { id: string; createdAt: string } | null };
    maybeNotifyNewWhatsAppMessages(messages, ref, true, notifyT);
    assert.equal(constructed, 0, "the very first check must only seed the baseline, never notify for pre-existing history");
    assert.deepEqual(ref.current, { id: "m2", createdAt: timeFor("m2") }, "the baseline must still be seeded to the newest message's own id and createdAt");
  } finally {
    (globalThis as { Notification?: unknown }).Notification = originalNotification;
  }
});

/** Builds a minimal AutomationRuleView for maybeNotifyFailingAutomations tests -- only the fields that function reads are given real values. */
function automationRule(overrides: Partial<AutomationRuleView> & { id: string }): AutomationRuleView {
  return {
    entityName: "Order",
    trigger: "schedule",
    fieldName: null,
    fieldValue: null,
    scheduleTimeUtc: null,
    scheduleDaysOfWeek: null,
    scheduleTimezone: null,
    actionType: "webhook",
    toMode: "static",
    toNumber: null,
    toField: null,
    webhookUrl: "https://example.com/hook",
    webhookSecret: null,
    toEmail: null,
    emailSubject: null,
    messageTemplate: "",
    enabled: true,
    lastTriggeredAt: null,
    lastStatus: null,
    lastError: null,
    lastActionType: null,
    pausedForToday: false,
    ...overrides,
  };
}

/**
 * Round 1218: mirrors maybeNotifyNewWhatsAppMessages' own test suite above
 * -- a rule that starts failing in the background while the tab is
 * backgrounded should surface a real desktop notification the same way a
 * new WhatsApp message does, not only the in-page failing-count badge.
 */
test("maybeNotifyFailingAutomations fires a real Notification with the correct title when the tab is hidden and permission is granted", () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  const calls: string[] = [];
  class FakeNotification {
    static permission = "granted";
    constructor(title: string) {
      calls.push(title);
    }
  }
  (globalThis as { Notification: unknown }).Notification = FakeNotification;
  try {
    const rules = [automationRule({ id: "r1", entityName: "Invoice", lastStatus: "failed" })];
    const ref: { current: Set<string> | null } = { current: new Set() };
    maybeNotifyFailingAutomations(rules, ref, true, notifyT);
    assert.deepEqual(calls, ['automations.notification.title.one:{"entity":"Invoice"}']);
    assert.deepEqual(ref.current, new Set(["r1"]), "the ref must advance to the full currently-failing id set");
  } finally {
    (globalThis as { Notification?: unknown }).Notification = originalNotification;
  }
});

test("maybeNotifyFailingAutomations never calls Notification when the tab is NOT hidden, even with a newly-failing rule and granted permission -- but still advances the ref", () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  let constructed = 0;
  class FakeNotification {
    static permission = "granted";
    constructor() {
      constructed++;
    }
  }
  (globalThis as { Notification: unknown }).Notification = FakeNotification;
  try {
    const rules = [automationRule({ id: "r1", lastStatus: "failed" })];
    const ref: { current: Set<string> | null } = { current: new Set() };
    maybeNotifyFailingAutomations(rules, ref, false, notifyT);
    assert.equal(constructed, 0, "must never construct a Notification while the tab is focused");
    assert.deepEqual(ref.current, new Set(["r1"]), "the ref must still advance even though no notification fired");
  } finally {
    (globalThis as { Notification?: unknown }).Notification = originalNotification;
  }
});

test("maybeNotifyFailingAutomations never calls Notification when permission isn't granted, even while the tab is hidden", () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  let constructed = 0;
  class FakeNotification {
    static permission = "default";
    constructor() {
      constructed++;
    }
  }
  (globalThis as { Notification: unknown }).Notification = FakeNotification;
  try {
    const rules = [automationRule({ id: "r1", lastStatus: "failed" })];
    const ref: { current: Set<string> | null } = { current: new Set() };
    maybeNotifyFailingAutomations(rules, ref, true, notifyT);
    assert.equal(constructed, 0, "must never construct a Notification while permission is merely 'default' (not yet granted)");
  } finally {
    (globalThis as { Notification?: unknown }).Notification = originalNotification;
  }
});

test("maybeNotifyFailingAutomations shows the 'many' title with a real count when several rules start failing at once", () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  const calls: string[] = [];
  class FakeNotification {
    static permission = "granted";
    constructor(title: string) {
      calls.push(title);
    }
  }
  (globalThis as { Notification: unknown }).Notification = FakeNotification;
  try {
    const rules = [
      automationRule({ id: "r1", lastStatus: "failed" }),
      automationRule({ id: "r2", lastStatus: "failed" }),
    ];
    const ref: { current: Set<string> | null } = { current: new Set() };
    maybeNotifyFailingAutomations(rules, ref, true, notifyT);
    assert.deepEqual(calls, ['automations.notification.title.many:{"count":"2"}']);
  } finally {
    (globalThis as { Notification?: unknown }).Notification = originalNotification;
  }
});

test("maybeNotifyFailingAutomations does nothing at all on the first-ever check (null ref baseline), even with the tab hidden and permission granted", () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  let constructed = 0;
  class FakeNotification {
    static permission = "granted";
    constructor() {
      constructed++;
    }
  }
  (globalThis as { Notification: unknown }).Notification = FakeNotification;
  try {
    const rules = [automationRule({ id: "r1", lastStatus: "failed" })];
    const ref: { current: Set<string> | null } = { current: null };
    maybeNotifyFailingAutomations(rules, ref, true, notifyT);
    assert.equal(constructed, 0, "the very first check must only seed the baseline, never notify for a pre-existing failure");
    assert.deepEqual(ref.current, new Set(["r1"]), "the baseline must still be seeded to the full currently-failing id set");
  } finally {
    (globalThis as { Notification?: unknown }).Notification = originalNotification;
  }
});

test("maybeNotifyFailingAutomations never fires for a rule that was already failing on the previous check (not newly failing)", () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  let constructed = 0;
  class FakeNotification {
    static permission = "granted";
    constructor() {
      constructed++;
    }
  }
  (globalThis as { Notification: unknown }).Notification = FakeNotification;
  try {
    const rules = [automationRule({ id: "r1", lastStatus: "failed" })];
    const ref: { current: Set<string> | null } = { current: new Set(["r1"]) };
    maybeNotifyFailingAutomations(rules, ref, true, notifyT);
    assert.equal(constructed, 0, "a rule still failing from before must not re-notify every poll");
  } finally {
    (globalThis as { Notification?: unknown }).Notification = originalNotification;
  }
});

test("maybeNotifyFailingAutomations re-notifies for a rule that recovered and then failed again (full-snapshot diff forgets recovered rules)", () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  const calls: string[] = [];
  class FakeNotification {
    static permission = "granted";
    constructor(title: string) {
      calls.push(title);
    }
  }
  (globalThis as { Notification: unknown }).Notification = FakeNotification;
  try {
    const ref: { current: Set<string> | null } = { current: new Set(["r1"]) };
    // r1 recovers -- a poll with lastStatus "sent" must drop it from the baseline.
    maybeNotifyFailingAutomations([automationRule({ id: "r1", lastStatus: "sent" })], ref, true, notifyT);
    assert.deepEqual(ref.current, new Set(), "a recovered rule must be dropped from the failing-id baseline");
    // r1 fails again -- it's no longer in the baseline, so this must notify again.
    maybeNotifyFailingAutomations([automationRule({ id: "r1", lastStatus: "failed" })], ref, true, notifyT);
    assert.deepEqual(calls, ['automations.notification.title.one:{"entity":"Order"}'], "a rule failing again after recovering must notify again");
  } finally {
    (globalThis as { Notification?: unknown }).Notification = originalNotification;
  }
});

/**
 * Round 1240: updateAutomationRule (the server endpoint AutomationsPanel's
 * one-click handleToggle calls) never touches lastStatus/lastError when
 * only `enabled` changes -- confirmed in packages/db/src/automations.ts.
 * So a rule that's known-broken (lastStatus "failed"), gets disabled, and
 * is re-enabled before it actually runs again still has lastStatus
 * "failed" the whole time -- nothing about its *failure* ever changed.
 * Before this round's fix, the baseline computation in
 * maybeNotifyFailingAutomations also required `enabled`, so disabling the
 * rule dropped its id from the baseline even though it was still failing;
 * re-enabling it then made findNewlyFailingAutomations see a "new"
 * failure and fire a spurious notification for a problem that never
 * actually recurred.
 */
test("maybeNotifyFailingAutomations does not re-notify for a still-failing rule that was merely disabled and re-enabled before it ran again", () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  const calls: string[] = [];
  class FakeNotification {
    static permission = "granted";
    constructor(title: string) {
      calls.push(title);
    }
  }
  (globalThis as { Notification: unknown }).Notification = FakeNotification;
  try {
    const ref: { current: Set<string> | null } = { current: new Set(["r1"]) };
    // User pauses the known-broken rule -- lastStatus stays "failed" (the server never touches it on an enabled-only toggle).
    maybeNotifyFailingAutomations([automationRule({ id: "r1", enabled: false, lastStatus: "failed" })], ref, true, notifyT);
    // User re-enables it before it has actually re-run -- still lastStatus "failed", same underlying failure.
    maybeNotifyFailingAutomations([automationRule({ id: "r1", enabled: true, lastStatus: "failed" })], ref, true, notifyT);
    assert.deepEqual(calls, [], "disabling and re-enabling a rule must not make its unchanged, still-stale failure look newly failing");
  } finally {
    (globalThis as { Notification?: unknown }).Notification = originalNotification;
  }
});

/**
 * Regression test for a real behavioral choice in openExistingProject
 * (the handler the new "Your projects" home-screen list uses to jump back
 * into a project someone already created or was added to as a
 * collaborator): a "built" project should open straight to the live
 * preview, but a project that was only ever created/answered but never
 * built has no real database behind it yet, so it must open to the spec
 * review screen instead -- opening a draft straight to "preview" would
 * show a live-preview screen with no working CRUD behind it. Also covers
 * round 401's own addition: opening a project someone else owns must mark
 * it "seen" (sharedProjectSeen.ts) with its own `sharedAt`, so the home
 * screen's "New share" chip (round 401, corrected in round 405 to compare
 * timestamps rather than a flat id so a removed-then-re-invited
 * collaborator sees it as new again) disappears once the invited
 * collaborator has actually looked at it -- but opening a project the
 * signed-in user owns themself must never touch that store at all, since
 * round 401's chip only ever applies to someone else's project in the
 * first place. Extracts the real function from App.tsx (not a
 * reimplementation) the same way the openPanel test above does.
 */
test("App's openExistingProject routes a built project to the live preview and a draft project back to spec review, and marks a shared (not owned) project as seen with its sharedAt", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}function openExistingProject\(p: Project\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find openExistingProject in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(project: Project, currentUser: { id: string } | null) {
    const state: {
      project: Project | null;
      activeEntity: string | null;
      view: string | null;
      specProvider: string | null;
      enhanceProvider: string | null;
      buildWarning: string | null;
      markSeenCalls: Array<[string, string, string]>;
      myRole: string;
    } = {
      project: null,
      activeEntity: null,
      view: null,
      specProvider: "unset",
      enhanceProvider: "unset",
      buildWarning: "Seed Data: a real failure from a previously-opened project",
      markSeenCalls: [],
      myRole: "unset",
    };
    const fn = new Function(
      "setProject",
      "setActiveEntity",
      "setSpecProvider",
      "setEnhanceProvider",
      "setBuildWarning",
      "setView",
      "user",
      "markSharedProjectSeen",
      "setSeenShared",
      "setMyRole",
      "listCollaborators",
      `${code}\nreturn openExistingProject;`,
    )(
      (p: Project) => (state.project = p),
      (name: string | null) => (state.activeEntity = name),
      (v: string | null) => (state.specProvider = v),
      (v: string | null) => (state.enhanceProvider = v),
      (w: string | null) => (state.buildWarning = w),
      (v: string) => (state.view = v),
      currentUser,
      (userId: string, id: string, sharedAt: string) => {
        state.markSeenCalls.push([userId, id, sharedAt]);
        return new Map([[id, sharedAt]]);
      },
      (_m: Map<string, string>) => {},
      (role: string) => (state.myRole = role),
      // Never resolved within this synchronous test -- openExistingProject's
      // own real .then() always lands after this function already
      // returned, so only the synchronous "owner" or optimistic "editor"
      // assignment below is ever observable here.
      (_id: string) => new Promise(() => {}),
    ) as (p: Project) => void;
    fn(project);
    return state;
  }

  const owner = { id: "user-owner" };
  const collaborator = { id: "user-collaborator" };

  const builtProject = makeProject([makeEntity("Customer")]);
  builtProject.status = "built";
  builtProject.ownerId = owner.id;
  const builtResult = run(builtProject, owner);
  assert.deepEqual(
    {
      project: builtResult.project,
      activeEntity: builtResult.activeEntity,
      view: builtResult.view,
      specProvider: builtResult.specProvider,
      enhanceProvider: builtResult.enhanceProvider,
    },
    { project: builtProject, activeEntity: "Customer", view: "preview", specProvider: null, enhanceProvider: null },
  );
  assert.deepEqual(builtResult.markSeenCalls, [], "opening a project you own yourself must never call markSharedProjectSeen");
  assert.equal(builtResult.myRole, "owner", "opening your own project must set myRole to 'owner' synchronously, with no need to fetch a role for yourself");
  assert.equal(
    builtResult.buildWarning,
    null,
    "opening any project must clear a stale non-terminal build-warning banner left over from whatever project was open before (round 469) -- otherwise it falsely re-appears here",
  );

  const draftProject = makeProject([makeEntity("Customer")]);
  draftProject.status = "draft";
  draftProject.ownerId = owner.id;
  const draftResult = run(draftProject, owner);
  assert.deepEqual(
    {
      project: draftResult.project,
      activeEntity: draftResult.activeEntity,
      view: draftResult.view,
      specProvider: draftResult.specProvider,
      enhanceProvider: draftResult.enhanceProvider,
    },
    { project: draftProject, activeEntity: "Customer", view: "spec", specProvider: null, enhanceProvider: null },
  );
  assert.deepEqual(draftResult.markSeenCalls, [], "opening a draft project you own yourself must never call markSharedProjectSeen either");

  const sharedProject = makeProject([makeEntity("Customer")]);
  sharedProject.status = "built";
  sharedProject.ownerId = owner.id;
  sharedProject.sharedAt = "2026-03-01T00:00:00.000Z";
  const sharedResult = run(sharedProject, collaborator);
  assert.deepEqual(
    sharedResult.markSeenCalls,
    [[collaborator.id, sharedProject.id, "2026-03-01T00:00:00.000Z"]],
    "opening a project someone else owns must mark it seen under the SIGNED-IN collaborator's own id, with the project's own id and current sharedAt",
  );
  assert.equal(
    sharedResult.myRole,
    "editor",
    "opening a shared project must optimistically set myRole to 'editor' (full access) while the real role is still being fetched, never leave it unset",
  );

  const sharedProjectNoTimestamp = makeProject([makeEntity("Customer")]);
  sharedProjectNoTimestamp.status = "built";
  sharedProjectNoTimestamp.ownerId = owner.id;
  const noTimestampResult = run(sharedProjectNoTimestamp, collaborator);
  assert.deepEqual(
    noTimestampResult.markSeenCalls,
    [],
    "a shared project with no sharedAt (shouldn't happen for a real collaborator row, but must never crash) must not call markSharedProjectSeen",
  );
});

/**
 * Round 905: ProjectDescriptionEditor was only ever mounted on the
 * pre-build "spec" view, never on the built project's own "preview" view
 * -- but project.description is resent as real AI context on every single
 * /refine call (routes/projects.ts's own combinedDescription), for the
 * entire post-build life of the project, which is reachable ONLY from the
 * preview screen. A typo or wrong requirement in the original description
 * had no way to ever be corrected once a project was built, even though
 * the server's own PATCH /projects/:id/description route already supports
 * it unconditionally (no project.status guard at all). Checks the real
 * source (App.tsx is never fully rendered in this test file; every other
 * preview-view test here works the same way, either extracting a handler
 * or, like this one, matching the real JSX text) for the editor actually
 * appearing inside the `view === "preview"` block, not just the `"spec"` one.
 */
test("App.tsx renders ProjectDescriptionEditor on the built-project preview screen too, not just the pre-build spec-review screen", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const previewBlockMatch = appSrc.match(/\{view === "preview" && project && \([\s\S]*?<div className="preview-body">/);
  assert.ok(previewBlockMatch, "expected to find the preview view's own JSX block, up to its chat/entity body");
  assert.match(
    previewBlockMatch![0],
    /<ProjectDescriptionEditor project=\{project\} onChanged=\{setProject\} readOnly=\{myRole === "viewer"\} \/>/,
    "expected the built-project preview screen to render ProjectDescriptionEditor too, the same way the spec-review screen already does",
  );
});

/**
 * Round 906: the same round-905 gap, for roles/personas/assumptions
 * instead of the description -- RoleChip/PersonaItem/AssumptionItem (and
 * their Add*Form siblings) were only ever mounted on the pre-build
 * spec-review screen, which becomes permanently unreachable once a
 * project builds. The server's own routes for all three have no
 * project.status guard at all (the same shape round 905 already found
 * for the description route), so a built project had no way to ever see
 * or correct a role/persona/assumption the AI/heuristic engine got wrong,
 * even though the exact fix already existed one component away.
 */
test("App.tsx renders the roles/personas/assumptions editors on the built-project preview screen too, not just the pre-build spec-review screen", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const previewBlockMatch = appSrc.match(/\{view === "preview" && project && \([\s\S]*?<div className="preview-body">/);
  assert.ok(previewBlockMatch, "expected to find the preview view's own JSX block, up to its chat/entity body");
  assert.match(
    previewBlockMatch![0],
    /<RoleChip\b/,
    "expected the built-project preview screen to render RoleChip too, the same way the spec-review screen already does",
  );
  assert.match(
    previewBlockMatch![0],
    /<AddRoleForm\s+projectId=\{project\.id\}\s+onAdded=\{setProject\}\s+readOnly=\{myRole === "viewer"\}[\s\S]*?\/>/,
  );
  assert.match(
    previewBlockMatch![0],
    /<PersonaItem\b/,
    "expected the built-project preview screen to render PersonaItem too",
  );
  assert.match(
    previewBlockMatch![0],
    /<AddPersonaForm\s+projectId=\{project\.id\}\s+onAdded=\{setProject\}\s+readOnly=\{myRole === "viewer"\}[\s\S]*?\/>/,
  );
  assert.match(
    previewBlockMatch![0],
    /<AssumptionItem\b/,
    "expected the built-project preview screen to render AssumptionItem too",
  );
  assert.match(
    previewBlockMatch![0],
    /<AddAssumptionForm\s+projectId=\{project\.id\}\s+onAdded=\{setProject\}\s+readOnly=\{myRole === "viewer"\}[\s\S]*?\/>/,
  );
});

/**
 * Regression test for handleDeleteProject (the home-screen "Your
 * projects" list's delete button): a real, irreversible action gated
 * behind window.confirm -- declining the confirm must leave everything
 * untouched (no API call, myProjects list unchanged), while confirming
 * must call the real deleteProject API function and then remove exactly
 * the deleted project from myProjects, leaving every other project alone.
 * Also confirms this round's own fix: a successful delete must call
 * purgeProjectPreferences with the deleted project's id, since nothing
 * else ever cleans up its pinned/column/filter/sort/recent-search entries
 * in localStorage (projectPreferenceCleanup.ts) -- previously they sat
 * there forever. Extracts the real function from App.tsx the same way
 * the openPanel and openExistingProject tests above do, rather than
 * reimplementing its logic.
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
    const purgeCalls: string[] = [];
    const fn = new Function(
      "deletingId",
      "bulkDeleteBusy",
      "cloningId",
      "window",
      "t",
      "lang",
      "deleteProject",
      "setDeletingId",
      "setError",
      "setMyProjects",
      "purgeProjectPreferences",
      `${code}\nreturn handleDeleteProject;`,
    )(
      null,
      false,
      null,
      { confirm: (message: string) => (confirmCalls.push(message), opts.confirmReturns) },
      (key: string) => key,
      "en",
      opts.deleteProjectFn,
      (v: string | null) => (state.deletingId = v),
      (v: string | null) => (state.error = v),
      (updater: (prev: Project[]) => Project[]) => (state.myProjects = updater(state.myProjects)),
      (id: string) => purgeCalls.push(id),
    ) as (p: Project) => Promise<void>;
    return { fn, state, confirmCalls, purgeCalls };
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
  assert.deepEqual(declined.purgeCalls, [], "declining the confirm must never purge any client-side preferences");

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
  assert.deepEqual(
    confirmed.purgeCalls,
    ["delete-me"],
    "a successful delete must also purge the deleted project's own client-side preferences (pinned, column widths/order/..., recent searches) -- otherwise they sit in localStorage forever",
  );
});

/**
 * Regression test for handleBulkDeleteProjects (the home-screen "Your
 * projects" list's new bulk-delete button, this round): same
 * Promise.allSettled resilience as EntityPanel's own handleBulkDelete --
 * a single rejected delete (a project someone else already removed, a
 * dropped connection) must not hide the ones that DID succeed. Extracts
 * the real function from App.tsx rather than reimplementing its logic.
 */
test("App's handleBulkDeleteProjects removes only the projects that actually succeeded, keeping only the ones that failed selected -- one rejection must not hide the successes", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}async function handleBulkDeleteProjects\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBulkDeleteProjects in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(
    initialMyProjects: Project[],
    selectedIds: string[],
    opts: { confirmReturns: boolean; deleteProjectFn: (id: string) => Promise<void> },
  ) {
    const state: { myProjects: Project[]; selectedProjectIds: Set<string>; error: string | null } = {
      myProjects: initialMyProjects,
      selectedProjectIds: new Set(selectedIds),
      error: "not-yet-called",
    };
    const confirmCalls: string[] = [];
    const purgeCalls: string[] = [];
    // visibleSelectedProjectIds is what App.tsx's own useMemo would have
    // computed from `selectedProjectIds` and `visibleMyProjects` at call
    // time -- here that's every currently-known project (initialMyProjects),
    // i.e. no active search/filter narrowing the visible list.
    const fn = new Function(
      "bulkDeleteBusy",
      "deletingId",
      "cloningId",
      "window",
      "t",
      "lang",
      "deleteProject",
      "visibleSelectedProjectIds",
      "setBulkDeleteBusy",
      "setError",
      "setMyProjects",
      "setSelectedProjectIds",
      "purgeProjectPreferences",
      `${code}\nreturn handleBulkDeleteProjects;`,
    )(
      false,
      null,
      null,
      { confirm: (message: string) => (confirmCalls.push(message), opts.confirmReturns) },
      (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
      "en",
      opts.deleteProjectFn,
      visibleSelectedIds(state.selectedProjectIds, initialMyProjects.map((p) => p.id)),
      () => {},
      (v: string | null) => (state.error = v),
      (updater: (prev: Project[]) => Project[]) => (state.myProjects = updater(state.myProjects)),
      // Round 1197: setSelectedProjectIds is now called with a functional
      // updater (prev => ...) rather than a plain Set -- mirrors how a
      // real React setState call is invoked either way.
      (next: Set<string> | ((prev: Set<string>) => Set<string>)) =>
        (state.selectedProjectIds = typeof next === "function" ? next(state.selectedProjectIds) : next),
      (id: string) => purgeCalls.push(id),
    ) as () => Promise<void>;
    return { fn, state, confirmCalls, purgeCalls };
  }

  const a = makeProject([makeEntity("Customer")]);
  a.id = "a";
  const b = makeProject([makeEntity("Customer")]);
  b.id = "b";
  const c = makeProject([makeEntity("Customer")]);
  c.id = "c";

  // Declining the confirm dialog must call neither the API nor any setter.
  let deleteApiCalls = 0;
  const declined = run([a, b, c], ["a", "b"], {
    confirmReturns: false,
    deleteProjectFn: async () => {
      deleteApiCalls += 1;
    },
  });
  await declined.fn();
  assert.equal(deleteApiCalls, 0, "declining the confirm must never call the delete API");
  assert.deepEqual(declined.state.myProjects, [a, b, c], "myProjects must be untouched when cancelled");
  assert.deepEqual(declined.purgeCalls, [], "declining the confirm must never purge any client-side preferences");

  // Confirming with one real failure (project "b") must still remove "a", and
  // must keep only "b" (the one that actually failed) selected afterward.
  deleteApiCalls = 0;
  const attempted: string[] = [];
  const confirmed = run([a, b, c], ["a", "b"], {
    confirmReturns: true,
    deleteProjectFn: async (id: string) => {
      deleteApiCalls += 1;
      attempted.push(id);
      if (id === "b") throw new Error("project b: network error");
    },
  });
  await confirmed.fn();
  assert.deepEqual(attempted.sort(), ["a", "b"], "must attempt every selected id, not stop at the first failure");
  assert.deepEqual(
    confirmed.purgeCalls,
    ["a"],
    "only the project that actually succeeded (a) should have its client-side preferences purged -- b failed server-side and must keep its preferences in case the delete is retried",
  );
  assert.equal(deleteApiCalls, 2);
  assert.deepEqual(confirmed.state.myProjects, [b, c], "only the project that actually succeeded (a) should be removed -- b (failed) and c (never selected) must remain");
  assert.deepEqual([...confirmed.state.selectedProjectIds], ["b"], "only the id that actually failed to delete should remain selected");
  assert.match(
    confirmed.state.error!,
    /home\.myProjects\.bulk\.partialFailure/,
    "a partial failure must surface the translated partial-failure message, not the raw single-project rejection",
  );
});

/**
 * Regression test for this round's own fix: a project selected earlier and
 * then hidden by a changed search/filter must never be bulk-deleted, even
 * though it's still present in the raw `selectedProjectIds` set -- only
 * `visibleSelectedProjectIds` (the real App.tsx useMemo's own intersection
 * with the currently-visible list) may ever reach the delete API.
 */
test("App's handleBulkDeleteProjects only ever deletes visible+selected projects, never a raw-selected one hidden by the current filter", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}async function handleBulkDeleteProjects\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBulkDeleteProjects in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const a = makeProject([makeEntity("Customer")]);
  a.id = "a";
  const b = makeProject([makeEntity("Customer")]);
  b.id = "b";

  // Both "a" and "b" are raw-selected, but only "a" is currently visible
  // (as if "b" is hidden by a status filter or search term).
  const attempted: string[] = [];
  const purgeCalls: string[] = [];
  const state = { myProjects: [a, b] as Project[], selectedProjectIds: new Set(["a", "b"]) as Set<string> };
  const fn = new Function(
    "bulkDeleteBusy",
    "deletingId",
    "cloningId",
    "window",
    "t",
    "lang",
    "deleteProject",
    "visibleSelectedProjectIds",
    "setBulkDeleteBusy",
    "setError",
    "setMyProjects",
    "setSelectedProjectIds",
    "purgeProjectPreferences",
    `${code}\nreturn handleBulkDeleteProjects;`,
  )(
    false,
    null,
    null,
    { confirm: () => true },
    (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    "en",
    async (id: string) => {
      attempted.push(id);
    },
    visibleSelectedIds(new Set(["a", "b"]), ["a"]),
    () => {},
    () => {},
    (updater: (prev: Project[]) => Project[]) => (state.myProjects = updater(state.myProjects)),
    // Round 1197: setSelectedProjectIds is now called with a functional
    // updater (prev => ...) rather than a plain Set.
    (next: Set<string> | ((prev: Set<string>) => Set<string>)) =>
      (state.selectedProjectIds = typeof next === "function" ? next(state.selectedProjectIds) : next),
    (id: string) => purgeCalls.push(id),
  ) as () => Promise<void>;

  await fn();
  assert.deepEqual(attempted, ["a"], "must attempt to delete only the visible+selected project, never the hidden-but-raw-selected one");
  assert.deepEqual(state.myProjects, [b], "only the visible+selected project (a) must actually be removed -- the hidden one (b) must remain untouched");
  assert.deepEqual(purgeCalls, ["a"], "must purge client-side preferences only for the visible+selected project actually deleted, never the hidden one");
  // Round 1197: "b" was raw-selected the whole time but hidden by the
  // filter, never attempted, never in `failedIds` -- it must stay
  // selected afterward, not get silently wiped just because SOME bulk
  // delete ran. Only "a" (the one that actually succeeded) is removed.
  assert.deepEqual(
    [...state.selectedProjectIds],
    ["b"],
    "a hidden-but-raw-selected project must remain selected after a bulk delete that never touched it",
  );
});

/**
 * Regression test for round 543: unlike the single-row delete/duplicate
 * buttons on this same screen (gated on deletingId/cloningId), nothing
 * previously tied a second invocation of handleBulkDeleteProjects to the
 * first one still being in flight -- clicking "Delete Selected" twice in
 * quick succession started two fully independent batches of DELETE
 * requests for the exact same ids. The first batch's requests succeed;
 * the second batch's each hit a 404 (row already gone) or 409
 * PIPELINE_IN_PROGRESS server-side, so its own Promise.allSettled sees
 * every entry rejected and reports the whole bulk delete as failed, even
 * though every project was genuinely already deleted by the winning first
 * batch. Models a real re-render by constructing a fresh handler closure
 * (mirroring how a real onClick handler is rebound on every render) each
 * time `bulkDeleteBusy` changes, exactly as React would.
 */
test("App's handleBulkDeleteProjects refuses to start a second batch while a previous one is still in flight, and resumes normally once it finishes", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}async function handleBulkDeleteProjects\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBulkDeleteProjects in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const a = makeProject([makeEntity("Customer")]);
  a.id = "a";
  const b = makeProject([makeEntity("Customer")]);
  b.id = "b";

  const state = {
    myProjects: [a, b] as Project[],
    selectedProjectIds: new Set(["a", "b"]),
    bulkDeleteBusy: false,
    error: null as string | null,
  };
  const confirmCalls: number[] = [];
  const deleteCalls: string[] = [];
  let releaseDelete!: () => void;
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });

  function makeHandler() {
    return new Function(
      "bulkDeleteBusy",
      "deletingId",
      "cloningId",
      "window",
      "t",
      "lang",
      "deleteProject",
      "visibleSelectedProjectIds",
      "setBulkDeleteBusy",
      "setError",
      "setMyProjects",
      "setSelectedProjectIds",
      "purgeProjectPreferences",
      `${code}\nreturn handleBulkDeleteProjects;`,
    )(
      state.bulkDeleteBusy,
      null,
      null,
      {
        confirm: () => {
          confirmCalls.push(1);
          return true;
        },
      },
      (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
      "en",
      async (id: string) => {
        deleteCalls.push(id);
        await deleteGate;
      },
      visibleSelectedIds(state.selectedProjectIds, state.myProjects.map((p) => p.id)),
      (v: boolean) => (state.bulkDeleteBusy = v),
      (v: string | null) => (state.error = v),
      (updater: (prev: Project[]) => Project[]) => (state.myProjects = updater(state.myProjects)),
      // Round 1197: setSelectedProjectIds is now called with a functional
      // updater (prev => ...) rather than a plain Set -- mirrors how a
      // real React setState call is invoked either way.
      (next: Set<string> | ((prev: Set<string>) => Set<string>)) =>
        (state.selectedProjectIds = typeof next === "function" ? next(state.selectedProjectIds) : next),
      () => {},
    ) as () => Promise<void>;
  }

  // First "click": starts the real batch, which immediately marks itself
  // busy (synchronously, before its own await) and begins both deletes.
  const firstCall = makeHandler()();
  await Promise.resolve();
  assert.equal(state.bulkDeleteBusy, true, "the first invocation must mark itself busy before awaiting the real delete calls");
  assert.deepEqual(deleteCalls.sort(), ["a", "b"], "the first invocation's own deletes must have started");

  // Second "click", landing while the first batch is still held open --
  // a real re-render would bind a fresh handler against the now-true
  // bulkDeleteBusy, exactly like makeHandler() does here.
  await makeHandler()();
  assert.equal(confirmCalls.length, 1, "a second invocation while the first batch is still in flight must never even prompt for confirmation again");
  assert.deepEqual(deleteCalls.sort(), ["a", "b"], "a second invocation while the first batch is still in flight must never call deleteProject again for the same ids");

  releaseDelete();
  await firstCall;
  assert.equal(state.bulkDeleteBusy, false, "the busy flag must be cleared once the first (real) batch finishes");
  assert.deepEqual(state.myProjects, [], "both projects must be removed once the first batch's own deletes actually succeeded");
  assert.equal(state.error, null, "a bulk delete that genuinely succeeded must never report an error");
});

/**
 * Round 1041: round 543 (the test just above) only closed the
 * SELF-reentrancy case -- a second "Delete Selected" click racing the
 * first. deletingId and bulkDeleteBusy were never cross-gated against
 * EACH OTHER: clicking a single project's own "Delete" button while a
 * bulk delete of a DIFFERENT selection was still in flight (or vice versa)
 * started a second, fully independent DELETE request. deleteProject
 * (api.ts) mints a fresh idempotency key on every call, so the loser of
 * that race is never recognized as a retry and hits a genuine 404/409
 * server-side -- a confusing failure for a delete that, from the user's
 * own point of view, fully succeeded.
 */
test("App's handleDeleteProject and handleBulkDeleteProjects are cross-gated against each other, not just against themselves", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const deleteHandlerMatch = appSrc.match(/ {2}async function handleDeleteProject\(p: Project\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(deleteHandlerMatch, "expected to find handleDeleteProject in App.tsx");
  const { code: deleteCode } = transformSync(deleteHandlerMatch![0], { loader: "ts" });
  const bulkHandlerMatch = appSrc.match(/ {2}async function handleBulkDeleteProjects\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(bulkHandlerMatch, "expected to find handleBulkDeleteProjects in App.tsx");
  const { code: bulkCode } = transformSync(bulkHandlerMatch![0], { loader: "ts" });

  const target = makeProject([makeEntity("Customer")]);
  target.id = "a";

  // A single-row delete click must be a silent no-op while a bulk delete
  // is already in flight (bulkDeleteBusy: true) -- it must never even
  // reach window.confirm, exactly like handleBulkDeleteProjects' own
  // self-reentrancy guard never reaches confirm for a second click.
  {
    let confirmCalls = 0;
    let deleteApiCalls = 0;
    const fn = new Function(
      "deletingId",
      "bulkDeleteBusy",
      "cloningId",
      "window",
      "t",
      "lang",
      "deleteProject",
      "setDeletingId",
      "setError",
      "setMyProjects",
      "purgeProjectPreferences",
      `${deleteCode}\nreturn handleDeleteProject;`,
    )(
      null,
      true,
      null,
      { confirm: () => (confirmCalls += 1, true) },
      (key: string) => key,
      "en",
      async () => {
        deleteApiCalls += 1;
      },
      () => {},
      () => {},
      () => {},
      () => {},
    ) as (p: Project) => Promise<void>;
    await fn(target);
    assert.equal(confirmCalls, 0, "a single-row delete while a bulk delete is in flight must never even prompt for confirmation");
    assert.equal(deleteApiCalls, 0, "a single-row delete while a bulk delete is in flight must never call the delete API");
  }

  // A bulk delete click must be a silent no-op while a single-row delete
  // is already in flight (deletingId set).
  {
    let confirmCalls = 0;
    let deleteApiCalls = 0;
    const fn = new Function(
      "bulkDeleteBusy",
      "deletingId",
      "cloningId",
      "window",
      "t",
      "lang",
      "deleteProject",
      "visibleSelectedProjectIds",
      "setBulkDeleteBusy",
      "setError",
      "setMyProjects",
      "setSelectedProjectIds",
      "purgeProjectPreferences",
      `${bulkCode}\nreturn handleBulkDeleteProjects;`,
    )(
      false,
      "a",
      null,
      { confirm: () => (confirmCalls += 1, true) },
      (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
      "en",
      async () => {
        deleteApiCalls += 1;
      },
      new Set(["a"]),
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
    ) as () => Promise<void>;
    await fn();
    assert.equal(confirmCalls, 0, "a bulk delete while a single-row delete is in flight must never even prompt for confirmation");
    assert.equal(deleteApiCalls, 0, "a bulk delete while a single-row delete is in flight must never call the delete API");
  }
});

/**
 * Round 1043: the same cross-gating gap the test just above closed for
 * delete vs bulk-delete also applied to "Duplicate" -- it was never
 * cross-gated against EITHER delete action, and neither delete action was
 * cross-gated against it. Clicking a project's own row-level "Duplicate"
 * while a delete (or bulk delete) of that exact project was still in
 * flight raced POST .../clone against DELETE .../:id for the same id,
 * and the reverse (clicking Delete/Delete Selected while a duplicate of
 * the same project was in flight) raced the other way.
 */
test("App's handleDuplicateProject is cross-gated against handleDeleteProject/handleBulkDeleteProjects, and vice versa", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const duplicateHandlerMatch = appSrc.match(/ {2}async function handleDuplicateProject\(p: Project\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(duplicateHandlerMatch, "expected to find handleDuplicateProject in App.tsx");
  const { code: duplicateCode } = transformSync(duplicateHandlerMatch![0], { loader: "ts" });
  const deleteHandlerMatch = appSrc.match(/ {2}async function handleDeleteProject\(p: Project\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(deleteHandlerMatch, "expected to find handleDeleteProject in App.tsx");
  const { code: deleteCode } = transformSync(deleteHandlerMatch![0], { loader: "ts" });
  const bulkHandlerMatch = appSrc.match(/ {2}async function handleBulkDeleteProjects\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(bulkHandlerMatch, "expected to find handleBulkDeleteProjects in App.tsx");
  const { code: bulkCode } = transformSync(bulkHandlerMatch![0], { loader: "ts" });

  const target = makeProject([makeEntity("Customer")]);
  target.id = "a";

  // Duplicate must be a silent no-op while a delete (or bulk delete) of
  // the same project is in flight.
  for (const [deletingId, bulkDeleteBusy] of [
    ["a", false],
    [null, true],
  ] as const) {
    let cloneApiCalls = 0;
    const fn = new Function(
      "cloningId",
      "deletingId",
      "bulkDeleteBusy",
      "setCloningId",
      "setError",
      "cloneProject",
      "openExistingProject",
      `${duplicateCode}\nreturn handleDuplicateProject;`,
    )(
      null,
      deletingId,
      bulkDeleteBusy,
      () => {},
      () => {},
      async () => {
        cloneApiCalls += 1;
        return { project: target };
      },
      () => {},
    ) as (p: Project) => Promise<void>;
    await fn(target);
    assert.equal(cloneApiCalls, 0, `a duplicate while deletingId=${deletingId}/bulkDeleteBusy=${bulkDeleteBusy} must never call the clone API`);
  }

  // Delete (and bulk delete) must each be a silent no-op while a
  // duplicate of the same project is in flight (cloningId set).
  {
    let confirmCalls = 0;
    let deleteApiCalls = 0;
    const fn = new Function(
      "deletingId",
      "bulkDeleteBusy",
      "cloningId",
      "window",
      "t",
      "lang",
      "deleteProject",
      "setDeletingId",
      "setError",
      "setMyProjects",
      "purgeProjectPreferences",
      `${deleteCode}\nreturn handleDeleteProject;`,
    )(
      null,
      false,
      "a",
      { confirm: () => (confirmCalls += 1, true) },
      (key: string) => key,
      "en",
      async () => {
        deleteApiCalls += 1;
      },
      () => {},
      () => {},
      () => {},
      () => {},
    ) as (p: Project) => Promise<void>;
    await fn(target);
    assert.equal(confirmCalls, 0, "a single-row delete while a duplicate is in flight must never even prompt for confirmation");
    assert.equal(deleteApiCalls, 0, "a single-row delete while a duplicate is in flight must never call the delete API");
  }
  {
    let confirmCalls = 0;
    let deleteApiCalls = 0;
    const fn = new Function(
      "bulkDeleteBusy",
      "deletingId",
      "cloningId",
      "window",
      "t",
      "lang",
      "deleteProject",
      "visibleSelectedProjectIds",
      "setBulkDeleteBusy",
      "setError",
      "setMyProjects",
      "setSelectedProjectIds",
      "purgeProjectPreferences",
      `${bulkCode}\nreturn handleBulkDeleteProjects;`,
    )(
      false,
      null,
      "a",
      { confirm: () => (confirmCalls += 1, true) },
      (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
      "en",
      async () => {
        deleteApiCalls += 1;
      },
      new Set(["a"]),
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
    ) as () => Promise<void>;
    await fn();
    assert.equal(confirmCalls, 0, "a bulk delete while a duplicate is in flight must never even prompt for confirmation");
    assert.equal(deleteApiCalls, 0, "a bulk delete while a duplicate is in flight must never call the delete API");
  }
});

/**
 * Regression test for toggleSelectAllOwnedProjects (the home-screen
 * "Your projects" list's new "select all" checkbox, this round): only the
 * signed-in user's OWN projects can ever be bulk-deleted (mirrors the
 * single-delete button's own `p.ownerId === user.id` gate), so "select
 * all" must never select a project someone else owns -- a collaborator's
 * shared project has no checkbox in the real UI at all, and this proves
 * the underlying toggle logic honors that same rule even if a caller
 * somehow invoked it differently. Also confirms it's a real toggle: a
 * second call with everything already selected deselects instead of
 * re-selecting.
 */
test("App's toggleSelectAllOwnedProjects only ever selects the signed-in user's own projects, and toggles off when everything owned is already selected", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}const toggleSelectAllOwnedProjects = \(\) => \{[\s\S]*?\n {2}\};\n/);
  assert.ok(handlerMatch, "expected to find toggleSelectAllOwnedProjects in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(visibleMyProjects: Project[], userId: string, initiallySelected: string[]) {
    let selectedProjectIds = new Set(initiallySelected);
    const fn = new Function(
      "visibleMyProjects",
      "user",
      "selectedProjectIds",
      "setSelectedProjectIds",
      `${code}\nreturn toggleSelectAllOwnedProjects;`,
    )(visibleMyProjects, { id: userId }, selectedProjectIds, (updater: (prev: Set<string>) => Set<string>) => {
      selectedProjectIds = updater(selectedProjectIds);
    }) as () => void;
    return { fn, getSelected: () => selectedProjectIds };
  }

  const owned1 = makeProject([makeEntity("Customer")]);
  owned1.id = "owned1";
  owned1.ownerId = "me";
  const owned2 = makeProject([makeEntity("Customer")]);
  owned2.id = "owned2";
  owned2.ownerId = "me";
  const shared = makeProject([makeEntity("Customer")]);
  shared.id = "shared";
  shared.ownerId = "someone-else";

  // Nothing selected yet -- must select both owned projects, never the shared one.
  const first = run([owned1, owned2, shared], "me", []);
  first.fn();
  assert.deepEqual([...first.getSelected()].sort(), ["owned1", "owned2"], "must select every owned project, and never a project owned by someone else");

  // Everything owned already selected -- a second toggle must deselect, not re-select.
  const second = run([owned1, owned2, shared], "me", ["owned1", "owned2"]);
  second.fn();
  assert.deepEqual([...second.getSelected()], [], "toggling again with everything owned already selected must deselect all of them");
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
  const handlerMatch = appSrc.match(/ {2}function handleBuildComplete\(builtProject: Project, warning\?: string\) \{[\s\S]*?\n {2}\}\n/);
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
      "setBuildWarning",
      "setProject",
      "setActiveEntity",
      "setRefineText",
      "setAdditionalRequest",
      "setRefineRunning",
      "setView",
      "project",
      "purgeEntityPreferences",
      "migrateEntityPreferencesForCaseRename",
      `${code}\nreturn handleBuildComplete;`,
    )(
      false, // refineRunning: false keeps this focused on the activeEntity logic itself, which runs unconditionally either way
      { current: null },
      { current: [] },
      (key: string) => key,
      summarizeRefineImpact,
      () => {},
      () => {},
      () => {},
      (updater: string | null | ((prev: string | null) => string | null)) => {
        activeEntity = typeof updater === "function" ? (updater as (prev: string | null) => string | null)(activeEntity) : updater;
      },
      () => {},
      () => {},
      () => {},
      () => {},
      // null: round 853's dropped-entity-preference purge (project?.spec.entities ?? [])
      // is covered by its own dedicated test below, not this one, which is
      // scoped to the activeEntity fallback logic -- null keeps droppedEntityNames
      // empty so purgeEntityPreferences is never actually invoked here.
      null,
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
 * Regression test for round 406: when a refine actually completes
 * (refineRunning true, a pending instruction set), handleBuildComplete's
 * new history entry must carry the providerName extractRefineProviderName
 * pulled off this refine's own raw event list -- not silently drop it the
 * way this whole round's survey found it doing before the fix.
 */
test("App's handleBuildComplete records the refine's own providerName (via extractRefineProviderName) on the new history entry", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}function handleBuildComplete\(builtProject: Project, warning\?: string\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBuildComplete in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const historyEntries: Array<{ providerName: string | null }> = [];
  const fn = new Function(
    "refineRunning",
    "pendingRefineInstruction",
    "refineEvents",
    "t",
    "summarizeRefineImpact",
    "extractRefineProviderName",
    "setRefineHistory",
    "setBuildWarning",
    "setProject",
    "setActiveEntity",
    "setRefineText",
    "setAdditionalRequest",
    "setRefineRunning",
    "setView",
    "project",
    "purgeEntityPreferences",
    "migrateEntityPreferencesForCaseRename",
    `${code}\nreturn handleBuildComplete;`,
  )(
    true,
    { current: "add a discount field" },
    { current: [{ agent: "Architect", status: "running", message: "…", detail: { providerName: "anthropic-fallback" } }] },
    (key: string) => key,
    summarizeRefineImpact,
    extractRefineProviderName,
    (updater: (prev: Array<{ providerName: string | null }>) => Array<{ providerName: string | null }>) => {
      historyEntries.push(...updater([]));
    },
    () => {}, // setBuildWarning
    () => {}, // setProject
    () => {}, // setActiveEntity
    () => {}, // setRefineText
    () => {}, // setAdditionalRequest
    () => {}, // setRefineRunning
    () => {}, // setView
    // null: this test is scoped to the providerName history-entry logic,
    // not round 853's dropped-entity-preference purge -- see the sibling
    // test above for why null is safe here too.
    null,
    () => {},
    () => {},
  ) as (builtProject: Project) => void;

  fn(makeProject([makeEntity("Customer")]));
  assert.deepEqual(historyEntries.map((e) => e.providerName), ["anthropic-fallback"]);
});

/**
 * Round 853: a refine that drops an entity from an otherwise-surviving
 * project never purged that entity's own per-entity-keyed localStorage
 * preferences (column widths/order/hidden fields, filters, group-by,
 * collapsed board columns/groups, sort keys, view mode, recent searches)
 * -- unlike whole-project deletion, which projectPreferenceCleanup.ts
 * already sweeps thoroughly. See entityPreferenceCleanup.ts's own doc
 * comment for the full mechanism (migrate.ts's deliberate non-backfill of
 * NOT NULL meant round 798/852's own "an existing record keeps its file"
 * reasoning doesn't generalize here the other way -- a STALE PREFERENCE
 * can persist and silently reapply to a same-named entity reintroduced by
 * a later refine). Confirms handleBuildComplete calls purgeEntityPreferences
 * for exactly the entities present in the pre-refine project but absent
 * from the newly-built one, with the real project id, and never for an
 * entity that survived the refine.
 */
test("App's handleBuildComplete purges a dropped entity's own localStorage preferences, but never a surviving one's", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}function handleBuildComplete\(builtProject: Project, warning\?: string\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBuildComplete in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const purgedEntities: Array<[string, string]> = [];
  const fn = new Function(
    "refineRunning",
    "pendingRefineInstruction",
    "refineEvents",
    "t",
    "summarizeRefineImpact",
    "setRefineHistory",
    "setBuildWarning",
    "setProject",
    "setActiveEntity",
    "setRefineText",
    "setAdditionalRequest",
    "setRefineRunning",
    "setView",
    "project",
    "purgeEntityPreferences",
    "migrateEntityPreferencesForCaseRename",
    `${code}\nreturn handleBuildComplete;`,
  )(
    false,
    { current: null },
    { current: [] },
    (key: string) => key,
    summarizeRefineImpact,
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    makeProject([makeEntity("Customer"), makeEntity("Deal"), makeEntity("Invoice")]),
    (projectId: string, entityName: string) => {
      purgedEntities.push([projectId, entityName]);
    },
    () => {},
  ) as (builtProject: Project) => void;

  const rebuiltDroppingDealAndInvoice = makeProject([makeEntity("Customer")]);
  fn(rebuiltDroppingDealAndInvoice);

  assert.deepEqual(
    [...purgedEntities].sort(),
    [
      [rebuiltDroppingDealAndInvoice.id, "Deal"],
      [rebuiltDroppingDealAndInvoice.id, "Invoice"],
    ].sort(),
    "purgeEntityPreferences must be called once per dropped entity, with the built project's own id",
  );
  assert.equal(
    purgedEntities.some(([, entityName]) => entityName === "Customer"),
    false,
    "purgeEntityPreferences must never be called for an entity that survived the refine",
  );
});

/**
 * Round 988: a fresh Explore survey traced the established "a refine can
 * rename an entity by letter casing alone, a genuine no-op" hazard
 * (docs/roadmap.md rounds 946/947/949/954 -- pipeline.ts's and
 * checkpointDiff.ts's own diffing already tolerate this) to a 7th,
 * previously-unaudited locus: handleBuildComplete's own droppedEntityNames
 * computation and activeEntity fallback both used an EXACT name match,
 * which can't tell a case rename apart from the entity being removed
 * outright. Confirms a pure case rename (e.g. "Customer" -> "customer")
 * of the currently-active entity neither purges its real localStorage
 * preferences nor silently jumps the active tab to a different entity --
 * carrying the active tab forward under its new spelling instead.
 */
test("App's handleBuildComplete tolerates a pure letter-casing entity rename as a no-op, not as that entity being dropped", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}function handleBuildComplete\(builtProject: Project, warning\?: string\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBuildComplete in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function runHandleBuildCompleteForRename(initialActiveEntity: string | null, previousProject: Project, builtProject: Project) {
    let activeEntity: string | null = initialActiveEntity;
    const purgedEntities: Array<[string, string]> = [];
    const migratedEntities: Array<[string, string, string]> = [];
    const fn = new Function(
      "refineRunning",
      "pendingRefineInstruction",
      "refineEvents",
      "t",
      "summarizeRefineImpact",
      "setRefineHistory",
      "setBuildWarning",
      "setProject",
      "setActiveEntity",
      "setRefineText",
      "setAdditionalRequest",
      "setRefineRunning",
      "setView",
      "project",
      "purgeEntityPreferences",
      "migrateEntityPreferencesForCaseRename",
      `${code}\nreturn handleBuildComplete;`,
    )(
      false,
      { current: null },
      { current: [] },
      (key: string) => key,
      summarizeRefineImpact,
      () => {},
      () => {},
      () => {},
      (updater: string | null | ((prev: string | null) => string | null)) => {
        activeEntity = typeof updater === "function" ? (updater as (prev: string | null) => string | null)(activeEntity) : updater;
      },
      () => {},
      () => {},
      () => {},
      () => {},
      previousProject,
      (projectId: string, entityName: string) => {
        purgedEntities.push([projectId, entityName]);
      },
      (projectId: string, oldName: string, newName: string) => {
        migratedEntities.push([projectId, oldName, newName]);
      },
    ) as (builtProject: Project) => void;
    fn(builtProject);
    return { activeEntity, purgedEntities, migratedEntities };
  }

  const previousProject = makeProject([makeEntity("Customer"), makeEntity("Deal")]);
  const renamedProject = makeProject([makeEntity("customer"), makeEntity("Deal")]);

  const { activeEntity, purgedEntities, migratedEntities } = runHandleBuildCompleteForRename("Customer", previousProject, renamedProject);

  assert.equal(
    activeEntity,
    "customer",
    "the active tab must carry forward under the entity's new spelling, not silently jump to a different entity",
  );
  assert.deepEqual(
    purgedEntities,
    [],
    "a pure case rename must never be treated as that entity being dropped -- purgeEntityPreferences must not be called at all",
  );
  // Round 1029: the other half of this exact scenario -- round 988 only
  // ever stopped the wrongful purge; it never filled the resulting gap of
  // the real per-entity preferences becoming unreachable under their own
  // old key. Confirms migrateEntityPreferencesForCaseRename is called
  // with the built project's own id and the exact old/new name pair.
  assert.deepEqual(
    migratedEntities,
    [[renamedProject.id, "Customer", "customer"]],
    "migrateEntityPreferencesForCaseRename must be called once for the renamed entity, with its old and new spelling",
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
  // Round 928: handleBackToHome now also calls the separately-defined
  // closeAllPanels helper (cheap insurance against stale panel state --
  // see its own doc comment), a free variable from this extracted
  // handler's own point of view -- extracted alongside it, same
  // convention as the handleGoHome/subscribeAuthExpired tests.
  const helperMatch = appSrc.match(/ {2}function closeAllPanels\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(helperMatch, "expected to find closeAllPanels in App.tsx");
  const { code } = transformSync(`${helperMatch![0]}\n${handlerMatch![0]}`, { loader: "ts" });

  const state: {
    view: string;
    project: Project | null;
    specProvider: string | null;
    enhanceProvider: string | null;
    selectedAnswers: Record<string, string>;
    additionalRequest: string;
    showWhatsApp: boolean;
    whatsappPrefillTo: string | null;
  } = {
    view: "spec",
    project: makeProject([makeEntity("Customer")]),
    specProvider: "anthropic",
    enhanceProvider: "anthropic",
    selectedAnswers: { "Which plan?": "Pro" },
    additionalRequest: "also add a discount field",
    showWhatsApp: true,
    whatsappPrefillTo: "972501234567",
  };

  let setDescriptionCalls = 0;
  let buildWarning: string | null = "Seed Data: a real failure from the abandoned draft's own prior build";
  const fn = new Function(
    "setView",
    "setProject",
    "setSpecProvider",
    "setEnhanceProvider",
    "setSelectedAnswers",
    "setAdditionalRequest",
    "setBuildWarning",
    "setDescription",
    "setShowHistory",
    "setShowTwin",
    "setShowWhatsApp",
    "setShowAutomations",
    "setShowCollaborators",
    "setShowSearch",
    "setShowShortcuts",
    "setWhatsappPrefillTo",
    "setHighlightRecordId",
    "setCreatePrefill",
    "setCreateDateFilter",
    `${code}\nreturn handleBackToHome;`,
  )(
    (v: string) => (state.view = v),
    (p: Project | null) => (state.project = p),
    (v: string | null) => (state.specProvider = v),
    (v: string | null) => (state.enhanceProvider = v),
    (a: Record<string, string>) => (state.selectedAnswers = a),
    (r: string) => (state.additionalRequest = r),
    (w: string | null) => (buildWarning = w),
    () => {
      setDescriptionCalls += 1;
    },
    () => {},
    () => {},
    (v: boolean) => (state.showWhatsApp = v),
    () => {},
    () => {},
    () => {},
    () => {},
    (v: string | null) => (state.whatsappPrefillTo = v),
    () => {},
    () => {},
    () => {},
  ) as () => void;

  fn();

  assert.equal(state.view, "home", "must navigate back to the home view");
  assert.equal(state.project, null, "must clear the abandoned draft project, not leave it lingering in state");
  assert.equal(state.specProvider, null, "must clear the abandoned draft's own spec-provider info, not leave it lingering for whatever gets created next");
  assert.equal(state.enhanceProvider, null, "must clear the abandoned draft's own enhance-provider info too (round 402), for the same reason");
  assert.deepEqual(state.selectedAnswers, {}, "must clear answers tied to the abandoned draft's own open questions");
  assert.equal(state.additionalRequest, "", "must clear the additional-request text tied to the abandoned draft");
  assert.equal(
    buildWarning,
    null,
    "must clear a stale non-terminal build-warning banner from the abandoned draft's own prior build (round 469)",
  );
  assert.equal(setDescriptionCalls, 0, "must never touch description -- the typed idea text should survive going back");
  assert.equal(state.showWhatsApp, false, "round 928: must also close any leftover open panel");
  assert.equal(state.whatsappPrefillTo, null, "round 928: must also clear any leftover staged panel payload");
});

/**
 * New in this round: once a project was built, there was no way back to
 * "Your projects" short of logging all the way out and back in -- the
 * topbar's own brand logo was purely decorative, and handleBackToHome
 * above only ever runs from the spec review screen's own Back button.
 * Extracts the real handleGoHome function the same way the test above
 * does, and confirms it resets the same fields handleBackToHome does
 * PLUS the preview-only fields handleLogout's own cleanup already
 * described (activeEntity, refineText, refineHistory,
 * refineHistorySearch) -- the exact leftover-state bug that cleanup was
 * written to prevent, now relevant here too since this can navigate away
 * from a live preview screen those fields actually got used on.
 */
test("App's handleGoHome resets view/project/selectedAnswers/additionalRequest AND the preview-only refine/activeEntity state, but leaves description untouched", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}function handleGoHome\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleGoHome in App.tsx");
  // Round 928: handleGoHome now calls the separately-defined closeAllPanels
  // helper (a free variable from handleGoHome's own extracted body's point
  // of view) -- extracted alongside it, same as this file's own convention
  // elsewhere for a handler that calls a cooperating helper, rather than
  // stubbing it out and losing real coverage of what it actually resets.
  const helperMatch = appSrc.match(/ {2}function closeAllPanels\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(helperMatch, "expected to find closeAllPanels in App.tsx");
  const { code } = transformSync(`${helperMatch![0]}\n${handlerMatch![0]}`, { loader: "ts" });

  const state: {
    view: string;
    project: Project | null;
    specProvider: string | null;
    enhanceProvider: string | null;
    selectedAnswers: Record<string, string>;
    additionalRequest: string;
    activeEntity: string | null;
    refineText: string;
    refineHistory: unknown[];
    refineHistorySearch: string;
    showHistory: boolean;
    showTwin: boolean;
    showWhatsApp: boolean;
    showAutomations: boolean;
    showCollaborators: boolean;
    showSearch: boolean;
    showShortcuts: boolean;
    whatsappPrefillTo: string | null;
    highlightRecordId: number | null;
    createPrefill: unknown;
  } = {
    view: "preview",
    project: makeProject([makeEntity("Customer")]),
    specProvider: "anthropic",
    enhanceProvider: "anthropic",
    selectedAnswers: { "Which plan?": "Pro" },
    additionalRequest: "also add a discount field",
    activeEntity: "Customer",
    refineText: "add a loyalty field",
    refineHistory: [{ instruction: "add invoices", createdAt: "2026-01-01" }],
    refineHistorySearch: "invoices",
    // Round 928: simulates a panel left open (and WhatsApp prefilled) from
    // the project being abandoned -- the exact leftover state that used to
    // silently pop back open, unprompted, on whatever project opens next.
    showHistory: false,
    showTwin: false,
    showWhatsApp: true,
    showAutomations: false,
    showCollaborators: false,
    showSearch: false,
    showShortcuts: false,
    whatsappPrefillTo: "972501234567",
    highlightRecordId: 42,
    createPrefill: { fieldName: "phone", value: "972501234567" },
  };

  let setDescriptionCalls = 0;
  let buildWarning: string | null = "Seed Data: a real failure from the left-behind project";
  const fn = new Function(
    "setView",
    "setProject",
    "setSpecProvider",
    "setEnhanceProvider",
    "setSelectedAnswers",
    "setAdditionalRequest",
    "setActiveEntity",
    "setRefineText",
    "setRefineHistory",
    "setRefineHistorySearch",
    "setBuildWarning",
    "setDescription",
    "setShowHistory",
    "setShowTwin",
    "setShowWhatsApp",
    "setShowAutomations",
    "setShowCollaborators",
    "setShowSearch",
    "setShowShortcuts",
    "setWhatsappPrefillTo",
    "setHighlightRecordId",
    "setCreatePrefill",
    "setCreateDateFilter",
    `${code}\nreturn handleGoHome;`,
  )(
    (v: string) => (state.view = v),
    (p: Project | null) => (state.project = p),
    (v: string | null) => (state.specProvider = v),
    (v: string | null) => (state.enhanceProvider = v),
    (a: Record<string, string>) => (state.selectedAnswers = a),
    (r: string) => (state.additionalRequest = r),
    (e: string | null) => (state.activeEntity = e),
    (r: string) => (state.refineText = r),
    (h: unknown[]) => (state.refineHistory = h),
    (s: string) => (state.refineHistorySearch = s),
    (w: string | null) => (buildWarning = w),
    () => {
      setDescriptionCalls += 1;
    },
    (v: boolean) => (state.showHistory = v),
    (v: boolean) => (state.showTwin = v),
    (v: boolean) => (state.showWhatsApp = v),
    (v: boolean) => (state.showAutomations = v),
    (v: boolean) => (state.showCollaborators = v),
    (v: boolean) => (state.showSearch = v),
    (v: boolean) => (state.showShortcuts = v),
    (v: string | null) => (state.whatsappPrefillTo = v),
    (v: number | null) => (state.highlightRecordId = v),
    (v: unknown) => (state.createPrefill = v),
    () => {},
  ) as () => void;

  fn();

  assert.equal(state.showWhatsApp, false, "must close a panel left open on the abandoned project, or it silently pops back open on whatever project opens next");
  assert.equal(state.whatsappPrefillTo, null, "must clear a stale prefilled phone number carried over from the abandoned project's own record");
  assert.equal(state.highlightRecordId, null);
  assert.equal(state.createPrefill, null);

  assert.equal(state.view, "home", "must navigate back to the home view from the live preview screen, not just spec review");
  assert.equal(state.project, null, "must clear the project being left behind");
  assert.equal(state.specProvider, null, "must clear the left-behind project's own spec-provider info");
  assert.equal(state.enhanceProvider, null, "must clear the left-behind project's own enhance-provider info too (round 402)");
  assert.deepEqual(state.selectedAnswers, {}, "must clear answers tied to the left-behind project's own open questions");
  assert.equal(state.additionalRequest, "", "must clear the additional-request text tied to the left-behind project");
  assert.equal(state.activeEntity, null, "must clear the stale active entity tab, or the next project opened could render a blank preview pane");
  assert.equal(state.refineText, "", "must clear the half-typed refine instruction");
  assert.deepEqual(state.refineHistory, [], "must clear the left-behind project's own refine history, not carry it into the next project opened");
  assert.equal(state.refineHistorySearch, "", "must clear the refine-history search box too");
  assert.equal(
    buildWarning,
    null,
    "must clear a non-terminal build-warning banner from the left-behind project (round 469) -- otherwise it falsely re-appears on whatever project is opened next",
  );
  assert.equal(setDescriptionCalls, 0, "must never touch description -- the home screen's own saved idea draft is a separate concern");
});

/**
 * Round 801: the identical "selectedAnswers/additionalRequest answered the
 * now-abandoned draft's own open questions, not whatever comes next"
 * cleanup handleBackToHome/handleGoHome/the auth-expiry effect/
 * handleAccountDeleted all already carry (each with their own near-
 * identical comment) was missing from the one other path that also lands
 * back on the spec-review screen: BuildProgress's own "Back" button after
 * a failed build, wired as a bare `onBack={() => setView("spec")}` with
 * no cleanup at all. POST /projects/:id/answers (routes/projects.ts) calls
 * generateSpec() again and fully replaces project.spec, including a
 * brand-new openQuestions array -- different questions, different count,
 * different order from whatever selectedAnswers was keyed against (by
 * array index) before this build attempt. Left uncleared, re-submitting
 * Build after clicking Back pairs a NEW question at index i with a STALE
 * answer written for a completely different, now-gone question at that
 * same index, silently feeding a mismatched pair into the next real
 * generateSpec() call. Extracts the real onBack callback passed to
 * BuildProgress for the "building" view the same way the handler tests
 * above extract whole functions.
 */
test("App's building-view onBack clears selectedAnswers/additionalRequest before returning to spec review, the same cleanup handleBackToHome/handleGoHome already do", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const onBackMatch = appSrc.match(/onBack=\{\(\) => \{[\s\S]*?\n {10}\}\}\n/);
  assert.ok(onBackMatch, "expected to find the building view's onBack callback in App.tsx");
  // Strips the JSX attribute's own wrapping "onBack={" / trailing "}" --
  // the arrow function's own matching braces (`() => { ... }`) are left
  // intact, producing a plain, directly assignable arrow function.
  const innerFn = onBackMatch![0].replace(/^onBack=\{/, "").replace(/\}\n$/, "\n");
  const { code } = transformSync(`const onBack = ${innerFn};`, { loader: "ts" });

  const state: { view: string; selectedAnswers: Record<string, string>; additionalRequest: string } = {
    view: "building",
    selectedAnswers: { "0": "Yes, add loyalty points" },
    additionalRequest: "also support refunds",
  };

  const fn = new Function(
    "setSelectedAnswers",
    "setAdditionalRequest",
    "setView",
    `${code}\nreturn onBack;`,
  )(
    (a: Record<string, string>) => (state.selectedAnswers = a),
    (r: string) => (state.additionalRequest = r),
    (v: string) => (state.view = v),
  ) as () => void;

  fn();

  assert.equal(state.view, "spec", "must still navigate back to the spec-review screen");
  assert.deepEqual(state.selectedAnswers, {}, "must clear answers keyed against the pre-/answers openQuestions array, which /answers just replaced with a different one");
  assert.equal(state.additionalRequest, "", "must clear the additional-request text that was already incorporated into the spec /answers just generated");
});

/**
 * Round 403: DELETE /auth/account deletes every project the account owns
 * server-side via the exact same cascade handleDeleteProject/
 * handleBulkDeleteProjects use -- but unlike those two, handleAccountDeleted
 * never called purgeProjectPreferences, so this account's own entries in
 * every one of projectPreferenceCleanup.ts's localStorage stores sat there
 * forever. Confirms purgeProjectPreferences is now called once per owned
 * project id DeleteAccountPanel hands back, before the existing local
 * UI-state reset runs. Round 423 extended this same handler to also purge
 * every merely-shared project id (the server's own removeAllCollaborationsForUser
 * revokes this account's access to those too).
 *
 * Round 1124: extended to confirm clearProjectSortMode/clearProjectStatusFilter
 * are called too -- unlike handleLogout/the auth-expiry effect (which
 * deliberately never clear these two, since round 1057's whole point in
 * keying them per user was so the preference survives a logout and a
 * later re-login to the SAME account), this path permanently destroys the
 * account, so leaving them behind is pure leak, not the feature it is
 * everywhere else. See projectSortMode.ts's own clearProjectSortMode doc
 * comment for the full reasoning.
 *
 * Round 1125: the owned/shared ids no longer go through the SAME function.
 * `purgeProjectPreferences` (the broad, "assume the project itself is
 * gone" sweep) is still correct for owned ids -- DELETE /auth/account
 * really does delete every one of them. But a merely-shared project is
 * NOT gone -- only this account's own grant on it is revoked -- so
 * routing it through the broad sweep would silently corrupt a DIFFERENT,
 * still-active collaborator's own pinned-project star or "new share"
 * acknowledgment on a browser shared between accounts. Shared ids now go
 * through `purgeOwnProjectAccess(userId, id)` instead -- see its own doc
 * comment in projectPreferenceCleanup.ts.
 */
test("App's handleAccountDeleted purges client-side preferences for every owned project id via the broad sweep, and every shared project id via the narrower own-access-only sweep, then resets local UI state", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(
    / {2}function handleAccountDeleted\(ownedProjectIds: string\[\], sharedProjectIds: string\[\]\) \{[\s\S]*?\n {2}\}\n/,
  );
  assert.ok(handlerMatch, "expected to find handleAccountDeleted in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const state: {
    purgeCalls: string[];
    ownAccessPurgeCalls: [string, string][];
    tokenCleared: boolean;
    showDeleteAccount: boolean;
    user: unknown;
    project: unknown;
    view: string | null;
    ideaDraftClearedForUserId: unknown;
    recentProjectSearchesClearedForUserId: unknown;
    sortModeClearedForUserId: unknown;
    statusFilterClearedForUserId: unknown;
  } = {
    purgeCalls: [],
    ownAccessPurgeCalls: [],
    tokenCleared: false,
    showDeleteAccount: true,
    user: { id: "user1" },
    project: { id: "p1" },
    view: "preview",
    ideaDraftClearedForUserId: "untouched",
    recentProjectSearchesClearedForUserId: "untouched",
    sortModeClearedForUserId: "untouched",
    statusFilterClearedForUserId: "untouched",
  };
  const noop = () => {};
  const fn = new Function(
    "user",
    "purgeProjectPreferences",
    "purgeOwnProjectAccess",
    "clearToken",
    "setShowDeleteAccount",
    "setUser",
    "setProject",
    "setView",
    "setDescription",
    "clearIdeaDraft",
    "clearRecentProjectSearches",
    "setRecentProjectSearches",
    "setError",
    "setActiveEntity",
    "setSelectedAnswers",
    "setAdditionalRequest",
    "setRefineText",
    "setRefineHistory",
    "setRefineHistorySearch",
    "clearProjectSortMode",
    "clearProjectStatusFilter",
    `${code}\nreturn handleAccountDeleted;`,
  )(
    { id: "user1" },
    (id: string) => state.purgeCalls.push(id),
    (userId: string, id: string) => state.ownAccessPurgeCalls.push([userId, id]),
    () => (state.tokenCleared = true),
    (v: boolean) => (state.showDeleteAccount = v),
    (v: unknown) => (state.user = v),
    (v: unknown) => (state.project = v),
    (v: string) => (state.view = v),
    noop,
    (id: string) => (state.ideaDraftClearedForUserId = id),
    (id: string) => (state.recentProjectSearchesClearedForUserId = id),
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    (id: string) => (state.sortModeClearedForUserId = id),
    (id: string) => (state.statusFilterClearedForUserId = id),
  ) as (ownedProjectIds: string[], sharedProjectIds: string[]) => void;

  fn(["p1", "p2", "p3"], ["p4", "p5"]);

  assert.deepEqual(
    state.purgeCalls,
    ["p1", "p2", "p3"],
    "must purge preferences for every OWNED project id via the broad sweep, since those really are deleted",
  );
  assert.deepEqual(
    state.ownAccessPurgeCalls,
    [
      ["user1", "p4"],
      ["user1", "p5"],
    ],
    "must purge only this account's own access for every SHARED project id, via the narrower sweep -- those projects are still alive for every other collaborator",
  );
  assert.equal(state.tokenCleared, true, "must still clear the now-dead token");
  assert.equal(state.showDeleteAccount, false, "must still close the panel");
  assert.equal(state.user, null, "must still clear the deleted user");
  assert.equal(state.project, null, "must still clear the deleted project");
  assert.equal(state.view, "home", "must still navigate back to the auth/home screen");
  assert.equal(
    state.ideaDraftClearedForUserId,
    "user1",
    "round 1129: must still clear this account's own idea draft -- unlike handleLogout/subscribeAuthExpired (which no longer clear it, per their own round-1129 doc comments), this account can never log back in to read it again",
  );
  assert.equal(
    state.recentProjectSearchesClearedForUserId,
    "user1",
    "round 1129: must still clear this account's own recent project searches too, for the identical reason",
  );
  assert.equal(
    state.sortModeClearedForUserId,
    "user1",
    "round 1124: must clear this account's own per-user sort-mode preference -- unlike handleLogout, the account can never log back in to read it again",
  );
  assert.equal(
    state.statusFilterClearedForUserId,
    "user1",
    "round 1124: must clear this account's own per-user status-filter preference, for the same reason",
  );

  const noneOwned = { purgeCalls: [] as string[] };
  const fnNoneOwned = new Function(
    "user",
    "purgeProjectPreferences",
    "purgeOwnProjectAccess",
    "clearToken",
    "setShowDeleteAccount",
    "setUser",
    "setProject",
    "setView",
    "setDescription",
    "clearIdeaDraft",
    "clearRecentProjectSearches",
    "setRecentProjectSearches",
    "setError",
    "setActiveEntity",
    "setSelectedAnswers",
    "setAdditionalRequest",
    "setRefineText",
    "setRefineHistory",
    "setRefineHistorySearch",
    "clearProjectSortMode",
    "clearProjectStatusFilter",
    `${code}\nreturn handleAccountDeleted;`,
  )(
    { id: "user1" },
    (id: string) => noneOwned.purgeCalls.push(id),
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
  ) as (ownedProjectIds: string[], sharedProjectIds: string[]) => void;
  fnNoneOwned([], []);
  assert.deepEqual(
    noneOwned.purgeCalls,
    [],
    "an account that owned no projects and shared in none either must never call purgeProjectPreferences at all",
  );
});

/**
 * Round 1129: no dedicated extracted-function test existed for
 * handleLogout before this round. Confirms it still resets the LIVE idea
 * description/recent-project-searches state (so a next, possibly
 * different, signed-in user on the same browser doesn't see this
 * session's half-typed text) but, unlike handleAccountDeleted just above,
 * deliberately does NOT call clearIdeaDraft/clearRecentProjectSearches at
 * all any more -- per-user keying (rounds 1044/1045) already means a
 * different account can never read this one's own entry, and clearing it
 * here would destroy the SAME user's own still-unsaved draft/searches on
 * an ordinary logout, exactly the regression this round fixes. Neither is
 * even declared as a parameter below: if a future change reintroduces
 * either call without updating this test, the extracted code throws a
 * ReferenceError (an undeclared free variable) instead of silently
 * passing, matching this routine's own "module-load crash is a strong
 * confirmation" convention.
 */
test("App's handleLogout resets local UI state, including the live idea description and recent project searches, without clearing either's own persisted per-user storage", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}async function handleLogout\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleLogout in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const state: {
    logoutCalled: boolean;
    user: unknown;
    project: unknown;
    buildWarning: unknown;
    view: string | null;
    description: unknown;
    error: unknown;
    activeEntity: unknown;
    selectedAnswers: unknown;
    additionalRequest: unknown;
    refineText: unknown;
    refineHistory: unknown;
    refineHistorySearch: unknown;
    recentProjectSearches: unknown;
  } = {
    logoutCalled: false,
    user: { id: "user1" },
    project: { id: "p1" },
    buildWarning: "untouched",
    view: "preview",
    description: "untouched",
    error: "untouched",
    activeEntity: "untouched",
    selectedAnswers: "untouched",
    additionalRequest: "untouched",
    refineText: "untouched",
    refineHistory: "untouched",
    refineHistorySearch: "untouched",
    recentProjectSearches: "untouched",
  };

  const fn = new Function(
    "user",
    "logout",
    "setUser",
    "setProject",
    "setBuildWarning",
    "setView",
    "setDescription",
    "setError",
    "setActiveEntity",
    "setSelectedAnswers",
    "setAdditionalRequest",
    "setRefineText",
    "setRefineHistory",
    "setRefineHistorySearch",
    "setRecentProjectSearches",
    `${code}\nreturn handleLogout;`,
  )(
    { id: "user1" },
    async () => {
      state.logoutCalled = true;
    },
    (v: unknown) => (state.user = v),
    (v: unknown) => (state.project = v),
    (v: unknown) => (state.buildWarning = v),
    (v: string) => (state.view = v),
    (v: unknown) => (state.description = v),
    (v: unknown) => (state.error = v),
    (v: unknown) => (state.activeEntity = v),
    (v: unknown) => (state.selectedAnswers = v),
    (v: unknown) => (state.additionalRequest = v),
    (v: unknown) => (state.refineText = v),
    (v: unknown) => (state.refineHistory = v),
    (v: unknown) => (state.refineHistorySearch = v),
    (v: unknown) => (state.recentProjectSearches = v),
  ) as () => Promise<void>;

  await fn();

  assert.equal(state.logoutCalled, true, "must call the API's own logout() to revoke the session server-side");
  assert.equal(state.user, null, "must clear the signed-in user");
  assert.equal(state.project, null, "must clear the open project");
  assert.equal(state.buildWarning, null, "must clear any stale build-warning banner");
  assert.equal(state.view, "home", "must reset view to home");
  assert.equal(state.description, "", "must clear the LIVE idea description so it doesn't leak into a next session on this same tab");
  assert.equal(state.error, null, "must clear any stale error banner");
  assert.equal(state.activeEntity, null, "must clear activeEntity");
  assert.deepEqual(state.selectedAnswers, {});
  assert.equal(state.additionalRequest, "");
  assert.equal(state.refineText, "");
  assert.deepEqual(state.refineHistory, []);
  assert.equal(state.refineHistorySearch, "");
  assert.deepEqual(state.recentProjectSearches, [], "must clear the LIVE recentProjectSearches state too, same as the idea description above");
});

/**
 * Round 404: self-service "leave project" (CollaboratorsPanel's own
 * handleLeave, wired here via the onLeft prop) ends in the exact same
 * state for this user as the three paths rounds 390/392/403 already
 * purge for -- no access to this project from this browser ever again --
 * but was never wired into purgeProjectPreferences, a 4th convergent
 * "project is gone" path round 403's own fix missed. Extracts the real
 * inline onLeft callback straight out of its JSX attribute (the same
 * "slice between JSX attributes" technique round 350 established, here
 * applied to a prop value instead of a plain string), rather than
 * reimplementing it.
 *
 * Round 1125: unlike owner-delete/bulk-delete/account-delete's own owned-
 * ids loop, the project this user just left is NOT gone -- it's still
 * fully alive for every other collaborator. Switched from the broad
 * purgeProjectPreferences to purgeOwnProjectAccess (scoped to just this
 * user's own pin/seen-share entries) for exactly that reason -- see its
 * own doc comment in projectPreferenceCleanup.ts. Confirms the real
 * userId is passed through, not just the project id.
 */
test("App's CollaboratorsPanel onLeft callback purges only this user's own access to the left project before navigating home, leaving the still-shared project's other preferences alone", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {14}onLeft=\{(\(\) => \{[\s\S]*?\n {14}\})\}\n/);
  assert.ok(handlerMatch, "expected to find the CollaboratorsPanel onLeft callback in App.tsx");
  const { code } = transformSync(handlerMatch![1], { loader: "ts" });

  const state: { ownAccessPurgeCalls: [string, string][]; showCollaborators: boolean; goHomeCalls: number } = {
    ownAccessPurgeCalls: [],
    showCollaborators: true,
    goHomeCalls: 0,
  };
  const project = { id: "shared-project-1" };
  const user = { id: "user1" };
  const fn = new Function(
    "purgeOwnProjectAccess",
    "setShowCollaborators",
    "handleGoHome",
    "project",
    "user",
    `return ${code}`,
  )(
    (userId: string, id: string) => state.ownAccessPurgeCalls.push([userId, id]),
    (v: boolean) => (state.showCollaborators = v),
    () => (state.goHomeCalls += 1),
    project,
    user,
  ) as () => void;

  fn();

  assert.deepEqual(
    state.ownAccessPurgeCalls,
    [["user1", "shared-project-1"]],
    "must purge only this user's own access to exactly the project just left, not the broad every-collaborator sweep",
  );
  assert.equal(state.showCollaborators, false, "must still close the collaborators panel");
  assert.equal(state.goHomeCalls, 1, "must still navigate home the same way it always did");
});

/**
 * Round 612: a 5th convergent "this browser can never reach this project
 * again" path round 403/404's own purgeProjectPreferences sweep missed --
 * the project's OWNER removing a DIFFERENT user as a collaborator
 * (CollaboratorsPanel's handleRemove, a DELETE the owner's own browser
 * sends) happens entirely in the owner's session. The removed
 * collaborator's own browser has no websocket/push to learn about it
 * synchronously; the only place it ever finds out is this home-screen
 * effect's own next listProjects() call simply omitting that project id.
 * Before this round, the effect only ever overwrote myProjects with
 * whatever came back, never noticing an id that used to be there is now
 * gone, so that id's ~18 localStorage preference entries (pinned,
 * column widths/order, filters, sort keys, recent searches, ...) sat there
 * forever -- the exact same unbounded-growth leak the other four call
 * sites already exist to prevent. Extracts the real effect callback
 * straight out of App.tsx rather than reimplementing it.
 */
test("App's listProjects home-screen effect purges preferences for a project that silently vanished from the list (e.g. this browser's own collaborator access was revoked)", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(
    / {2}useEffect\(\(\) => \{\n {4}if \(!user \|\| view !== "home"\) return;\n {4}listProjects\(\)[\s\S]*?\n {2}\}, \[user, view\]\);\n/,
  );
  assert.ok(handlerMatch, "expected to find the listProjects home-screen effect in App.tsx");
  const bodyMatch = handlerMatch![0].match(/useEffect\((\(\) => \{[\s\S]*?\})\, \[user, view\]\);\n$/);
  assert.ok(bodyMatch, "expected to extract the effect's own callback body");
  const { code } = transformSync(bodyMatch![1], { loader: "ts" });

  function run(
    user: object | null,
    view: string,
    projects: Project[],
    previouslySeenIds: string[],
  ): Promise<{ purgeCalls: string[]; myProjects: Project[] | "not-yet-called" }> {
    const state: { purgeCalls: string[]; myProjects: Project[] | "not-yet-called" } = {
      purgeCalls: [],
      myProjects: "not-yet-called",
    };
    const myProjectIdsRef = { current: new Set(previouslySeenIds) };
    // The effect's own callback is NOT async -- it fires listProjects().then(...)
    // as an unawaited promise chain and returns undefined, matching a real
    // useEffect's own signature. Capturing the exact promise listProjects()
    // itself returns (not a fresh one) and awaiting THAT -- rather than
    // awaiting fn()'s own return value, which is undefined -- guarantees the
    // effect's own .then(cb) (attached synchronously inside fn(), before this
    // function's own .then() below is attached) finishes first: promise
    // reactions always run in attachment order.
    let listProjectsPromise: Promise<{ projects: Project[] }> | undefined;
    const fn = new Function(
      "user",
      "view",
      "listProjects",
      "setMyProjects",
      "myProjectIdsRef",
      "purgeProjectPreferences",
      `return ${code}`,
    )(
      user,
      view,
      () => (listProjectsPromise = Promise.resolve({ projects })),
      (updater: Project[] | ((prev: Project[]) => Project[])) =>
        (state.myProjects = typeof updater === "function" ? (updater as (prev: Project[]) => Project[])([]) : updater),
      myProjectIdsRef,
      (id: string) => state.purgeCalls.push(id),
    ) as () => void;
    fn();
    return listProjectsPromise!.then(() => state);
  }

  const kept = makeProject([makeEntity("Customer")]);
  kept.id = "kept-project";
  const revoked = makeProject([makeEntity("Customer")]);
  revoked.id = "revoked-project";

  // First-ever fetch (nothing seen before): must never purge anything,
  // since there's no "previous" list to diff against yet.
  const first = await run({}, "home", [kept, revoked], []);
  assert.deepEqual(first.purgeCalls, [], "the very first fetch must never purge -- there is no prior list to compare against");
  assert.deepEqual(first.myProjects, [kept, revoked]);

  // Second fetch: "revoked-project" is simply gone from the response (this
  // browser's own collaborator access was removed by the owner elsewhere).
  const second = await run({}, "home", [kept], ["kept-project", "revoked-project"]);
  assert.deepEqual(
    second.purgeCalls,
    ["revoked-project"],
    "a project id present in the previous fetch but missing from this one must be purged",
  );
  assert.deepEqual(second.myProjects, [kept]);

  // A project present in both fetches must never be purged.
  const unchanged = await run({}, "home", [kept], ["kept-project"]);
  assert.deepEqual(unchanged.purgeCalls, [], "a project still present in the fresh list must never be purged");
});

/**
 * Regression test (round 469): round 468 added `buildWarning` (a real,
 * non-terminal agent-step-failure notice -- see BuildProgress.tsx) but only
 * ever threaded it into the functions that START a fresh build/refine/
 * logout. Restoring an older checkpoint via Time Machine's own onRestored
 * callback is a 4th convergent "the screen's content just changed out from
 * under the user" path that missed it -- a warning from a LATER build
 * would otherwise keep showing after restoring to an earlier checkpoint it
 * never actually applied to. Extracts the real inline onRestored callback
 * the same "slice between JSX attributes" technique the onLeft test above
 * uses, rather than reimplementing it.
 */
test("App's HistoryPanel onRestored callback clears a stale build-warning banner along with setting the restored project", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {14}onRestored=\{\((restored\) => \{[\s\S]*?\n {14}\})\}\n/);
  assert.ok(handlerMatch, "expected to find the HistoryPanel onRestored callback in App.tsx");
  const { code } = transformSync(`(${handlerMatch![1]}`, { loader: "ts" });

  const state: { project: unknown; activeEntity: string | null; buildWarning: string | null; showHistory: boolean } = {
    project: null,
    activeEntity: null,
    buildWarning: "Seed Data: a real failure from a later build, not the one being restored to",
    showHistory: true,
  };
  const fn = new Function(
    "setProject",
    "setActiveEntity",
    "setBuildWarning",
    "setShowHistory",
    "project",
    "purgeEntityPreferences",
    "migrateEntityPreferencesForCaseRename",
    `return ${code}`,
  )(
    (p: unknown) => (state.project = p),
    (e: string | null) => (state.activeEntity = e),
    (w: string | null) => (state.buildWarning = w),
    (v: boolean) => (state.showHistory = v),
    makeProject([makeEntity("Customer")]),
    () => {},
    () => {},
  ) as (restored: { id: string; spec: { entities: { name: string }[] } }) => void;

  const restoredProject = { id: "proj1", spec: { entities: [{ name: "Customer" }] } };
  fn(restoredProject);

  assert.equal(state.project, restoredProject, "must still set the restored project, same as before");
  assert.equal(state.activeEntity, "Customer", "must still pick the restored spec's first entity, same as before");
  assert.equal(
    state.buildWarning,
    null,
    "must clear a stale build-warning banner from a later build that doesn't apply to the checkpoint just restored to",
  );
  assert.equal(state.showHistory, false, "must still close the history panel, same as before");
});

/**
 * New in this round (866): restoring an older Time Machine checkpoint is,
 * like a refine (handleBuildComplete's own round-853 purge above), a normal
 * way for an entity to disappear from the live spec -- routes/projects.ts's
 * own restore-checkpoint comment explicitly names "missing an entity/field
 * the user has been actively using" as an expected outcome. Confirms
 * onRestored now calls purgeEntityPreferences for exactly the entities
 * present in the pre-restore project but absent from the restored one, with
 * the restored project's own id, and never for an entity that survived.
 */
test("App's HistoryPanel onRestored callback purges a dropped entity's own localStorage preferences, but never a surviving one's", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {14}onRestored=\{\((restored\) => \{[\s\S]*?\n {14}\})\}\n/);
  assert.ok(handlerMatch, "expected to find the HistoryPanel onRestored callback in App.tsx");
  const { code } = transformSync(`(${handlerMatch![1]}`, { loader: "ts" });

  const purgedEntities: Array<[string, string]> = [];
  const fn = new Function(
    "setProject",
    "setActiveEntity",
    "setBuildWarning",
    "setShowHistory",
    "project",
    "purgeEntityPreferences",
    "migrateEntityPreferencesForCaseRename",
    `return ${code}`,
  )(
    () => {},
    () => {},
    () => {},
    () => {},
    makeProject([makeEntity("Customer"), makeEntity("Deal"), makeEntity("Invoice")]),
    (projectId: string, entityName: string) => {
      purgedEntities.push([projectId, entityName]);
    },
    () => {},
  ) as (restored: { id: string; spec: { entities: { name: string }[] } }) => void;

  const restoredDroppingDealAndInvoice = { id: "proj1", spec: { entities: [{ name: "Customer" }] } };
  fn(restoredDroppingDealAndInvoice);

  assert.deepEqual(
    [...purgedEntities].sort(),
    [
      [restoredDroppingDealAndInvoice.id, "Deal"],
      [restoredDroppingDealAndInvoice.id, "Invoice"],
    ].sort(),
    "purgeEntityPreferences must be called once per entity missing from the restored checkpoint, with the restored project's own id",
  );
  assert.equal(
    purgedEntities.some(([, entityName]) => entityName === "Customer"),
    false,
    "purgeEntityPreferences must never be called for an entity the restored checkpoint still has",
  );
});

/**
 * Round 988: the identical case-insensitive-rename fix as
 * handleBuildComplete's own sibling test above, ported to this callback's
 * own droppedEntityNames computation -- a checkpoint whose entity differs
 * from the live spec only by letter casing (e.g. "Customer" -> "customer")
 * is the same genuine no-op here too, not that entity being dropped.
 */
test("App's HistoryPanel onRestored callback tolerates a pure letter-casing entity rename as a no-op, not as that entity being dropped", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {14}onRestored=\{\((restored\) => \{[\s\S]*?\n {14}\})\}\n/);
  assert.ok(handlerMatch, "expected to find the HistoryPanel onRestored callback in App.tsx");
  const { code } = transformSync(`(${handlerMatch![1]}`, { loader: "ts" });

  const purgedEntities: Array<[string, string]> = [];
  const migratedEntities: Array<[string, string, string]> = [];
  const fn = new Function(
    "setProject",
    "setActiveEntity",
    "setBuildWarning",
    "setShowHistory",
    "project",
    "purgeEntityPreferences",
    "migrateEntityPreferencesForCaseRename",
    `return ${code}`,
  )(
    () => {},
    () => {},
    () => {},
    () => {},
    makeProject([makeEntity("Customer"), makeEntity("Deal")]),
    (projectId: string, entityName: string) => {
      purgedEntities.push([projectId, entityName]);
    },
    (projectId: string, oldName: string, newName: string) => {
      migratedEntities.push([projectId, oldName, newName]);
    },
  ) as (restored: { id: string; spec: { entities: { name: string }[] } }) => void;

  const restoredWithRenamedCustomer = { id: "proj1", spec: { entities: [{ name: "customer" }, { name: "Deal" }] } };
  fn(restoredWithRenamedCustomer);

  assert.deepEqual(
    purgedEntities,
    [],
    "a pure case rename must never be treated as that entity being dropped -- purgeEntityPreferences must not be called at all",
  );
  // Round 1029: mirrors handleBuildComplete's own identical fix -- see
  // entityPreferenceCleanup.ts's own migrateEntityPreferencesForCaseRename
  // doc comment for the full "case-only rename leaves real preference
  // data unreachable under its old key" mechanism.
  assert.deepEqual(
    migratedEntities,
    [[restoredWithRenamedCustomer.id, "Customer", "customer"]],
    "migrateEntityPreferencesForCaseRename must be called once for the renamed entity, with its old and new spelling",
  );
});

/**
 * New in this round: FieldLabelEditor.tsx's own record-form rendering
 * already marks a required field with a trailing " *" once a project is
 * built -- but the spec-review screen's entity summary, the one place a
 * person can still see this BEFORE committing to a build, just joined
 * field names with no distinction at all. Matches that exact convention.
 */
test("formatEntityFieldSummary marks each required field with a trailing ' *', matching FieldLabelEditor's own convention", () => {
  const fields: Field[] = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "notes", label: "Notes", type: "text", required: false },
    { name: "email", type: "text", required: true }, // no label -- falls back to the raw name
  ];
  assert.equal(formatEntityFieldSummary(fields), "Name *, Notes, email *");
});

test("formatEntityFieldSummary adds no markers at all when no field is required", () => {
  const fields: Field[] = [
    { name: "notes", label: "Notes", type: "text", required: false },
    { name: "tags", label: "Tags", type: "text", required: false },
  ];
  assert.equal(formatEntityFieldSummary(fields), "Notes, Tags");
});

/**
 * New in this round: "/" opens global search (a second, even more familiar
 * shortcut alongside Ctrl/Cmd+K -- the convention GitHub, Slack, and others
 * already use). isEditableEventTarget is the guard that keeps it from
 * hijacking a literal "/" typed into the refine box, a record's own text
 * field, or an enum <select>.
 */
function fakeTarget(props: { tagName?: string; isContentEditable?: boolean }): EventTarget {
  return props as unknown as EventTarget;
}

test("isEditableEventTarget recognizes INPUT/TEXTAREA/SELECT and contentEditable targets, but not a plain element or null", () => {
  assert.equal(isEditableEventTarget(null), false, "no target at all must not count as editable");
  assert.equal(isEditableEventTarget(fakeTarget({ tagName: "DIV" })), false, "an ordinary element must not count as editable");
  assert.equal(isEditableEventTarget(fakeTarget({ tagName: "INPUT" })), true);
  assert.equal(isEditableEventTarget(fakeTarget({ tagName: "TEXTAREA" })), true);
  assert.equal(isEditableEventTarget(fakeTarget({ tagName: "SELECT" })), true);
  assert.equal(
    isEditableEventTarget(fakeTarget({ tagName: "DIV", isContentEditable: true })),
    true,
    "a contentEditable div must count as editable even though its tagName isn't a form control",
  );
  assert.equal(isEditableEventTarget(fakeTarget({ tagName: "input" })), false, "a lowercase tagName must not match -- real DOM elements always report it uppercase");
});

/**
 * Regression test: the topbar's brand-logo "go home" link was already
 * deliberately disabled during a full-page build (view === "building"),
 * but the condition never checked refineRunning -- so during a refine
 * (view stays "preview", refineRunning is true, and a COMPACT
 * BuildProgress streams inline on that same screen) the logo stayed
 * clickable, letting handleGoHome unmount that compact BuildProgress
 * while its streamRefine() request was still in flight. Covers every
 * view, not just the two that mattered before, so a future new view
 * doesn't silently slip through unconsidered either.
 */
test("canNavigateHome blocks the go-home link on \"home\" and \"building\", and on any view while a refine is running", () => {
  assert.equal(canNavigateHome("home", false), false, "already home -- nothing to navigate to");
  assert.equal(canNavigateHome("building", false), false, "a full-page build is actively streaming");
  assert.equal(canNavigateHome("spec", false), true, "spec review has no streaming BuildProgress to interrupt");
  assert.equal(canNavigateHome("preview", false), true, "an idle preview screen is safe to leave");
  assert.equal(canNavigateHome("preview", true), false, "a refine's own compact BuildProgress is streaming on this exact view");
  assert.equal(canNavigateHome("spec", true), false, "refineRunning must block every view, not just preview, in case a future view can also host a live refine");
  assert.equal(canNavigateHome("building", true), false, "both guards agreeing is still blocked");
});

/**
 * Static-wiring test: confirms the real brand-logo link in App.tsx's JSX
 * actually calls canNavigateHome(view, refineRunning) to decide whether to
 * render a clickable <button> vs. plain unclickable text, rather than some
 * other condition that silently drifts from canNavigateHome's own rules.
 */
test("App's brand-logo link renders as a real button only when canNavigateHome(view, refineRunning) is true", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(
    appSrc,
    /return canNavigateHome\(view, refineRunning\) \? \(\s*<button type="button" className="brand-row brand-row-link" onClick=\{handleGoHome\}/,
    "expected the brand-logo link to be gated on canNavigateHome(view, refineRunning)",
  );
});

/**
 * Static-wiring test (not DOM-driven, matching this file's own
 * handleBackToHome/handleGoHome convention for App.tsx's internal
 * useEffect-scoped logic): confirms the real generated keydown handler
 * actually checks isEditableEventTarget(e.target) before opening search on
 * "/", and that Ctrl/Cmd+K remains completely unguarded (a command-palette
 * shortcut is expected to fire even from inside a text field, unlike a
 * bare printable key).
 */
test("App's preview keydown handler opens global search on '/' only when the event target isn't an editable field", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(
    appSrc,
    /if \(e\.key === "\/" && !isEditableEventTarget\(e\.target\)\) \{\s*e\.preventDefault\(\);\s*openPanel\("search"\);\s*return;\s*\}/,
    "expected the '/' branch to guard on isEditableEventTarget before opening search",
  );
  // Ctrl/Cmd+K must still have no such guard -- it must work from anywhere.
  const ctrlKBranch = appSrc.match(/if \(\(e\.ctrlKey \|\| e\.metaKey\) && e\.key\.toLowerCase\(\) === "k"\) \{[\s\S]*?\n {6}\}/)?.[0];
  assert.ok(ctrlKBranch, "expected to find the Ctrl/Cmd+K branch");
  assert.doesNotMatch(ctrlKBranch!, /isEditableEventTarget/, "Ctrl/Cmd+K must remain unguarded, unlike the new '/' shortcut");
});

/**
 * "?" opens a real cheat-sheet of every keyboard shortcut in the app
 * (round 200), reusing the same isEditableEventTarget guard "/" already
 * established (round 199) -- a bare "?" is just as ordinary a character
 * to type into a text field as "/". Also confirms openPanel's own
 * six-way exclusivity actually includes "shortcuts" (a seventh panel
 * accidentally left able to stack alongside the other five would defeat
 * the entire point of routing every open through one place, per this
 * file's own round-68 doc comment on openPanel).
 *
 * Escape-to-close used to be asserted here too (a window-level branch in
 * this same handler, enumerating six of the app's eight dialogs by hand).
 * Round 290 moved it into useDialogFocusTrap.ts instead -- every dialog
 * built on that shared hook gets it uniformly now, including
 * ChangePassword/DeleteAccount, which this old branch never covered and
 * which are reachable outside `view === "preview"` (where this whole
 * handler is scoped) in the first place. See useDialogFocusTrap.test.ts
 * for Escape's own coverage now.
 */
test("App's preview keydown handler opens the shortcuts cheat-sheet on '?' (guarded like '/'), and openPanel's exclusivity includes it", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(
    appSrc,
    /if \(e\.key === "\?" && !isEditableEventTarget\(e\.target\)\) \{\s*e\.preventDefault\(\);\s*openPanel\("shortcuts"\);\s*return;\s*\}/,
    "expected the '?' branch to guard on isEditableEventTarget before opening the shortcuts panel",
  );

  const openPanelMatch = appSrc.match(/function openPanel\(panel: "history" \| "twin" \| "whatsapp" \| "automations" \| "collaborators" \| "search" \| "shortcuts"\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(openPanelMatch, "expected openPanel's own type union to include 'shortcuts'");
  assert.match(openPanelMatch![0], /setShowShortcuts\(panel === "shortcuts"\);/);
});

/**
 * Round 366 regression: Ctrl/Cmd+K, "/", and "?" all route through
 * openPanel(), which is already mutually exclusive among its own six
 * panels -- swapping between THOSE is intentional UX (Ctrl+K while History
 * is open almost certainly means "I want Search now"). But
 * ChangePassword/DeleteAccount aren't opened via openPanel at all (their
 * own topbar buttons set showChangePassword/showDeleteAccount directly,
 * independent of `view`), and useDialogFocusTrap.ts's own isAnyDialogOpen()
 * counter (round 365) is the one thing both routes actually share. Before
 * this fix, pressing "?" or Ctrl+K while a delete-account confirmation was
 * open stacked ShortcutsPanel/GlobalSearchPanel on top of it -- two
 * competing focus traps and two competing inert-background states at
 * once. Extracts the real handleKeyDown function (same technique as the
 * openPanel extraction test above) and runs it with a mock
 * isAnyDialogOpen, confirming openPanel is never called while it reports
 * true, for all three shortcuts, and that normal behavior is fully
 * restored the instant it reports false again.
 */
test("App's preview keydown handler (Ctrl+K, '/', '?') never opens a panel while isAnyDialogOpen() is true, and works normally once it's false", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/function handleKeyDown\(e: KeyboardEvent\) \{\s*if \(isAnyDialogOpen\(\)\) return;[\s\S]*?\n {4}\}\n/);
  assert.ok(handlerMatch, "expected to find the Ctrl+K/'/'/'?' handleKeyDown, starting with the isAnyDialogOpen() guard");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(eventInit: { key: string; ctrlKey?: boolean; metaKey?: boolean; target?: unknown }, dialogOpen: boolean) {
    const calls: string[] = [];
    const fn = new Function(
      "openPanel",
      "isEditableEventTarget",
      "isAnyDialogOpen",
      `${code}\nreturn handleKeyDown;`,
    )(
      (panel: string) => calls.push(panel),
      () => false,
      () => dialogOpen,
    ) as (e: unknown) => void;
    let preventDefaultCalls = 0;
    fn({ ...eventInit, preventDefault: () => (preventDefaultCalls += 1) });
    return { calls, preventDefaultCalls };
  }

  for (const eventInit of [{ key: "k", ctrlKey: true }, { key: "/" }, { key: "?" }]) {
    assert.deepEqual(
      run(eventInit, true),
      { calls: [], preventDefaultCalls: 0 },
      `${JSON.stringify(eventInit)} must never call openPanel (or even preventDefault) while isAnyDialogOpen() is true`,
    );
  }

  assert.deepEqual(run({ key: "k", ctrlKey: true }, false), { calls: ["search"], preventDefaultCalls: 1 }, "Ctrl+K must still open search normally once no dialog is open");
  assert.deepEqual(run({ key: "/" }, false), { calls: ["search"], preventDefaultCalls: 1 }, "'/' must still open search normally once no dialog is open");
  assert.deepEqual(run({ key: "?" }, false), { calls: ["shortcuts"], preventDefaultCalls: 1 }, "'?' must still open the shortcuts cheat-sheet normally once no dialog is open");
});

/**
 * Regression test for a real gap found by round 290's Explore survey:
 * the app's window-level Escape handler (removed this round, see above)
 * enumerated six of the app's eight `useDialogFocusTrap`-based dialogs by
 * hand -- ChangePassword and DeleteAccount were simply missing from that
 * list, and the handler only ran while `view === "preview"` in the first
 * place, while both of those two panels are reachable from every view via
 * the topbar (`{showChangePassword && <ChangePasswordPanel ... />}` sits
 * above the per-view blocks). ShortcutsPanel.tsx's own cheat-sheet
 * explicitly documents "Esc -> close" as a general app convention, which
 * was simply false for these two. Confirms every one of the app's 8
 * dialog-opening call sites now passes its own `onClose` through to
 * `useDialogFocusTrap`, so Escape closes all of them uniformly (the
 * hook's own new Escape-to-close behavior itself is tested directly in
 * useDialogFocusTrap.test.ts).
 */
test("App.tsx wires onClose into useDialogFocusTrap for every one of its 9 dialogs, including ChangePassword, ChangeEmail, and DeleteAccount", () => {
  const dialogFiles = [
    "BusinessTwinPanel.tsx",
    "ChangeEmailPanel.tsx",
    "ChangePasswordPanel.tsx",
    "CollaboratorsPanel.tsx",
    "DeleteAccountPanel.tsx",
    "GlobalSearchPanel.tsx",
    "HistoryPanel.tsx",
    "ShortcutsPanel.tsx",
    "WhatsAppPanel.tsx",
  ];
  for (const file of dialogFiles) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.match(
      src,
      /useDialogFocusTrap<HTMLDivElement>\(onClose\)/,
      `expected ${file} to pass its own onClose into useDialogFocusTrap so Escape closes it`,
    );
  }
});

/**
 * The browser tab's own title already changed per project
 * (documentTitle.ts), and the in-page WhatsApp badge already tracked
 * whatsappUnreadCount, but the two were never connected -- the tab title
 * never showed a Gmail/Slack-style "(N) " unread prefix visible from the
 * tab bar or alt-tab switcher while working in a different tab. Checks
 * the real source (not an extracted handler, since this lives inside a
 * useEffect's own body/deps, not a standalone function) for both the real
 * call passing whatsappUnreadCount through and the dependency array
 * actually including it -- a title effect with the right call but a stale
 * deps array would silently never re-run when the count changes.
 *
 * Round 900: the same gap existed for automationsFailingCount (round 710)
 * -- a standing automation failure (webhook down, WhatsApp disconnected)
 * is at least as worth surfacing from the tab bar/alt-tab switcher as an
 * unread WhatsApp message, by this same effect's own stated rationale,
 * but the title effect never depended on it at all.
 */
test("App.tsx's document-title effect passes both whatsappUnreadCount and automationsFailingCount into formatDocumentTitle and includes both in the effect's own dependency array", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(
    appSrc,
    /document\.title = formatDocumentTitle\(project\?\.name \?\? null, whatsappUnreadCount, automationsFailingCount\);/,
    "expected the title effect to pass both the real whatsappUnreadCount and automationsFailingCount through, not just the project name or only one count",
  );
  assert.match(
    appSrc,
    /document\.title = formatDocumentTitle\(project\?\.name \?\? null, whatsappUnreadCount, automationsFailingCount\);\s*\}, \[project, whatsappUnreadCount, automationsFailingCount\]\);/,
    "expected both whatsappUnreadCount and automationsFailingCount in the effect's own dependency array, or it would silently never re-run when either count changes",
  );
});

/**
 * Round 713: GlobalSearchPanel's own result groups and arrow-key
 * navigation order follow exactly the order of its `entities` prop (see
 * GlobalSearchPanel.tsx's runSearch -- `entities.map(...)` builds
 * `results` in prop order). App.tsx was passing the raw
 * `project.spec.entities` instead of `orderedEntities` (the entity tab
 * bar's own drag/keyboard-reordered order, entityTabOrder.ts) -- so a user
 * who deliberately moved an entity to the top of their tabs still saw
 * Global Search list it wherever it happened to fall in the original
 * spec/build order, the same "ignores the user's own reorder" gap this
 * routine has repeatedly found and fixed for columnOrder.ts's sibling
 * preference (filter dropdowns, group-by, bulk-edit, CSV/ICS export).
 */
test("App.tsx passes GlobalSearchPanel the entity-tab bar's own orderedEntities, not the raw project.spec.entities, so search result groups follow the user's own drag/keyboard-reordered tab order", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const globalSearchMatch = appSrc.match(/<GlobalSearchPanel[\s\S]*?\/>/);
  assert.ok(globalSearchMatch, "expected to find a <GlobalSearchPanel ... /> call site in App.tsx");
  assert.match(globalSearchMatch![0], /entities=\{orderedEntities\}/);
  assert.doesNotMatch(globalSearchMatch![0], /entities=\{project\.spec\.entities\}/);
});

/**
 * Round 764: the exact same gap round 713 fixed for GlobalSearchPanel,
 * freshly identified for a second, never-audited consumer -- AutomationsPanel
 * was handed the raw `project` and derived its own entity list from
 * `project.spec.entities` directly, so the "Create automation rule" form's
 * entity dropdown (and its default-selected entity) always listed entities
 * in build order, ignoring a user's own deliberate reorder of their entity
 * tabs.
 */
test("App.tsx passes AutomationsPanel the entity-tab bar's own orderedEntities, not the raw project.spec.entities, so the Create-rule form's entity dropdown follows the user's own drag/keyboard-reordered tab order", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const automationsMatch = appSrc.match(/<AutomationsPanel[\s\S]*?\/>/);
  assert.ok(automationsMatch, "expected to find an <AutomationsPanel ... /> call site in App.tsx");
  assert.match(automationsMatch![0], /entities=\{orderedEntities\}/);
  assert.doesNotMatch(automationsMatch![0], /entities=\{project\.spec\.entities\}/);
});

/**
 * New in this round: a past refine's own instruction text in
 * "Improvement history" was inert -- reusing a similar request (or one
 * refined away by mistake) meant retyping it from scratch. Extracts the
 * real handleReuseRefineInstruction the same way handleGoHome/
 * handleBackToHome above do, and confirms it loads the instruction back
 * into the refine box, but does nothing while a refine is already running
 * (the box itself is hidden behind the live BuildProgress view then, so
 * setting it would just be invisible state nobody asked for).
 */
test("App's handleReuseRefineInstruction loads a past instruction back into the refine box, but is a no-op while a refine is already running", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}function handleReuseRefineInstruction\([\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleReuseRefineInstruction in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let refineText = "";
  const fn = new Function(
    "refineRunning",
    "setRefineText",
    `${code}\nreturn handleReuseRefineInstruction;`,
  ) as (refineRunning: boolean, setRefineText: (v: string) => void) => (instruction: string) => void;

  const notRunning = fn(false, (v: string) => (refineText = v));
  notRunning("add a loyalty field");
  assert.equal(refineText, "add a loyalty field", "must load the past instruction back into the refine box when idle");

  refineText = "";
  const whileRunning = fn(true, (v: string) => (refineText = v));
  whileRunning("add a discount field");
  assert.equal(refineText, "", "must be a no-op while a refine is already running, not silently set hidden state");
});

test("App's handleRemoveRefineHistoryEntry removes only the targeted entry via the real removeRefineHistoryEntry, with no guard against running while a refine is in flight (it's a local list edit, not a network call)", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}function handleRemoveRefineHistoryEntry\([\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleRemoveRefineHistoryEntry in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  type Entry = { id: string; instruction: string; summary: string; completedAt: string; providerName: string | null };
  const entries: Entry[] = [
    { id: "r1", instruction: "Add invoice tracking", summary: "s", completedAt: "2026-01-01", providerName: null },
    { id: "r2", instruction: "Add a coupons entity", summary: "s", completedAt: "2026-01-02", providerName: null },
  ];
  let updated: Entry[] | null = null;
  const fn = new Function(
    "removeRefineHistoryEntry",
    "setRefineHistory",
    `${code}\nreturn handleRemoveRefineHistoryEntry;`,
  ) as (
    removeRefineHistoryEntry: (list: Entry[], id: string) => Entry[],
    setRefineHistory: (updater: (prev: Entry[]) => Entry[]) => void,
  ) => (id: string) => void;

  const handler = fn(removeRefineHistoryEntry, (updater) => {
    updated = updater(entries);
  });
  handler("r1");
  assert.deepEqual(updated!.map((e) => e.id), ["r2"], "must drop only the targeted entry via the real reducer");
});

/**
 * New in this round: the home screen's status filter (round 217) is now
 * persisted (projectStatusFilter.ts), mirroring the sibling sort-mode
 * preference (round 182) on the same screen -- previously it was plain
 * useState that silently reset to "all" on reload. Same extraction
 * convention as handleReorderEntityTab above: mock both the in-memory
 * state setter and the persistence call, and confirm the wrapper invokes
 * both with the chosen value, not just one of them.
 */
test("App's handleSetProjectStatusFilter updates both the in-memory state and the persisted preference, for every filter value", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}function handleSetProjectStatusFilter\([\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleSetProjectStatusFilter in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  for (const filter of ["all", "built", "draft"] as const) {
    let stateValue: string | null = null;
    let persistedUserId: string | null = null;
    let persistedValue: string | null = null;
    const fn = new Function(
      "user",
      "setProjectStatusFilterState",
      "persistProjectStatusFilter",
      `${code}\nreturn handleSetProjectStatusFilter;`,
    ) as (
      user: { id: string },
      setProjectStatusFilterState: (v: string) => void,
      persistProjectStatusFilter: (userId: string, v: string) => void,
    ) => (filter: string) => void;

    const handler = fn(
      { id: "user1" },
      (v) => (stateValue = v),
      (userId, v) => {
        persistedUserId = userId;
        persistedValue = v;
      },
    );
    handler(filter);
    assert.equal(stateValue, filter, `must update the in-memory state to '${filter}'`);
    assert.equal(persistedValue, filter, `must also persist '${filter}', not just hold it in memory`);
    assert.equal(persistedUserId, "user1", "round 1057: must persist under the real signed-in user's own id, not a flat shared key");
  }
});

/**
 * New in this round: the home screen's own "Your projects" search box had
 * the same gap Global Search's query box had before recentSearches.ts --
 * no memory of past searches at all. Since this box filters live on every
 * keystroke (no submit button, unlike Global Search's form), Enter is the
 * natural "I'm done typing this" signal to persist it, mirroring how a
 * submit-driven search commits a query. Extracts the real
 * handleProjectSearchKeyDown the same way handleSetProjectStatusFilter
 * above does.
 */
test("App's handleProjectSearchKeyDown adds the current search to recent-searches on Enter, but never on another key or an empty/whitespace-only search", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}function handleProjectSearchKeyDown\([\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleProjectSearchKeyDown in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(projectSearch: string, key: string): string[] {
    const added: string[] = [];
    const fn = new Function(
      "projectSearch",
      "user",
      "setRecentProjectSearches",
      "addRecentProjectSearch",
      `${code}\nreturn handleProjectSearchKeyDown;`,
    ) as (
      projectSearch: string,
      user: { id: string },
      setRecentProjectSearches: (v: string[]) => void,
      addRecentProjectSearch: (userId: string, q: string) => string[],
    ) => (e: { key: string }) => void;
    const handler = fn(
      projectSearch,
      { id: "user1" },
      () => {},
      (_userId: string, q: string) => {
        added.push(q);
        return [q];
      },
    );
    handler({ key });
    return added;
  }

  assert.deepEqual(run("acme", "Enter"), ["acme"], "Enter with a real query must add it to recent searches");
  assert.deepEqual(run("acme", "a"), [], "a non-Enter key must never add to recent searches");
  assert.deepEqual(run("   ", "Enter"), [], "Enter with only whitespace must never add an empty entry");
});

/**
 * New in this round: the live preview's entity-tab bar always mirrored
 * spec.entities' fixed generation order, with no way to put the screen
 * used most often first. Extracts the real handleReorderEntityTab the same
 * way handleGoHome/handleReuseRefineInstruction above do, passing in the
 * REAL reorderColumns (columnOrder.ts) rather than a mock -- it's already
 * generic over any `{ name: string }[]`, and Entity has a `name` field just
 * like a table's own fields do, so this proves the actual reorder math
 * wires up correctly, not just that some function got called.
 */
test("App's handleReorderEntityTab reorders entity tabs on drop and persists via entityTabOrder.ts, but is a no-op with nothing dragged, dropping onto itself, or no project open", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}function handleReorderEntityTab\([\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleReorderEntityTab in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const orderedEntities = [{ name: "Deal" }, { name: "Contact" }, { name: "Task" }];

  function run(project: { id: string } | null, draggedEntityTab: string | null, user: { id: string } | null = { id: "user1" }) {
    let dragOverCleared = false;
    let draggedCleared = false;
    let persistedProjectId: string | null = null;
    let persistedUserId: string | null = null;
    let persistedOrder: string[] | null = null;
    const fn = new Function(
      "project",
      "user",
      "draggedEntityTab",
      "orderedEntities",
      "setDragOverEntityTab",
      "setEntityTabOrderState",
      "setEntityTabOrder",
      "reorderColumns",
      "setDraggedEntityTab",
      `${code}\nreturn handleReorderEntityTab;`,
    ) as (
      project: { id: string } | null,
      user: { id: string } | null,
      draggedEntityTab: string | null,
      orderedEntities: { name: string }[],
      setDragOverEntityTab: (v: string | null) => void,
      setEntityTabOrderState: (v: string[]) => void,
      setEntityTabOrder: (projectId: string, userId: string, order: string[]) => string[],
      reorderColumns: (order: string[], source: string, target: string) => string[],
      setDraggedEntityTab: (v: string | null) => void,
    ) => (targetName: string) => void;

    const handler = fn(
      project,
      user,
      draggedEntityTab,
      orderedEntities,
      () => (dragOverCleared = true),
      (v: string[]) => (persistedOrder = v),
      (projectId: string, userId: string, order: string[]) => {
        persistedProjectId = projectId;
        persistedUserId = userId;
        return order;
      },
      reorderColumns,
      () => (draggedCleared = true),
    );
    handler("Deal");
    return { dragOverCleared, draggedCleared, persistedProjectId, persistedUserId, persistedOrder };
  }

  const moved = run({ id: "proj1" }, "Task");
  assert.equal(moved.dragOverCleared, true, "must always clear the drag-over highlight, even on a real move");
  assert.equal(moved.persistedProjectId, "proj1", "must persist under the currently-open project's own id");
  assert.equal(moved.persistedUserId, "user1", "must persist under the currently signed-in user's own id");
  assert.deepEqual(moved.persistedOrder, ["Task", "Deal", "Contact"], "dropping Task onto Deal must move Task to just before Deal");
  assert.equal(moved.draggedCleared, true);

  const droppedOnSelf = run({ id: "proj1" }, "Deal");
  assert.equal(droppedOnSelf.persistedOrder, null, "dropping a tab back onto itself must be a real no-op, not a wasted write");

  const nothingDragged = run({ id: "proj1" }, null);
  assert.equal(nothingDragged.persistedOrder, null, "must be a no-op when nothing was actually being dragged");

  const noProject = run(null, "Task");
  assert.equal(noProject.persistedOrder, null, "must be a no-op with no project open at all, not throw on project.id");
  assert.equal(noProject.dragOverCleared, true, "the drag-over highlight must still clear even when there's no project");

  const noUser = run({ id: "proj1" }, "Task", null);
  assert.equal(noUser.persistedOrder, null, "must be a no-op with no signed-in user, not throw on user.id");
  assert.equal(noUser.dragOverCleared, true, "the drag-over highlight must still clear even when there's no user");
});

/**
 * Regression test for round 662: handleReorderEntityTab above is
 * drag-and-drop ONLY -- the same keyboard-accessibility gap round 478
 * already closed for table columns (EntityPanel.tsx's own
 * handleMoveColumn) by adding "move earlier"/"move later" buttons. This
 * is the entity-tab bar's own mirror of that fix. Same extraction
 * convention as handleReorderEntityTab's own test above, passing in the
 * REAL reorderColumns rather than a mock.
 */
test("App's handleMoveEntityTab moves an entity tab earlier/later and persists via entityTabOrder.ts, but is a no-op at the ends of the order or with no project open", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {2}function handleMoveEntityTab\([\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleMoveEntityTab in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const orderedEntities = [{ name: "Deal" }, { name: "Contact" }, { name: "Task" }];

  function run(
    project: { id: string } | null,
    entityName: string,
    direction: "earlier" | "later",
    user: { id: string } | null = { id: "user1" },
  ) {
    let persistedProjectId: string | null = null;
    let persistedUserId: string | null = null;
    let persistedOrder: string[] | null = null;
    const fn = new Function(
      "project",
      "user",
      "orderedEntities",
      "setEntityTabOrderState",
      "setEntityTabOrder",
      "reorderColumns",
      `${code}\nreturn handleMoveEntityTab;`,
    ) as (
      project: { id: string } | null,
      user: { id: string } | null,
      orderedEntities: { name: string }[],
      setEntityTabOrderState: (v: string[]) => void,
      setEntityTabOrder: (projectId: string, userId: string, order: string[]) => string[],
      reorderColumns: (order: string[], source: string, target: string) => string[],
    ) => (entityName: string, direction: "earlier" | "later") => void;

    const handler = fn(
      project,
      user,
      orderedEntities,
      (v: string[]) => (persistedOrder = v),
      (projectId: string, userId: string, order: string[]) => {
        persistedProjectId = projectId;
        persistedUserId = userId;
        return order;
      },
      reorderColumns,
    );
    handler(entityName, direction);
    return { persistedProjectId, persistedUserId, persistedOrder };
  }

  const movedLater = run({ id: "proj1" }, "Deal", "later");
  assert.equal(movedLater.persistedProjectId, "proj1", "must persist under the currently-open project's own id");
  assert.equal(movedLater.persistedUserId, "user1", "must persist under the currently signed-in user's own id");
  assert.deepEqual(movedLater.persistedOrder, ["Contact", "Deal", "Task"], "'later' on Deal must swap it past Contact, the same result dragging it there would give");

  const movedEarlier = run({ id: "proj1" }, "Task", "earlier");
  assert.deepEqual(movedEarlier.persistedOrder, ["Deal", "Task", "Contact"], "'earlier' on Task must swap it before Contact, the same result dragging it there would give");

  const firstEarlier = run({ id: "proj1" }, "Deal", "earlier");
  assert.equal(firstEarlier.persistedOrder, null, "'earlier' on the first tab must be a no-op -- there's nothing before it");

  const lastLater = run({ id: "proj1" }, "Task", "later");
  assert.equal(lastLater.persistedOrder, null, "'later' on the last tab must be a no-op -- there's nothing after it");

  const unknownEntity = run({ id: "proj1" }, "NoSuchEntity", "earlier");
  assert.equal(unknownEntity.persistedOrder, null, "a tab name not in orderedEntities must be a no-op, not throw");

  const noProject = run(null, "Deal", "later");
  assert.equal(noProject.persistedOrder, null, "must be a no-op with no project open at all, not throw on project.id");

  const noUser = run({ id: "proj1" }, "Deal", "later", null);
  assert.equal(noUser.persistedOrder, null, "must be a no-op with no signed-in user, not throw on user.id");
});

/**
 * Round 1040: EntitySchema only enforces uniqueness on an entity's `name`,
 * never its `label` -- the entity-tab bar rendered a bare
 * `entity.label ?? entity.name` for both its own tab text and the
 * moveEarlier/moveLater aria-labels, so two entities sharing a label
 * produced indistinguishable tabs with no way to tell which one a click
 * would actually open. Confirms App.tsx computes entityTabLabelOccurrences
 * from the real entityLabelOccurrences(orderedEntities) and wires it
 * through entityDisplayLabel at all 3 call sites, the same source-regex
 * technique the GlobalSearchPanel/AutomationsPanel orderedEntities tests
 * above already use for this file's own tab-bar JSX.
 */
test("App.tsx's entity-tab bar disambiguates its own tab text and moveEarlier/moveLater aria-labels when two entities share a label", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(
    appSrc,
    /const entityTabLabelOccurrences = useMemo\(\(\) => entityLabelOccurrences\(orderedEntities\), \[orderedEntities\]\);/,
    "expected entityTabLabelOccurrences to be computed from the real entityLabelOccurrences(orderedEntities)",
  );

  const tabButtonMatch = appSrc.match(/onClick=\{\(\) => setActiveEntity\(entity\.name\)\}[\s\S]*?\n\s*>\s*\n\s*\{([^}]+)\}/);
  assert.ok(tabButtonMatch, "expected to find the entity-tab button's own label expression in App.tsx");
  assert.equal(
    tabButtonMatch![1].trim(),
    "entityDisplayLabel(entity, entityTabLabelOccurrences)",
    "the tab button's own text must be disambiguated, not a bare entity.label ?? entity.name",
  );

  const moveEarlierMatch = appSrc.match(/aria-label=\{t\("entity\.tab\.moveEarlier", \{ entity: ([^}]+) \}\)\}/);
  assert.ok(moveEarlierMatch, "expected to find the moveEarlier button's own aria-label in App.tsx");
  assert.equal(moveEarlierMatch![1].trim(), "entityDisplayLabel(entity, entityTabLabelOccurrences)");

  const moveLaterMatch = appSrc.match(/aria-label=\{t\("entity\.tab\.moveLater", \{ entity: ([^}]+) \}\)\}/);
  assert.ok(moveLaterMatch, "expected to find the moveLater button's own aria-label in App.tsx");
  assert.equal(moveLaterMatch![1].trim(), "entityDisplayLabel(entity, entityTabLabelOccurrences)");
});

/**
 * New in this round: a 401 SESSION_EXPIRED/AUTH_REQUIRED (the session
 * expired, or was revoked from another tab/device via "sign out
 * everywhere" or a password change) previously only ever surfaced as
 * whichever one request happened to hit it showing its own translated
 * inline error -- `user` stayed set and the rest of the authenticated UI
 * kept rendering with a now-useless stored token. api.ts's
 * subscribeAuthExpired (see api.test.ts) is the hook; this confirms
 * App.tsx's own mount-time effect actually subscribes to it and, when
 * fired, runs the same clearToken+reset-to-home sequence
 * handleAccountDeleted already uses elsewhere in this file -- forcing the
 * `if (!user) return <AuthScreen />` branch instead of leaving the person
 * stuck on a dead session.
 *
 * Extended in round 502: the effect's own doc comment claims it "mirrors
 * handleAccountDeleted's own clearToken+reset-to-home sequence", but it
 * only ever reset 3 of handleAccountDeleted's ~10 pieces of state -- most
 * concretely, whatsappPrefillTo (set by a per-record "Send WhatsApp"
 * action, cleared only by WhatsAppPanel's own onClose/onJumpTo* callbacks)
 * survived this exact reset. Since this effect is the one path back to
 * the login screen that fires from an async 401 rather than a button
 * click, it's the one path useDialogFocusTrap's inert-background guard
 * can't block while WhatsAppPanel is open -- so a session invalidated
 * while the panel sat open left a stale phone number silently pre-filled
 * into the next login's WhatsApp "To" field (WhatsAppPanel's own
 * `useState(() => prefillTo ?? "")` lazy init reads it fresh on the next
 * mount), risking a message sent to the wrong person entirely.
 */
test("App's subscribeAuthExpired effect clears the token and resets user/project/view/panels/etc to force the login screen", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const effectMatch = appSrc.match(/ {2}useEffect\(\(\) => \{\n {4}return subscribeAuthExpired\(\(\) => \{[\s\S]*?\n {2}\}, \[\]\);\n/);
  assert.ok(effectMatch, "expected to find the subscribeAuthExpired effect in App.tsx");
  // Round 928: the effect now calls the separately-defined closeAllPanels
  // helper (a free variable from this extracted effect's own point of
  // view) instead of setWhatsappPrefillTo directly -- extracted alongside
  // it, same convention as the handleGoHome test above.
  const helperMatch = appSrc.match(/ {2}function closeAllPanels\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(helperMatch, "expected to find closeAllPanels in App.tsx");
  const { code } = transformSync(`${helperMatch![0]}\n${effectMatch![0]}`, { loader: "ts" });

  let subscribedListener: (() => void) | undefined;
  let tokenCleared = false;
  let userSet: unknown = "untouched";
  let projectSet: unknown = "untouched";
  let viewSet: unknown = "untouched";
  let descriptionSet: unknown = "untouched";
  let ideaDraftCleared = false;
  let recentProjectSearchesCleared = false;
  let recentProjectSearchesSet: unknown = "untouched";
  let errorSet: unknown = "untouched";
  let activeEntitySet: unknown = "untouched";
  let selectedAnswersSet: unknown = "untouched";
  let additionalRequestSet: unknown = "untouched";
  let refineTextSet: unknown = "untouched";
  let refineHistorySet: unknown = "untouched";
  let refineHistorySearchSet: unknown = "untouched";
  let showWhatsAppSet: unknown = "untouched";
  let whatsappPrefillToSet: unknown = "untouched";
  let highlightRecordIdSet: unknown = "untouched";
  let createPrefillSet: unknown = "untouched";

  const fn = new Function(
    "useEffect",
    "userIdRef",
    "subscribeAuthExpired",
    "clearToken",
    "setUser",
    "setProject",
    "setView",
    "setDescription",
    "clearIdeaDraft",
    "clearRecentProjectSearches",
    "setRecentProjectSearches",
    "setError",
    "setActiveEntity",
    "setSelectedAnswers",
    "setAdditionalRequest",
    "setRefineText",
    "setRefineHistory",
    "setRefineHistorySearch",
    "setShowHistory",
    "setShowTwin",
    "setShowWhatsApp",
    "setShowAutomations",
    "setShowCollaborators",
    "setShowSearch",
    "setShowShortcuts",
    "setWhatsappPrefillTo",
    "setHighlightRecordId",
    "setCreatePrefill",
    "setCreateDateFilter",
    `${code}`,
  ) as (
    useEffect: (effect: () => void, deps: unknown[]) => void,
    userIdRef: { current: string | null },
    subscribeAuthExpired: (listener: () => void) => () => void,
    clearToken: () => void,
    setUser: (v: unknown) => void,
    setProject: (v: unknown) => void,
    setView: (v: unknown) => void,
    setDescription: (v: unknown) => void,
    clearIdeaDraft: (userId: string) => void,
    clearRecentProjectSearches: () => void,
    setRecentProjectSearches: (v: unknown) => void,
    setError: (v: unknown) => void,
    setActiveEntity: (v: unknown) => void,
    setSelectedAnswers: (v: unknown) => void,
    setAdditionalRequest: (v: unknown) => void,
    setRefineText: (v: unknown) => void,
    setRefineHistory: (v: unknown) => void,
    setRefineHistorySearch: (v: unknown) => void,
    setShowHistory: (v: unknown) => void,
    setShowTwin: (v: unknown) => void,
    setShowWhatsApp: (v: unknown) => void,
    setShowAutomations: (v: unknown) => void,
    setShowCollaborators: (v: unknown) => void,
    setShowSearch: (v: unknown) => void,
    setShowShortcuts: (v: unknown) => void,
    setWhatsappPrefillTo: (v: unknown) => void,
    setHighlightRecordId: (v: unknown) => void,
    setCreatePrefill: (v: unknown) => void,
    setCreateDateFilter: (v: unknown) => void,
  ) => void;

  fn(
    (effect) => effect(),
    { current: "user1" },
    (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
    () => {
      tokenCleared = true;
    },
    (v) => (userSet = v),
    (v) => (projectSet = v),
    (v) => (viewSet = v),
    (v) => (descriptionSet = v),
    () => {
      ideaDraftCleared = true;
    },
    () => {
      recentProjectSearchesCleared = true;
    },
    (v) => (recentProjectSearchesSet = v),
    (v) => (errorSet = v),
    (v) => (activeEntitySet = v),
    (v) => (selectedAnswersSet = v),
    (v) => (additionalRequestSet = v),
    (v) => (refineTextSet = v),
    (v) => (refineHistorySet = v),
    (v) => (refineHistorySearchSet = v),
    () => {},
    () => {},
    (v) => (showWhatsAppSet = v),
    () => {},
    () => {},
    () => {},
    () => {},
    (v) => (whatsappPrefillToSet = v),
    (v) => (highlightRecordIdSet = v),
    (v) => (createPrefillSet = v),
    () => {},
  );

  assert.ok(subscribedListener, "the effect must call subscribeAuthExpired with a real listener");
  assert.equal(tokenCleared, false, "must not touch anything before the listener actually fires");

  subscribedListener!();
  assert.equal(tokenCleared, true, "must call clearToken once the session is reported gone");
  assert.equal(userSet, null, "must clear user so the `if (!user) return <AuthScreen />` branch takes over");
  assert.equal(projectSet, null, "must clear the open project too, not leave stale project state behind");
  assert.equal(viewSet, "home", "must reset view to home so a later re-login lands on the home screen, not a dead view");
  assert.equal(descriptionSet, "", "must clear the idea description, same as handleAccountDeleted");
  assert.equal(
    ideaDraftCleared,
    false,
    "round 1129: must NOT clear the persisted idea draft -- ideaDraft.ts is per-user-keyed since round 1044, so clearing it here only destroys this SAME user's own still-unsaved draft on an ordinary session expiry, not protect a different account (which the per-user key already does on its own)",
  );
  assert.equal(
    recentProjectSearchesCleared,
    false,
    "round 1129: must NOT clear the persisted recent-project-searches either, for the identical reason -- recentProjectSearches.ts has been per-user-keyed since round 1045",
  );
  assert.deepEqual(recentProjectSearchesSet, [], "must still reset the in-memory recentProjectSearches state (the live UI), even though the persisted entry itself is left alone");
  assert.equal(errorSet, null, "must clear any stale error banner, same as handleAccountDeleted");
  assert.equal(activeEntitySet, null, "must clear activeEntity so a later project doesn't inherit a stale tab name");
  assert.deepEqual(selectedAnswersSet, {}, "must clear selectedAnswers, same as handleAccountDeleted");
  assert.equal(additionalRequestSet, "", "must clear additionalRequest, same as handleAccountDeleted");
  assert.equal(refineTextSet, "", "must clear refineText, same as handleAccountDeleted");
  assert.deepEqual(refineHistorySet, [], "must clear refineHistory, same as handleAccountDeleted");
  assert.equal(refineHistorySearchSet, "", "must clear refineHistorySearch, same as handleAccountDeleted");
  assert.equal(
    showWhatsAppSet,
    false,
    "round 928: must close an open panel too (via closeAllPanels), not just clear whatsappPrefillTo -- otherwise the panel itself silently pops back open on the next project",
  );
  assert.equal(
    whatsappPrefillToSet,
    null,
    "must clear whatsappPrefillTo, the one reset neither handleLogout nor handleAccountDeleted needs (their own trigger buttons are inert-blocked while WhatsAppPanel is open) but this async-401 path does",
  );
  assert.equal(highlightRecordIdSet, null, "round 928: closeAllPanels must also clear highlightRecordId");
  assert.equal(createPrefillSet, null, "round 928: closeAllPanels must also clear createPrefill");
});

/**
 * Round 1018: pinnedIds/seenShared used to be populated ONLY inline inside
 * the mount-only session-restore effect above (the `me()` round trip for
 * an already-stored token) -- but `user` can also become non-null via
 * AuthScreen's own onAuthenticated prop (a bare setUser, see App.tsx's own
 * `<AuthScreen onAuthenticated={setUser} />`), reached by a fresh login or
 * a re-login right after the subscribeAuthExpired effect tested just above
 * forced `user` back to null. Neither of those ever re-ran the mount-only
 * effect, so pinnedIds/seenShared stayed stuck empty through a same-tab
 * re-login -- a previously-pinned project's star rendered unfilled, and
 * clicking it to "pin" what looked unpinned actually called togglePinned
 * (pinnedProjects.ts) against the REAL stored ids and silently un-pinned
 * it, a genuine, silent loss of a real saved preference. Confirms the new
 * effect is keyed on `user?.id` (not a mount-only `[]`), so it re-runs
 * every time the signed-in user actually changes, and that it loads the
 * real per-user content once a user exists while staying a no-op while
 * `user` is still null.
 */
test("App's pinnedIds/seenShared-loading effect re-populates every time the signed-in user changes, not just once on mount", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const effectMatch = appSrc.match(
    / {2}useEffect\(\(\) => \{\n {4}if \(!user\) return;\n {4}setPinnedIds\(getPinnedIds\(user\.id\)\);\n {4}setSeenShared\(getSeenSharedTimestamps\(user\.id\)\);\n[\s\S]*?\n {2}\}, \[user\?\.id\]\);\n/,
  );
  // Regex-extraction convention: the body above must genuinely contain the
  // round-1057 calls too, not just match the fixed opening lines -- a
  // stale match here would silently stop exercising the real source.
  assert.ok(
    effectMatch && /getProjectSortMode\(user\.id\)/.test(effectMatch[0]) && /getProjectStatusFilter\(user\.id\)/.test(effectMatch[0]),
    "expected the extracted effect to also call getProjectSortMode/getProjectStatusFilter with user.id (round 1057)",
  );
  assert.ok(effectMatch, "expected to find the pinnedIds/seenShared-loading effect, keyed on user?.id, in App.tsx");
  const { code } = transformSync(effectMatch![0], { loader: "ts" });

  let capturedDeps: unknown[] | undefined;
  let pinnedIdsSet: unknown = "untouched";
  let seenSharedSet: unknown = "untouched";
  let descriptionSet: unknown = "untouched";
  let recentProjectSearchesSet: unknown = "untouched";
  let projectSortModeSet: unknown = "untouched";
  let projectStatusFilterSet: unknown = "untouched";
  const fn = new Function(
    "useEffect",
    "user",
    "getPinnedIds",
    "getSeenSharedTimestamps",
    "setPinnedIds",
    "setSeenShared",
    "getIdeaDraft",
    "setDescription",
    "getRecentProjectSearches",
    "setRecentProjectSearches",
    "getProjectSortMode",
    "setProjectSortModeState",
    "getProjectStatusFilter",
    "setProjectStatusFilterState",
    `${code}`,
  ) as (
    useEffect: (effect: () => void, deps: unknown[]) => void,
    user: { id: string } | null,
    getPinnedIds: (userId: string) => unknown,
    getSeenSharedTimestamps: (userId: string) => unknown,
    setPinnedIds: (v: unknown) => void,
    setSeenShared: (v: unknown) => void,
    getIdeaDraft: (userId: string) => unknown,
    setDescription: (v: unknown) => void,
    getRecentProjectSearches: (userId: string) => unknown,
    setRecentProjectSearches: (v: unknown) => void,
    getProjectSortMode: (userId: string) => unknown,
    setProjectSortModeState: (v: unknown) => void,
    getProjectStatusFilter: (userId: string) => unknown,
    setProjectStatusFilterState: (v: unknown) => void,
  ) => void;

  // user === null (nobody signed in yet) -- must be a genuine no-op, not
  // call either loader or setter with a null id.
  fn(
    (effect, deps) => {
      capturedDeps = deps;
      effect();
    },
    null,
    () => {
      throw new Error("getPinnedIds must never be called while user is null");
    },
    () => {
      throw new Error("getSeenSharedTimestamps must never be called while user is null");
    },
    (v) => (pinnedIdsSet = v),
    (v) => (seenSharedSet = v),
    () => {
      throw new Error("getIdeaDraft must never be called while user is null");
    },
    (v) => (descriptionSet = v),
    () => {
      throw new Error("getRecentProjectSearches must never be called while user is null");
    },
    (v) => (recentProjectSearchesSet = v),
    () => {
      throw new Error("getProjectSortMode must never be called while user is null");
    },
    (v) => (projectSortModeSet = v),
    () => {
      throw new Error("getProjectStatusFilter must never be called while user is null");
    },
    (v) => (projectStatusFilterSet = v),
  );
  assert.deepEqual(capturedDeps, [undefined], "must be keyed on user?.id, not a mount-only [] -- this is what makes it re-run on every real login, not just the first one");
  assert.equal(pinnedIdsSet, "untouched");
  assert.equal(seenSharedSet, "untouched");
  assert.equal(descriptionSet, "untouched");
  assert.equal(recentProjectSearchesSet, "untouched");
  assert.equal(projectSortModeSet, "untouched");
  assert.equal(projectStatusFilterSet, "untouched");

  // A real signed-in user -- must load both pieces of per-user content.
  fn(
    (effect) => effect(),
    { id: "user-42" },
    (userId) => `pinned-for-${userId}`,
    (userId) => `seen-for-${userId}`,
    (v) => (pinnedIdsSet = v),
    (v) => (seenSharedSet = v),
    (userId) => `draft-for-${userId}`,
    (v) => (descriptionSet = v),
    (userId) => `searches-for-${userId}`,
    (v) => (recentProjectSearchesSet = v),
    (userId) => `sort-mode-for-${userId}`,
    (v) => (projectSortModeSet = v),
    (userId) => `status-filter-for-${userId}`,
    (v) => (projectStatusFilterSet = v),
  );
  assert.equal(pinnedIdsSet, "pinned-for-user-42", "must call getPinnedIds with the real signed-in user's own id and store its result");
  assert.equal(seenSharedSet, "seen-for-user-42", "must call getSeenSharedTimestamps with the real signed-in user's own id and store its result");
  assert.equal(
    descriptionSet,
    "draft-for-user-42",
    "must call getIdeaDraft with the real signed-in user's own id too (round 1044 -- ideaDraft.ts is now keyed per user, so description must be loaded the same way pinnedIds/seenShared already are)",
  );
  assert.equal(
    recentProjectSearchesSet,
    "searches-for-user-42",
    "must call getRecentProjectSearches with the real signed-in user's own id too (round 1045 -- recentProjectSearches.ts is now keyed per user, so it must be loaded the same way pinnedIds/seenShared/description already are)",
  );
  assert.equal(
    projectSortModeSet,
    "sort-mode-for-user-42",
    "must call getProjectSortMode with the real signed-in user's own id too (round 1057 -- projectSortMode.ts is now keyed per user, so it must be loaded the same way pinnedIds/seenShared/description/recentProjectSearches already are)",
  );
  assert.equal(
    projectStatusFilterSet,
    "status-filter-for-user-42",
    "must call getProjectStatusFilter with the real signed-in user's own id too (round 1057 -- projectStatusFilter.ts is now keyed per user, so it must be loaded the same way pinnedIds/seenShared/description/recentProjectSearches already are)",
  );
});

/**
 * Mirrors the subscribeAuthExpired effect test above, for the narrower
 * subscribeProjectGone case (api.ts): requireProjectAccess/
 * requireProjectOwner throw PROJECT_NOT_FOUND whenever the project was
 * deleted or this account's own collaborator access to it was just
 * revoked. Previously this surfaced only as that one request's own
 * translated inline error text, with `project` staying set and the whole
 * project shell (tabs, now-stale records) still rendered -- every
 * subsequent action 404ing the same way forever, no path back to the
 * project list. Confirms the listener resets to the home screen (via the
 * same handleGoHome used by CollaboratorsPanel's own "leave project"
 * flow) and purges the gone project's own client-side preferences --
 * but only when the reported project id actually matches the one
 * currently open, never for an unrelated/stale notification.
 */
test("App's subscribeProjectGone effect resets to the home screen and purges preferences, but only for the currently-open project", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const effectMatch = appSrc.match(/ {2}useEffect\(\(\) => \{\n {4}return subscribeProjectGone\(\(projectId, message\) => \{[\s\S]*?\n {2}\}, \[project\]\);\n/);
  assert.ok(effectMatch, "expected to find the subscribeProjectGone effect in App.tsx");
  const { code } = transformSync(effectMatch![0], { loader: "ts" });

  let subscribedListener: ((projectId: string, message: string) => void) | undefined;
  let purgedId: unknown = "untouched";
  let homeCalled = false;
  let errorSet: unknown = "untouched";

  function buildEffect(project: { id: string } | null) {
    purgedId = "untouched";
    homeCalled = false;
    errorSet = "untouched";
    const fn = new Function(
      "useEffect",
      "subscribeProjectGone",
      "project",
      "purgeProjectPreferences",
      "handleGoHome",
      "setError",
      `${code}`,
    ) as (
      useEffect: (effect: () => void, deps: unknown[]) => void,
      subscribeProjectGone: (listener: (projectId: string, message: string) => void) => () => void,
      project: { id: string } | null,
      purgeProjectPreferences: (id: string) => void,
      handleGoHome: () => void,
      setError: (v: unknown) => void,
    ) => void;
    fn(
      (effect) => effect(),
      (listener) => {
        subscribedListener = listener;
        return () => undefined;
      },
      project,
      (id) => (purgedId = id),
      () => {
        homeCalled = true;
      },
      (v) => (errorSet = v),
    );
  }

  buildEffect({ id: "proj1" });
  assert.ok(subscribedListener, "the effect must call subscribeProjectGone with a real listener");

  subscribedListener!("proj2", "Project not found.");
  assert.equal(homeCalled, false, "a notification for a DIFFERENT project than the one currently open must be ignored entirely");
  assert.equal(purgedId, "untouched", "must not purge preferences for a project that isn't the one currently open");

  subscribedListener!("proj1", "Project not found.");
  assert.equal(homeCalled, true, "a notification for the currently-open project must reset to the home screen");
  assert.equal(purgedId, "proj1", "must purge the gone project's own client-side preferences");
  assert.equal(errorSet, "Project not found.", "must surface the real translated message as the error banner, so the person knows why they were sent home");
});

/**
 * Round 886: myRole is fetched exactly once, in openExistingProject, and
 * never revalidated afterward. If the project owner demotes this
 * collaborator from editor to viewer while the project stays open here,
 * every write-affordance kept rendering as before the demotion, and the
 * next write attempt just 403ed with VIEWER_READ_ONLY (requireProjectWriteAccess)
 * over and over with no way for the UI to catch up. api.ts now calls
 * notifyViewerDemoted whenever any request hits that 403; confirms the
 * listener flips myRole to "viewer" for the currently-open project only,
 * leaving an unrelated/stale notification for a different project id
 * untouched (mirroring subscribeProjectGone's own project-id guard above).
 */
test("App's subscribeViewerDemoted effect flips myRole to viewer, but only for the currently-open project", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const effectMatch = appSrc.match(/ {2}useEffect\(\(\) => \{\n {4}return subscribeViewerDemoted\(\(projectId\) => \{[\s\S]*?\n {2}\}, \[project\]\);\n/);
  assert.ok(effectMatch, "expected to find the subscribeViewerDemoted effect in App.tsx");
  const { code } = transformSync(effectMatch![0], { loader: "ts" });

  let subscribedListener: ((projectId: string) => void) | undefined;
  let roleSet: unknown = "untouched";

  function buildEffect(project: { id: string } | null) {
    roleSet = "untouched";
    const fn = new Function(
      "useEffect",
      "subscribeViewerDemoted",
      "project",
      "setMyRole",
      `${code}`,
    ) as (
      useEffect: (effect: () => void, deps: unknown[]) => void,
      subscribeViewerDemoted: (listener: (projectId: string) => void) => () => void,
      project: { id: string } | null,
      setMyRole: (v: unknown) => void,
    ) => void;
    fn(
      (effect) => effect(),
      (listener) => {
        subscribedListener = listener;
        return () => undefined;
      },
      project,
      (v) => (roleSet = v),
    );
  }

  buildEffect({ id: "proj1" });
  assert.ok(subscribedListener, "the effect must call subscribeViewerDemoted with a real listener");

  subscribedListener!("proj2");
  assert.equal(roleSet, "untouched", "a notification for a DIFFERENT project than the one currently open must be ignored entirely");

  subscribedListener!("proj1");
  assert.equal(roleSet, "viewer", "a notification for the currently-open project must flip myRole to viewer so the existing readOnly wiring takes over");
});

/**
 * The decorative 3D hero graphic on the home screen (a rotating CSS cube,
 * no WebGL/three.js dependency) is purely presentational -- it has no
 * state or handler to test, and jsdom has no real 3D rendering to assert
 * on anyway, so the only thing worth pinning here is the DOM wiring: the
 * wrapper must be `aria-hidden` so this never reaches a screen reader as a
 * confusing unlabeled element, matching this app's own accessibility-pass
 * precedent (round 91) of never exposing a purely decorative element to
 * assistive tech. The actual 3D/animation CSS is covered separately below
 * by reading styles.css directly, the same discipline round 441 already
 * established for CSS jsdom can't otherwise exercise.
 */
test("the home screen's decorative 3D hero cube is marked aria-hidden, keeping it out of the accessibility tree", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const hero3dBlock = appSrc.match(/<div className="hero3d"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<h1>\{t\("home\.title"\)\}<\/h1>/);
  assert.ok(hero3dBlock, "expected a .hero3d wrapper immediately before the home screen's <h1>");
  assert.match(hero3dBlock![0], /aria-hidden="true"/, "the decorative cube wrapper must be aria-hidden");
  const faceCount = hero3dBlock![0].match(/className="hero3d-face /g)?.length ?? 0;
  assert.equal(faceCount, 6, "a cube needs exactly 6 faces");
});

/**
 * New in this round: the same "decorative, keep it out of the
 * accessibility tree" discipline the hero cube above already gets --
 * applied here to two emoji icons that sit directly beside a real text
 * label (the idea-examples grid's own icon+label button, and each
 * Templates Gallery card's own icon+name) rather than carrying any
 * information themselves. Without aria-hidden, a screen reader announced
 * each emoji's own verbose Unicode name on top of the adjacent label that
 * already says the same thing in real words -- pure noise on every one of
 * the ~5 idea-example cards and every template card. Source-regex, not a
 * full render, since mounting App.tsx's home screen needs a real auth/
 * routing harness this file doesn't otherwise set up -- same approach the
 * hero-cube test above already uses for exactly this reason.
 */
test("the home screen's idea-example and template-card icons are marked aria-hidden, since the real label beside each already says the same thing", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  const ideaIconLine = appSrc.match(/<span className="idea-example-icon"[^>]*>\{example\.icon\}<\/span>/);
  assert.ok(ideaIconLine, "expected the idea-example icon span");
  assert.match(ideaIconLine![0], /aria-hidden="true"/, "the idea-example icon must be aria-hidden, since idea-example-label already carries the real text");

  const templateIconLine = appSrc.match(/<span className="template-card-icon"[^>]*>\{template\.icon\}<\/span>/);
  assert.ok(templateIconLine, "expected the template-card icon span");
  assert.match(templateIconLine![0], /aria-hidden="true"/, "the template-card icon must be aria-hidden, since template-card-name already carries the real text");
});

/**
 * Round 1140: the "My Projects" sort toggle (Recent / Alphabetical) marked
 * its selected option with nothing but a CSS class
 * (`view-toggle-btn-active`), invisible to a screen reader -- the same
 * WCAG 4.1.2 gap round 1135 already fixed for LanguageSwitcher.tsx,
 * EntityPanel.tsx's Table/Board/Calendar toggle, and
 * BusinessTwinPanel.tsx's Dashboard/Report toggle, but this fifth toggle
 * had no `role="group"` wrapper at all, so it never surfaced in that
 * round's own verification grep. Source-regex, not a full render, for the
 * same reason the hero-cube/icon tests above use it: App.tsx's home
 * screen needs a real auth/routing harness this file doesn't set up.
 */
test("the home screen's My Projects sort toggle reports its selected state via aria-pressed, inside a real role=group, not just a CSS class", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  const sortToggleBlock = appSrc.match(/<div className="my-projects-sort view-toggle"[^>]*>[\s\S]*?<\/div>\n\s*\)\}/);
  assert.ok(sortToggleBlock, "expected the my-projects-sort toggle's own wrapper block");
  assert.match(sortToggleBlock![0], /role="group"/, "the toggle's wrapper must be a real group, the same convention every sibling toggle already uses");
  assert.match(sortToggleBlock![0], /aria-pressed=\{projectSortMode === "recent"\}/, "the Recent button must report its own selected state via aria-pressed");
  assert.match(sortToggleBlock![0], /aria-pressed=\{projectSortMode === "alphabetical"\}/, "the Alphabetical button must report its own selected state via aria-pressed");
});

/**
 * Round 1144: the project view's entity-tab bar (`<nav className="entity-
 * tabs">`) is structurally a real ARIA tab list -- exactly one tab's own
 * content (the active entity's EntityPanel) is ever shown at a time -- but
 * carried none of the standard tab-pattern semantics, only a CSS class
 * marking the selected tab. This is a distinct accessibility gap from the
 * closed toggle-button family (rounds 1135/1140, each a plain `role="group"`
 * button pair): this nav never surfaced in that family's own `role="group"`
 * grep because it's a `<nav>`, not a button group, and the right fix here
 * is the tab pattern's own `role="tablist"`/`role="tab"`/`aria-selected`,
 * not `aria-pressed`. Source-regex, not a full render, for the same reason
 * every other App.tsx-level JSX-attribute test in this file uses it: the
 * project view needs a real auth/routing harness this test file doesn't
 * set up.
 */
/**
 * Round 1233: the entity-tab bar's own drag-to-reorder (dragOverEntityTab)
 * is a separate drag state from EntityPanel.tsx's three Kanban/calendar/
 * table-header states that round 1232 already fixed -- this nav lives in
 * App.tsx, outside EntityPanel.tsx entirely, and was never touched by that
 * round. It has the identical gap: native HTML5 drag-and-drop only fires
 * `dragleave` on a tab the pointer actually moves off of, so cancelling a
 * drag with Escape (which fires `dragend` on the source tab instead, with
 * the pointer never having left the tab underneath it) left the
 * `tab-drag-over` highlight stuck permanently. Source-regex, for the same
 * reason the test just above this one uses it.
 */
test("the project view's entity-tab bar wires onDragEnd to clear dragOverEntityTab, mirroring round 1232's EntityPanel fix for the identical gap", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  const entityTabsBlock = appSrc.match(/<nav className="entity-tabs"[^>]*>[\s\S]*?<\/nav>/);
  assert.ok(entityTabsBlock, "expected the entity-tabs nav's own block");
  assert.match(
    entityTabsBlock![0],
    /onDragStart=\{\(\) => setDraggedEntityTab\(entity\.name\)\}\s*\n\s*onDragEnd=\{\(\) => setDragOverEntityTab\(null\)\}/,
    "the draggable tab must clear dragOverEntityTab on dragend, not just on a real drop",
  );
});

test("the project view's entity-tab bar reports its selected tab via role=tablist/role=tab/aria-selected, not just a CSS class", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  const entityTabsBlock = appSrc.match(/<nav className="entity-tabs"[^>]*>[\s\S]*?<\/nav>/);
  assert.ok(entityTabsBlock, "expected the entity-tabs nav's own block");
  assert.match(entityTabsBlock![0], /role="tablist"/, "the nav itself must be a real tablist, the standard ARIA tab-pattern wrapper role");
  assert.match(entityTabsBlock![0], /role="tab"/, "each tab button must carry role=\"tab\"");
  assert.match(
    entityTabsBlock![0],
    /aria-selected=\{activeEntity === entity\.name\}/,
    "each tab button must report its own selected state via aria-selected, the tab-pattern's own equivalent of aria-pressed",
  );
});

/**
 * Round 1150: round 1144's own fix above added the WAI-ARIA Tabs pattern's
 * three static attributes (role="tablist"/"tab"/aria-selected) but never
 * the pattern's own required keyboard model -- every tab still sat in
 * normal Tab order (no roving tabindex) with no ArrowLeft/ArrowRight/Home/
 * End handling at all, and no aria-controls/role="tabpanel" linkage between
 * a tab and the panel it shows. A keyboard or screen-reader user hearing
 * "tab, 2 of 5" from round 1144's own fix still got no arrow-key model and
 * no programmatic tab<->panel relationship -- a half-implemented pattern,
 * not the "missing role entirely" gap round 1144 itself closed.
 */
test("the project view's entity-tab bar implements the full WAI-ARIA Tabs keyboard model (roving tabindex, arrow/Home/End navigation, aria-controls)", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  const entityTabsBlock = appSrc.match(/<nav className="entity-tabs"[^>]*>[\s\S]*?<\/nav>/);
  assert.ok(entityTabsBlock, "expected the entity-tabs nav's own block");
  assert.match(
    entityTabsBlock![0],
    /tabIndex=\{activeEntity === entity\.name \? 0 : -1\}/,
    "only the selected tab must be a normal Tab stop (roving tabindex) -- every other tab must be -1",
  );
  assert.match(entityTabsBlock![0], /aria-controls=\{`entity-tabpanel-\$\{entity\.name\}`\}/, "each tab must declare which panel it controls");
  assert.match(entityTabsBlock![0], /onKeyDown=\{/, "the tab button must handle keyboard navigation");
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
    assert.ok(entityTabsBlock![0].includes(`"${key}"`), `the tab bar's own keyboard handler must recognize ${key}`);
  }
});

/**
 * Round 1150: see the keyboard-model test above for the full rationale --
 * this is the other missing half of the pattern, the programmatic tab<->
 * panel relationship (aria-controls on the tab paired with role="tabpanel"
 * + aria-labelledby on the panel it names).
 */
test("the project view's active EntityPanel is wrapped in a real tabpanel, linked back to its own tab via aria-labelledby", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  const tabpanelBlock = appSrc.match(/<div key=\{entity\.name\} id=\{`entity-tabpanel-\$\{entity\.name\}`\}[^>]*>/);
  assert.ok(tabpanelBlock, "expected a tabpanel wrapper around the active entity's EntityPanel");
  assert.match(tabpanelBlock![0], /role="tabpanel"/, "the wrapper must carry role=\"tabpanel\"");
  assert.match(
    tabpanelBlock![0],
    /aria-labelledby=\{`entity-tab-\$\{entity\.name\}`\}/,
    "the tabpanel must point back at its own tab's id, the tab pattern's own required reverse link",
  );
});

test("the decorative 3D hero cube's CSS uses real 3D transforms and respects prefers-reduced-motion", () => {
  const stylesCss = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

  const cubeRule = stylesCss.match(/\.hero3d-cube \{[\s\S]*?\}/)?.[0];
  assert.ok(cubeRule, "expected a .hero3d-cube rule in styles.css");
  assert.match(cubeRule!, /transform-style:\s*preserve-3d/, ".hero3d-cube must use preserve-3d or its faces collapse flat");
  assert.match(cubeRule!, /animation:\s*hero3d-spin/, ".hero3d-cube must reference the hero3d-spin animation");

  assert.match(stylesCss, /@keyframes hero3d-spin \{/, "expected an @keyframes hero3d-spin rule in styles.css");

  const reducedMotionBlock = stylesCss.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(reducedMotionBlock, "expected a prefers-reduced-motion override in styles.css");
  assert.match(reducedMotionBlock!, /\.hero3d-cube[\s\S]*?animation:\s*none/, "the reduced-motion override must disable the cube's animation, not just leave it spinning");
});

/**
 * Round 1349: a live Playwright browser session found the bulk-select
 * checkbox (.my-project-select) stamped directly on top of the project
 * title's first character(s) on the "My Projects" home screen -- live
 * DOM boundingBox() measurements showed identical top-left origins for
 * the checkbox and the title text (a real overlap, not just tight
 * spacing). .my-project-open already reserves padding-inline-end: 28px
 * to clear the sibling .my-project-pin button on the other side, but had
 * no matching padding-inline-start to clear the checkbox. jsdom has no
 * layout engine and can't detect real overlap/clipping (see the
 * hero3d-cube test just above), so this reads styles.css's own source
 * directly instead.
 */
test("the My Projects home screen reserves room in the title button for the bulk-select checkbox, so it doesn't overlap the project name", () => {
  const stylesCss = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

  const myProjectOpen = stylesCss.match(/\.my-project-open \{[\s\S]*?\}/)?.[0];
  assert.ok(myProjectOpen, "expected a .my-project-open rule in styles.css");
  assert.match(
    myProjectOpen!,
    /padding-inline-start:\s*\d/,
    ".my-project-open must reserve left padding so the absolutely-positioned .my-project-select checkbox doesn't overlap the project title text",
  );
});

/**
 * Regression test for round 560's finding: the topbar's WhatsApp
 * unread-badge poll (checkUnread, every WHATSAPP_UNREAD_POLL_INTERVAL_MS)
 * runs on its own independent schedule from WhatsAppPanel's own poll
 * (every CONNECTED_POLL_INTERVAL_MS), which is what actually keeps the
 * "last seen" marker in storage up to date while the panel is open.
 * openPanel("whatsapp") only zeroes the badge once, at the moment the
 * panel opens -- nothing re-suppresses it afterward, so if checkUnread's
 * own tick lands between a new message arriving and WhatsAppPanel's own
 * poll catching up, the badge flashes a stale nonzero count next to a
 * message the user is already looking at live in the open panel. Fixed
 * by suppressing the badge to 0 whenever the panel is currently open,
 * via a showWhatsAppRef mirroring the showWhatsApp state (read inside
 * checkUnread's closure without restarting the poll's own interval).
 */
test("App's WhatsApp unread-badge poll suppresses a stale nonzero count while the panel is already open, instead of flashing a badge for a message already visible in the open log", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {4}async function checkUnread\(\) \{[\s\S]*?\n {4}\}\n/);
  assert.ok(handlerMatch, "expected to find checkUnread in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(showWhatsAppCurrent: boolean) {
    const state = { count: -1 };
    const showWhatsAppRef = { current: showWhatsAppCurrent };
    const fn = new Function(
      "projectId",
      "cancelled",
      "getWhatsAppStatus",
      "listWhatsAppMessages",
      "countUnreadWhatsAppMessages",
      "getWhatsAppLastSeen",
      "setWhatsappUnreadCount",
      "maybeNotifyNewWhatsAppMessages",
      "lastNotifiedWhatsAppIdRef",
      "document",
      "t",
      "showWhatsAppRef",
      "userIdRef",
      `${code}\nreturn checkUnread;`,
    )(
      "project-1",
      false,
      async () => ({ status: "connected" }),
      async () => ({ messages: [{ id: "msg-2" }], hasMore: false }),
      // A real stale last-seen marker would count msg-2 as 1 unread --
      // decoupled from the real counting logic here since this test is
      // about the suppression wiring, not countUnreadWhatsAppMessages itself.
      () => 1,
      () => "msg-1",
      (v: number) => (state.count = v),
      () => {},
      { current: null },
      { hidden: false },
      (key: string) => key,
      showWhatsAppRef,
      { current: "user1" },
    ) as () => Promise<void>;
    return { fn, state };
  }

  const { fn: fnOpen, state: stateOpen } = run(true);
  await fnOpen();
  assert.equal(
    stateOpen.count,
    0,
    "badge must stay 0 while the WhatsApp panel is already open, even if the stale last-seen marker would otherwise count a message as unread",
  );

  const { fn: fnClosed, state: stateClosed } = run(false);
  await fnClosed();
  assert.equal(stateClosed.count, 1, "badge must still show the real unread count while the panel is closed");
});

/**
 * Round 1046: checkUnread reads getWhatsAppLastSeen(projectId) with no
 * user dimension at all -- the same cross-account leak round 1044/1045
 * already fixed for ideaDraft.ts/recentProjectSearches.ts, just for the
 * WhatsApp unread badge instead. Confirms checkUnread now passes
 * userIdRef.current (the same ref subscribeAuthExpired already reads for
 * this exact "effect doesn't re-run on user change" reason) through as
 * the marker's own second key, and suppresses the badge to 0 -- rather
 * than reading some other account's own marker -- on the one tick where
 * userIdRef.current could still be null (before the login-syncing effect
 * has ever run).
 */
test("App's checkUnread reads the last-seen marker scoped to the current user (userIdRef.current), not just the project, and suppresses the badge instead of guessing when no user is known yet", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {4}async function checkUnread\(\) \{[\s\S]*?\n {4}\}\n/);
  assert.ok(handlerMatch, "expected to find checkUnread in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(userIdCurrent: string | null) {
    const state = { count: -1 };
    const capturedArgs: unknown[][] = [];
    const fn = new Function(
      "projectId",
      "cancelled",
      "getWhatsAppStatus",
      "listWhatsAppMessages",
      "countUnreadWhatsAppMessages",
      "getWhatsAppLastSeen",
      "setWhatsappUnreadCount",
      "maybeNotifyNewWhatsAppMessages",
      "lastNotifiedWhatsAppIdRef",
      "document",
      "t",
      "showWhatsAppRef",
      "userIdRef",
      `${code}\nreturn checkUnread;`,
    )(
      "project-1",
      false,
      async () => ({ status: "connected" }),
      async () => ({ messages: [{ id: "msg-2" }], hasMore: false }),
      (...args: unknown[]) => {
        capturedArgs.push(args);
        return 1;
      },
      (...args: unknown[]) => {
        capturedArgs.push(args);
        return "msg-1";
      },
      (v: number) => (state.count = v),
      () => {},
      { current: null },
      { hidden: false },
      (key: string) => key,
      { current: false },
      { current: userIdCurrent },
    ) as () => Promise<void>;
    return { fn, state, capturedArgs };
  }

  const { fn: fnKnown, state: stateKnown, capturedArgs } = run("user1");
  await fnKnown();
  assert.equal(stateKnown.count, 1, "badge must show the real unread count once a user is known");
  const lastSeenCall = capturedArgs.find((args) => args.length === 2 && args[0] === "project-1");
  assert.deepEqual(lastSeenCall, ["project-1", "user1"], "getWhatsAppLastSeen must be called with both the projectId and the current user's own id");

  const { fn: fnUnknown, state: stateUnknown } = run(null);
  await fnUnknown();
  assert.equal(stateUnknown.count, 0, "badge must suppress to 0, not read a markerless/wrong-user marker, while userIdRef.current is still null");
});

/**
 * Round 710: a real, visible feature -- a failing-automations badge next to
 * the topbar's "⚡ Automations" button, mirroring the WhatsApp unread badge
 * one button over. Before this round, a rule that started failing (webhook
 * endpoint down, WhatsApp disconnected, a stale toField after a refine) was
 * only discoverable by manually opening the Automations panel and reading
 * each rule's own "last run" line -- even though listAutomationRules
 * already returns every rule's lastStatus and the WhatsApp badge next door
 * already demonstrates the exact poll-and-badge pattern needed. Extracts
 * the real checkFailingAutomations poll handler from App.tsx and confirms
 * it counts only ENABLED rules whose lastStatus is "failed", ignoring a
 * disabled rule with a stale failed status and a rule that's never failed.
 */
test("App's checkFailingAutomations counts only enabled rules with lastStatus \"failed\", ignoring disabled rules and non-failing rules", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {4}async function checkFailingAutomations\(\) \{[\s\S]*?\n {4}\}\n/);
  assert.ok(handlerMatch, "expected to find checkFailingAutomations in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(rules: Array<{ enabled: boolean; lastStatus: "sent" | "failed" | null }>) {
    const state = { count: -1 };
    const notifyCalls: unknown[][] = [];
    const fn = new Function(
      "projectId",
      "cancelled",
      "listAutomationRules",
      "setAutomationsFailingCount",
      "maybeNotifyFailingAutomations",
      "lastFailingAutomationIdsRef",
      "document",
      "tRef",
      `${code}\nreturn checkFailingAutomations;`,
    )(
      "project-1",
      false,
      async () => ({ rules }),
      (v: number) => (state.count = v),
      (...args: unknown[]) => notifyCalls.push(args),
      { current: null },
      { hidden: false },
      { current: (key: string) => key },
    ) as () => Promise<void>;
    return { fn, state, notifyCalls };
  }

  const { fn: fnMixed, state: stateMixed, notifyCalls: notifyCallsMixed } = run([
    { enabled: true, lastStatus: "failed" },
    { enabled: false, lastStatus: "failed" }, // disabled -- must not count even though it last failed
    { enabled: true, lastStatus: "sent" }, // enabled but healthy -- must not count
    { enabled: true, lastStatus: null }, // never run yet -- must not count
    { enabled: true, lastStatus: "failed" },
  ]);
  await fnMixed();
  assert.equal(stateMixed.count, 2, "expected exactly the 2 enabled+failed rules to count, not the disabled or healthy ones");
  assert.equal(notifyCallsMixed.length, 1, "checkFailingAutomations must also wire the freshly-fetched rules into maybeNotifyFailingAutomations on every tick");

  const { fn: fnHealthy, state: stateHealthy } = run([
    { enabled: true, lastStatus: "sent" },
    { enabled: true, lastStatus: null },
  ]);
  await fnHealthy();
  assert.equal(stateHealthy.count, 0, "expected 0 when no enabled rule is currently failing");
});

/**
 * Round 891: subscribeViewerDemoted (round 886) only ever fires on the
 * back of a failed write (a VIEWER_READ_ONLY 403) -- it structurally
 * cannot catch the mirror-image case, a collaborator PROMOTED (e.g.
 * viewer -> editor) while they still have the project open: their next
 * write would simply succeed server-side, generating no error to hook
 * into, so myRole stayed stuck at the stale, now-too-restrictive role
 * with no way for the UI to catch up short of leaving and reopening the
 * project. Mirrors the WhatsApp-unread/failing-automations polls' own
 * extraction-and-run test pattern above. Extracts the real checkMyRole
 * poll handler from App.tsx and confirms it re-derives myRole from a
 * fresh listCollaborators call, both upward (viewer -> editor) and
 * downward (editor -> viewer), and falls back to "editor" if this
 * account's own collaborator entry is ever missing from the response --
 * the same fallback openExistingProject's own initial fetch already
 * uses.
 */
test("App's checkMyRole re-derives myRole from a fresh listCollaborators call, in either direction", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {4}async function checkMyRole\(\) \{[\s\S]*?\n {4}\}\n/);
  assert.ok(handlerMatch, "expected to find checkMyRole in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(collaborators: Array<{ userId: string; role: "editor" | "viewer" }>) {
    const state: { role: unknown } = { role: "untouched" };
    const fn = new Function(
      "projectId",
      "userId",
      "cancelled",
      "listCollaborators",
      "setMyRole",
      `${code}\nreturn checkMyRole;`,
    )(
      "project-1",
      "user-1",
      false,
      async () => ({ collaborators }),
      (v: unknown) => (state.role = v),
    ) as () => Promise<void>;
    return { fn, state };
  }

  const { fn: fnPromoted, state: statePromoted } = run([{ userId: "user-1", role: "editor" }]);
  await fnPromoted();
  assert.equal(statePromoted.role, "editor", "a promotion (viewer -> editor) found on the next poll tick must flip myRole upward");

  const { fn: fnDemoted, state: stateDemoted } = run([{ userId: "user-1", role: "viewer" }]);
  await fnDemoted();
  assert.equal(stateDemoted.role, "viewer", "a demotion (editor -> viewer) found on the next poll tick must flip myRole downward too");

  const { fn: fnMissing, state: stateMissing } = run([{ userId: "someone-else", role: "viewer" }]);
  await fnMissing();
  assert.equal(stateMissing.role, "editor", "falls back to 'editor' if this account's own collaborator entry is missing, mirroring openExistingProject's own fallback");
});

/**
 * Round 1183's finding: transferProjectOwnership's own doc comment in
 * api.ts explains it only ever updates the ACTING owner's own held state
 * via that call's direct response -- the new owner's own separate
 * browser tab (if they had this same project open as a mere
 * collaborator when the transfer landed) never received any signal at
 * all. Before this fix, this same poll actively made things WORSE for
 * them: transferProjectOwnership removes the new owner from
 * project_collaborators entirely (an owner is never also a collaborator
 * row), so the test just above's own "falls back to editor if missing"
 * branch fired for them too -- overwriting their real new "owner" status
 * with "editor" -- while project.ownerId stayed stale, hiding every
 * owner-only control in CollaboratorsPanel (isOwner={user?.id ===
 * project.ownerId}) until a manual reload. Confirms the same
 * listCollaborators response's own `owner` field (already returned since
 * round 1052) is now checked first: myRole is set to "owner" and
 * project.ownerId is patched to match, rather than falling through to
 * the missing-collaborator-entry fallback.
 */
test("App's checkMyRole recognizes this account as the project's new owner from a fresh listCollaborators call, after an ownership transfer landed while they still had the project open", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {4}async function checkMyRole\(\) \{[\s\S]*?\n {4}\}\n/);
  assert.ok(handlerMatch, "expected to find checkMyRole in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const state: { role: unknown; projectUpdater: ((p: { id: string; ownerId: string }) => unknown) | undefined } = {
    role: "untouched",
    projectUpdater: undefined,
  };
  const fn = new Function(
    "projectId",
    "userId",
    "cancelled",
    "listCollaborators",
    "setMyRole",
    "setProject",
    `${code}\nreturn checkMyRole;`,
  )(
    "project-1",
    "user-1",
    false,
    // The new owner is no longer in `collaborators` at all -- the exact
    // shape transferProjectOwnership leaves behind.
    async () => ({ collaborators: [{ userId: "someone-else", role: "editor" }], owner: { userId: "user-1", email: "me@example.com" } }),
    (v: unknown) => (state.role = v),
    (updater: (p: { id: string; ownerId: string }) => unknown) => (state.projectUpdater = updater),
  ) as () => Promise<void>;

  await fn();

  assert.equal(state.role, "owner", "myRole must become 'owner', not fall back to 'editor' just because this account is missing from collaborators");
  assert.ok(state.projectUpdater, "setProject must be called to patch project.ownerId so isOwner-gated controls update too");
  const patched = state.projectUpdater!({ id: "project-1", ownerId: "old-owner" }) as { ownerId: string } | null;
  assert.equal(patched?.ownerId, "user-1", "the patched project must carry the new owner's own userId as ownerId");
});

/**
 * Round 1184: the symmetric case the round-1183 fix deliberately deferred
 * -- the FORMER owner's own second open tab, whose local project.ownerId
 * stayed stale (still equal to their own id) after they transferred
 * ownership away in a different tab. Before this round, the poll's own
 * start guard (`project.ownerId === user.id`) read that exact same stale
 * value, so the poll never even ran there to correct it -- a chicken-
 * and-egg problem. This round removed that guard entirely (the poll now
 * always runs once project/user exist, mirroring the WhatsApp-unread/
 * failing-automations polls' own unconditional shape); this test proves
 * checkMyRole's own body, on its own, still does the right thing once
 * given the chance to run: patches project.ownerId to the real new
 * owner and sets myRole to this account's own real remaining role
 * ("editor", the role transferProjectOwnership itself grants the former
 * owner), not "owner".
 */
test("App's checkMyRole corrects a stale project.ownerId and demotes myRole away from 'owner' once this account is no longer the real owner", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {4}async function checkMyRole\(\) \{[\s\S]*?\n {4}\}\n/);
  assert.ok(handlerMatch, "expected to find checkMyRole in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const state: { role: unknown; projectUpdater: ((p: { id: string; ownerId: string }) => unknown) | undefined } = {
    role: "untouched",
    projectUpdater: undefined,
  };
  const fn = new Function(
    "projectId",
    "userId",
    "cancelled",
    "listCollaborators",
    "setMyRole",
    "setProject",
    `${code}\nreturn checkMyRole;`,
  )(
    "project-1",
    "user-1",
    false,
    // transferProjectOwnership adds the former owner back as an "editor"
    // collaborator, and reports the real new owner separately.
    async () => ({ collaborators: [{ userId: "user-1", role: "editor" }], owner: { userId: "new-owner", email: "new-owner@example.com" } }),
    (v: unknown) => (state.role = v),
    (updater: (p: { id: string; ownerId: string }) => unknown) => (state.projectUpdater = updater),
  ) as () => Promise<void>;

  await fn();

  assert.equal(state.role, "editor", "myRole must be demoted to this account's own real remaining role, not stay 'owner'");
  assert.ok(state.projectUpdater, "setProject must be called to correct the stale project.ownerId");
  const patched = state.projectUpdater!({ id: "project-1", ownerId: "user-1" }) as { ownerId: string } | null;
  assert.equal(patched?.ownerId, "new-owner", "the patched project must carry the real new owner's own userId as ownerId");
});

/**
 * Round 1173: this poll effect's own doc comment explicitly claims it
 * "mirrors the WhatsApp-unread/failing-automations polls above (same
 * immediate-check-then-interval shape)" -- but until this round, the
 * implementation only ever called checkMyRole() inside setInterval's
 * first tick, never immediately on mount/restart like its two named
 * siblings actually do. The regex-extraction test above only pulls out
 * checkMyRole's own inner function body, so it structurally cannot see
 * whether the surrounding effect calls it immediately; this test extracts
 * the whole effect callback instead and proves setMyRole is already
 * updated before the (stubbed, never-fired) interval callback would ever
 * run -- the same "calls its own poll function before scheduling the
 * interval" shape the other two polls already pass.
 */
test("App's checkMyRole poll effect calls checkMyRole immediately on mount, not just on the first interval tick", async () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const effectMatch = appSrc.match(
    /useEffect\(\(\) => \{\n( {4}if \(!project \|\| !user\) return;[\s\S]*?)\n {2}\}, \[project\?\.id, project\?\.ownerId, user\?\.id\]\);\n/,
  );
  assert.ok(effectMatch, "expected to find the myRole poll useEffect in App.tsx");
  const { code } = transformSync(`(() => {\n${effectMatch![1]}\n})`, { loader: "ts" });

  let intervalScheduled = false;
  const state: { role: unknown } = { role: "untouched" };
  const effectBody = new Function(
    "project",
    "user",
    "listCollaborators",
    "setMyRole",
    "setProject",
    "setInterval",
    "MY_ROLE_POLL_INTERVAL_MS",
    `return ${code};`,
  )(
    { id: "project-1", ownerId: "owner-1" },
    { id: "collaborator-1" },
    async () => ({ collaborators: [{ userId: "collaborator-1", role: "viewer" }] }),
    (v: unknown) => (state.role = v),
    () => {},
    () => {
      intervalScheduled = true;
      return 0;
    },
    45_000,
  ) as () => () => void;

  effectBody();
  // listCollaborators above resolves immediately (no real network/timer),
  // so one microtask flush is enough for checkMyRole's own promise chain
  // to finish -- no fake timer advance, and the stubbed setInterval above
  // never actually invokes its callback, so this can only pass if
  // checkMyRole() was called directly, not just scheduled for later.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(state.role, "viewer", "checkMyRole must have already run and set myRole before any interval tick fires");
  assert.equal(intervalScheduled, true, "the interval must still be scheduled for subsequent re-checks, in addition to the immediate one");
});

test("App's checkUnread reads tRef.current fresh on every tick instead of closing over a stale `t` from whenever the poll effect last (re)started", async () => {
  // Round 592 regression test: useTranslation()'s `t` is a brand-new closure
  // on every language change, but the poll effect that owns checkUnread only
  // re-runs on project?.id/project?.status -- a language switch mid-session
  // left checkUnread calling maybeNotifyNewWhatsAppMessages with whichever
  // `t` was captured back when the effect last started, so a desktop
  // notification fired after a later language change rendered its title in
  // the OLD language. Fixed the same way showWhatsAppRef (round 560) already
  // solves the identical "read a live value without restarting the poll"
  // problem just above this effect in App.tsx: a ref, kept in sync by its
  // own tiny effect, read as tRef.current inside the interval tick.
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(/ {4}async function checkUnread\(\) \{[\s\S]*?\n {4}\}\n/);
  assert.ok(handlerMatch, "expected to find checkUnread in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const capturedT: ((key: string) => string)[] = [];
  const tRef = { current: (key: string) => `EN:${key}` };
  const fn = new Function(
    "projectId",
    "cancelled",
    "getWhatsAppStatus",
    "listWhatsAppMessages",
    "countUnreadWhatsAppMessages",
    "getWhatsAppLastSeen",
    "setWhatsappUnreadCount",
    "maybeNotifyNewWhatsAppMessages",
    "lastNotifiedWhatsAppIdRef",
    "document",
    "tRef",
    "showWhatsAppRef",
    "userIdRef",
    `${code}\nreturn checkUnread;`,
  )(
    "project-1",
    false,
    async () => ({ status: "connected" }),
    async () => ({ messages: [{ id: "msg-1" }], hasMore: false }),
    () => 0,
    () => null,
    () => {},
    (_messages: unknown, _ref: unknown, _hidden: boolean, tArg: (key: string) => string) => capturedT.push(tArg),
    { current: null },
    { hidden: true },
    tRef,
    { current: false },
    { current: "user1" },
  ) as () => Promise<void>;

  await fn();
  assert.equal(capturedT[0]?.("x"), "EN:x", "the first tick must pass the current tRef.current ('EN')");

  // The language toggle re-renders LanguageProvider with a brand-new `t`,
  // which the tRef-syncing effect writes into tRef.current -- simulated
  // here directly, exactly as that effect would do it.
  tRef.current = (key: string) => `HE:${key}`;
  await fn();
  assert.equal(
    capturedT[1]?.("x"),
    "HE:x",
    "a later tick, after a language switch, must pass the NEW tRef.current ('HE'), not the one captured when the poll effect last started",
  );
});

/**
 * Round 1168: App's own top-level `error` banner, rendered right below
 * `wakingBanner` in the exact same JSX block, had no `role` at all --
 * unlike `wakingBanner` right above it, which already carries
 * `role="status"` (see that element's own doc comment), and unlike every
 * other error surface in this app since round 1158's own sweep. Matched
 * via the real JSX source (App.tsx is never fully rendered in this test
 * file; every App.tsx-specific test here works the same way, matching
 * the real JSX text rather than mounting the component).
 */
test("App.tsx's own top-level error banner carries role=\"alert\", the same convention every other error surface in this app already follows", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const bannerMatch = appSrc.match(/\{wakingBanner\}\s*\{error && \([\s\S]*?\)\}/);
  assert.ok(bannerMatch, "expected to find the top-level error banner's own JSX block, right after wakingBanner");
  assert.match(
    bannerMatch![0],
    /<p className="error banner" role="alert">/,
    "a screen-reader user must be told about a project describe/build/rename/clone/delete failure, not left in total silence while sighted users see the banner appear",
  );
});

/**
 * Round 1220: the `viewer-readonly-banner` right below the preview topbar
 * had no `role` at all -- unlike `wakingBanner`/the `error` banner (round
 * 1168) and `buildWarning` right below it, all of which already carry
 * `role="status"`/`role="alert"`. myRole is genuinely live, not fixed at
 * page load: subscribeViewerDemoted flips it to "viewer" the instant a
 * write 403s with VIEWER_READ_ONLY, and the checkMyRole poll re-derives it
 * independently -- so this banner can newly appear (or disappear, on
 * promotion) mid-session with zero announcement to a screen-reader user who
 * was actively editing when their access was downgraded. Informational, not
 * an error, so it mirrors `buildWarning`'s `role="status"`, not `error
 * banner`'s `role="alert"`.
 */
test("App.tsx's viewer-readonly-banner carries role=\"status\", since myRole can change mid-session via subscribeViewerDemoted/checkMyRole", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const bannerMatch = appSrc.match(/\{myRole === "viewer" && \([\s\S]*?\)\}/);
  assert.ok(bannerMatch, "expected to find the viewer-readonly-banner's own JSX block");
  assert.match(
    bannerMatch![0],
    /<p className="viewer-readonly-banner" role="status">/,
    "a screen-reader user must be told when they are downgraded to read-only mid-session, not left in total silence while sighted users see the banner appear",
  );
});
