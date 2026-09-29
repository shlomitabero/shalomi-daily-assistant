import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentStepEvent, Field, OpenQuestion, Project, User } from "@forge/shared";
import {
  answerQuestions,
  backupProject,
  clearToken,
  cloneProject,
  createProject,
  deleteProject,
  enhanceIdea,
  exportProject,
  getToken,
  listProjects,
  logout,
  me,
  streamBuild,
  streamRefine,
  subscribeWakeStatus,
} from "./api.js";
import { AuthScreen } from "./AuthScreen.js";
import { BuildProgress } from "./BuildProgress.js";
import { BusinessTwinPanel } from "./BusinessTwinPanel.js";
import { EntityPanel } from "./EntityPanel.js";
import { GlobalSearchPanel } from "./GlobalSearchPanel.js";
import { HistoryPanel } from "./HistoryPanel.js";
import { WhatsAppPanel } from "./WhatsAppPanel.js";
import { CollaboratorsPanel } from "./CollaboratorsPanel.js";
import { ChangePasswordPanel } from "./ChangePasswordPanel.js";
import { DeleteAccountPanel } from "./DeleteAccountPanel.js";
import { ProjectNameEditor } from "./ProjectNameEditor.js";
import { ShortcutsPanel } from "./ShortcutsPanel.js";
import { AddAssumptionForm, AddEntityForm, AddRoleForm, AssumptionItem, EntitySummaryItem, RoleChip } from "./SpecListItemRemover.js";
import { applyColumnOrder, reorderColumns } from "./columnOrder.js";
import { getEntityTabOrder, setEntityTabOrder } from "./entityTabOrder.js";
import { getPinnedIds, sortByPinned, togglePinned } from "./pinnedProjects.js";
import { visibleSelectedIds } from "./projectSelection.js";
import { getProjectSortMode, setProjectSortMode, type ProjectSortMode } from "./projectSortMode.js";
import {
  getProjectStatusFilter,
  setProjectStatusFilter as persistProjectStatusFilter,
  type ProjectStatusFilter,
} from "./projectStatusFilter.js";
import { clearIdeaDraft, getIdeaDraft, saveIdeaDraft } from "./ideaDraft.js";
import { formatDocumentTitle } from "./documentTitle.js";
import { LanguageProvider, useTranslation } from "./i18n/LanguageContext.js";
import { LanguageSwitcher } from "./i18n/LanguageSwitcher.js";
import type { Lang } from "./i18n/language.js";
import { ThemeProvider } from "./theme/ThemeContext.js";
import { ThemeSwitcher } from "./theme/ThemeSwitcher.js";

type View = "home" | "spec" | "building" | "preview";

const LOCALE: Record<string, string> = { he: "he-IL", en: "en-US" };

/** A project card's own creation date, locale-formatted -- separated out (rather than inlined in the JSX) purely so it's directly unit-testable, matching this file's own summarizeRefineImpact/filterAndSortProjects convention. */
export function formatProjectCreatedDate(createdAt: string, lang: Lang): string {
  return new Date(createdAt).toLocaleDateString(LOCALE[lang]);
}

/**
 * createProject's own response has always carried a real providerName
 * ("heuristic", "anthropic", or "anthropic-fallback" -- see
 * generateSpec's own doc comment in packages/spec-engine/src/index.ts,
 * which tags a real AI failure as "-fallback" specifically so it's never
 * silently mistaken for the normal no-API-key heuristic response) -- but
 * the client only ever destructured `{ project }` off it, discarding the
 * one honest signal for whether a spec was actually AI-generated or the
 * deterministic engine took over, including the case where a real AI
 * failure degraded silently. Returns null for a re-opened existing
 * project, where this information was never captured.
 */
export function specProviderLabel(providerName: string | null, t: (key: string) => string): string | null {
  if (providerName === null) return null;
  if (providerName === "anthropic") return t("spec.provider.ai");
  if (providerName === "anthropic-fallback") return t("spec.provider.aiFallback");
  return t("spec.provider.heuristic");
}

/**
 * Clickable starting points on the home screen -- fills the textarea with a
 * fuller example description instead of leaving new users staring at an
 * empty box with no sense of what a good description looks like. Also
 * fills the large empty area below the form on a tall desktop viewport
 * (see docs/product-quality-audit.md).
 */
const IDEA_EXAMPLES = [
  { icon: "💇", labelKey: "home.examples.salon.label", textKey: "home.examples.salon.text" },
  { icon: "🍽️", labelKey: "home.examples.restaurant.label", textKey: "home.examples.restaurant.text" },
  { icon: "🏋️", labelKey: "home.examples.gym.label", textKey: "home.examples.gym.text" },
  { icon: "🛍️", labelKey: "home.examples.shop.label", textKey: "home.examples.shop.text" },
  { icon: "📈", labelKey: "home.examples.crm.label", textKey: "home.examples.crm.text" },
] as const;

interface RefineHistoryEntry {
  id: string;
  instruction: string;
  summary: string;
  completedAt: string;
}

/** A refine history entry's own completion time, locale-formatted -- separated out (rather than inlined in the JSX) purely so it's directly unit-testable, matching this file's own formatProjectCreatedDate convention. */
export function formatRefineTimestamp(completedAt: string, lang: Lang): string {
  return new Date(completedAt).toLocaleString(LOCALE[lang]);
}

/**
 * Case-insensitive substring match on a refine-history entry's own
 * instruction text -- the same "Your projects" (filterAndSortProjects) and
 * Time Machine (checkpointDiff.ts's filterCheckpoints) convention, applied
 * here to this pane's own conversation history. Every refine adds one more
 * entry to this list forever (no cap, no delete, and unlike Time Machine's
 * own checkpoint list it never even gets cleared when switching projects
 * mid-session), so a person who has refined a project a dozen times had no
 * way to find "that one where I added invoice tracking" besides scrolling
 * and reading every entry.
 */
export function filterRefineHistory(entries: RefineHistoryEntry[], search: string): RefineHistoryEntry[] {
  const query = search.trim().toLowerCase();
  if (!query) return entries;
  return entries.filter((e) => e.instruction.toLowerCase().includes(query));
}

/**
 * Removes a single entry from the refine-history list -- the "no delete"
 * half of the comment above this list's own state declaration. Purely
 * local: refine history is never persisted server-side (it resets on every
 * reload/project-switch, see handleGoHome/handleLogout), so unlike Time
 * Machine's own per-checkpoint delete (round 216) this needs no API call
 * at all, just a filter over the in-memory list.
 */
export function removeRefineHistoryEntry(entries: RefineHistoryEntry[], id: string): RefineHistoryEntry[] {
  return entries.filter((e) => e.id !== id);
}

interface ArchitectImpactDetail {
  newEntities: { name: string; label: string }[];
  changedEntities: { name: string; label: string; newFieldNames: string[] }[];
}

/**
 * Turns the real Architect event's impact payload from a completed refine
 * into a one-line summary for the conversation history -- the same data
 * the AI Team screen's own detail panel shows, not a re-statement of the
 * instruction the user already sees above it.
 */
/** Case-insensitive substring match on project name, then pinned-first sort -- the two independent steps "Your projects" narrows and reorders by. */
/**
 * `sortMode` reorders WITHIN the pinned/unpinned split sortByPinned
 * already does, rather than replacing it -- "alphabetical" still floats
 * pinned projects to the top, just sorted by name inside each of the two
 * groups, instead of abandoning pinning entirely. Sorting alphabetically
 * before handing off to sortByPinned (rather than after) is what makes
 * this work: sortByPinned's own contract is "preserve each group's
 * existing relative order," so whatever order `ordered` is already in
 * becomes each group's order once split.
 */
export function filterAndSortProjects(
  projects: Project[],
  search: string,
  pinnedIds: Set<string>,
  sortMode: ProjectSortMode = "recent",
): Project[] {
  const query = search.trim().toLowerCase();
  const matched = query ? projects.filter((p) => p.name.toLowerCase().includes(query)) : projects;
  const ordered = sortMode === "alphabetical" ? [...matched].sort((a, b) => a.name.localeCompare(b.name)) : matched;
  return sortByPinned(ordered, pinnedIds);
}

/**
 * Narrows "Your projects" down to just the built ones or just the drafts --
 * the same "Draft" chip (round 149) already tells you which is which one
 * card at a time, but with enough projects there was no way to see only
 * the drafts still waiting to be built, or hide them while looking for a
 * finished app. Mirrors filterCheckpointsByType's own "all" passthrough
 * convention (checkpointDiff.ts) rather than introducing a new one.
 */
export function filterProjectsByStatus(projects: Project[], statusFilter: ProjectStatusFilter): Project[] {
  if (statusFilter === "all") return projects;
  return projects.filter((p) => p.status === statusFilter);
}

/**
 * How many of "Your projects" are currently showing versus how many exist
 * in total -- the same two-distinct-phrasings convention
 * formatEntityRecordCount (entityFormatting.ts, round 155) already
 * established for an entity's own record table, applied here to the home
 * screen's project list. The search box itself has existed since round
 * 133, but never showed how many projects it actually narrowed down to,
 * so a person searching had no sense of "found 2" versus "found all 12"
 * without counting the cards themselves -- and once a list is long enough
 * to show the search box at all (more than 5 projects), that's no longer
 * a glance.
 */
export function formatMyProjectsCount(
  shown: number,
  total: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  return shown === total
    ? t("home.myProjects.count.all", { count: total })
    : t("home.myProjects.count.filtered", { shown, total });
}

/**
 * A required field is marked with a trailing " *" once a project is
 * actually built and its record forms render (see
 * FieldLabelEditor.tsx's own `field.required ? " *" : ""`), but the
 * spec-review screen's entity summary -- the one place a person can still
 * see this BEFORE committing to a build -- just joined field names with
 * no distinction at all. Matches that exact same convention, so it reads
 * as one consistent app rather than two different vocabularies for the
 * same fact.
 */
export function formatEntityFieldSummary(fields: Field[]): string {
  return fields.map((f) => `${f.label ?? f.name}${f.required ? " *" : ""}`).join(", ");
}

/**
 * How many of the spec's open questions already have an answer -- the chip
 * buttons and the free-text input both write into the same
 * selectedAnswers[q.question] slot (see the spec-review view below), so an
 * answer is just a non-blank value there, regardless of which control set
 * it. Backs the "answered N of M" progress line, so a person with a long
 * list of open questions doesn't have to scroll and count for themselves
 * whether they've addressed everything before clicking build.
 */
export function countAnsweredOpenQuestions(
  openQuestions: OpenQuestion[],
  selectedAnswers: Record<string, string>,
): { answered: number; total: number } {
  const answered = openQuestions.filter((q) => (selectedAnswers[q.question] ?? "").trim().length > 0).length;
  return { answered, total: openQuestions.length };
}

/**
 * Renders countAnsweredOpenQuestions' own result as the actual progress
 * line -- three distinct phrasings (none/some/all) rather than one
 * "answered N of M" for every case, since 0-answered isn't just a number
 * that happens to be zero (it needs the reassurance that answering is
 * optional) and all-answered is worth a small confirmation, not a plain
 * fraction that reads as "there's still 3 more to go".
 */
export function formatOpenQuestionsProgress(
  openQuestions: OpenQuestion[],
  selectedAnswers: Record<string, string>,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const { answered, total } = countAnsweredOpenQuestions(openQuestions, selectedAnswers);
  if (answered === 0) return t("spec.openQuestions.answeredCount.none", { total });
  if (answered === total) return t("spec.openQuestions.answeredCount.all", { total });
  return t("spec.openQuestions.answeredCount.some", { answered, total });
}

export function summarizeRefineImpact(events: AgentStepEvent[], t: (key: string) => string): string {
  // A Database-step failure the Debug Agent recovers from re-emits a
  // second, corrected Architect success event (see pipeline.ts's
  // architectEvent() helper being called again after the fix) -- take the
  // LAST match here, not the first, so this reflects what was actually
  // built rather than the stale pre-recovery detail. BuildProgress.tsx's
  // own latestByAgent map already does this correctly (a later event
  // naturally overwrites an earlier one for the same agent); this is the
  // one other consumer of the raw event list that needed the same fix.
  let architectEvent: AgentStepEvent | undefined;
  for (const e of events) {
    if (e.agent === "Architect" && e.status === "success") architectEvent = e;
  }
  const detail = architectEvent?.detail as ArchitectImpactDetail | undefined;
  if (!detail) return t("preview.refineHistory.noSummary");
  const parts: string[] = [];
  for (const e of detail.newEntities) {
    parts.push(`${t("build.detail.architect.newScreen")}${e.label}`);
  }
  for (const e of detail.changedEntities) {
    parts.push(`${e.label}${t("build.detail.architect.gainedFields")}${e.newFieldNames.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : t("preview.refineHistory.noChange");
}

/**
 * Guards the "/" global-search shortcut (added alongside Ctrl/Cmd+K) so it
 * only fires when the user isn't already typing somewhere -- an idea
 * textarea, a record's text field, the refine box all use "/" as an
 * ordinary character, and would otherwise get hijacked into opening search
 * on every slash keystroke. Duck-typed on tagName/isContentEditable (not
 * `instanceof HTMLElement`) so this stays a plain pure function, testable
 * with a plain mock object instead of a real DOM element.
 */
export function isEditableEventTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

export default function App() {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <AppContent />
      </LanguageProvider>
    </ThemeProvider>
  );
}

function AppContent() {
  const { t, lang } = useTranslation();
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [waking, setWaking] = useState(false);
  const [view, setView] = useState<View>("home");
  const [description, setDescription] = useState(getIdeaDraft);
  const [project, setProject] = useState<Project | null>(null);
  // Which spec provider actually built the CURRENT draft's spec -- null for
  // a re-opened existing project (createProject's own response is the only
  // source of this, and it isn't stored on the project itself, so there's
  // nothing honest to show once you've navigated away and come back).
  const [specProvider, setSpecProvider] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enhanceBusy, setEnhanceBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeEntity, setActiveEntity] = useState<string | null>(null);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({});
  const [additionalRequest, setAdditionalRequest] = useState("");
  const [refineText, setRefineText] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [exportDone, setExportDone] = useState(false);
  const [backupDone, setBackupDone] = useState(false);
  const [showTwin, setShowTwin] = useState(false);
  const [showWhatsApp, setShowWhatsApp] = useState(false);
  const [showCollaborators, setShowCollaborators] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [myProjects, setMyProjects] = useState<Project[]>([]);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => getPinnedIds());
  const [projectSortMode, setProjectSortModeState] = useState<ProjectSortMode>(() => getProjectSortMode());
  const [projectSearch, setProjectSearch] = useState("");
  const [projectStatusFilter, setProjectStatusFilterState] = useState<ProjectStatusFilter>(() => getProjectStatusFilter());
  const [cloningId, setCloningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [refineHistory, setRefineHistory] = useState<RefineHistoryEntry[]>([]);
  const [refineHistorySearch, setRefineHistorySearch] = useState("");
  const [refineRunning, setRefineRunning] = useState(false);
  const [highlightRecordId, setHighlightRecordId] = useState<number | null>(null);
  const [entityTabOrder, setEntityTabOrderState] = useState<string[]>([]);
  const [draggedEntityTab, setDraggedEntityTab] = useState<string | null>(null);
  const [dragOverEntityTab, setDragOverEntityTab] = useState<string | null>(null);
  const pendingRefineInstruction = useRef<string | null>(null);
  const refineEvents = useRef<AgentStepEvent[]>([]);

  // The tab bar's own persisted order is scoped per project (entityTabOrder.ts),
  // so it has to be reloaded every time a different project is opened --
  // otherwise a project with entities in an unrelated order would briefly
  // render with the *previous* project's own dragged-into-place order.
  useEffect(() => {
    setEntityTabOrderState(project ? getEntityTabOrder(project.id) : []);
  }, [project?.id]);

  const orderedEntities = useMemo(
    () => (project ? applyColumnOrder(project.spec.entities, entityTabOrder) : []),
    [project, entityTabOrder],
  );

  /**
   * Dragging an entity tab to just before another one's -- the live
   * preview's own tab bar otherwise always mirrored spec.entities' fixed
   * generation order (whichever order the heuristic/AI engine happened to
   * produce entities in), with no way to put the screen you actually use
   * most first. Mirrors EntityPanel.tsx's own handleReorderColumn exactly,
   * down to reusing the same reorderColumns helper -- Entity has a `name`
   * field just like a table's own fields do, so the column-reorder math
   * needed no changes at all, only a separate (per-project, not
   * per-project+entity) storage key.
   */
  function handleReorderEntityTab(targetName: string) {
    setDragOverEntityTab(null);
    if (!project || !draggedEntityTab || draggedEntityTab === targetName) return;
    const fullOrder = orderedEntities.map((e) => e.name);
    setEntityTabOrderState(setEntityTabOrder(project.id, reorderColumns(fullOrder, draggedEntityTab, targetName)));
    setDraggedEntityTab(null);
  }

  const visibleMyProjects = useMemo(
    () => filterAndSortProjects(filterProjectsByStatus(myProjects, projectStatusFilter), projectSearch, pinnedIds, projectSortMode),
    [myProjects, projectStatusFilter, projectSearch, pinnedIds, projectSortMode],
  );

  /**
   * The raw `selectedProjectIds` set is never reset when the search/filter
   * changes, so a project selected earlier and then hidden by a new filter
   * would otherwise stay silently "selected" -- still counted in the bulk
   * bar, and still deleted by a real bulk-delete, with no way for the user
   * to see it was about to happen. Everything the UI shows or acts on uses
   * this visibility-scoped view instead of the raw set.
   */
  const visibleSelectedProjectIds = useMemo(
    () => visibleSelectedIds(selectedProjectIds, visibleMyProjects.map((p) => p.id)),
    [selectedProjectIds, visibleMyProjects],
  );

  function handleSetProjectSortMode(mode: ProjectSortMode) {
    setProjectSortModeState(mode);
    setProjectSortMode(mode);
  }
  function handleSetProjectStatusFilter(filter: ProjectStatusFilter) {
    setProjectStatusFilterState(filter);
    persistProjectStatusFilter(filter);
  }
  const visibleRefineHistory = useMemo(
    () => filterRefineHistory(refineHistory, refineHistorySearch),
    [refineHistory, refineHistorySearch],
  );

  useEffect(() => subscribeWakeStatus(setWaking), []);

  /**
   * The six overlay panels (History, Business Twin, WhatsApp,
   * Collaborators, Search, Shortcuts) are each a full-screen backdrop (see
   * "history-overlay" in styles.css) -- opening one without closing the
   * others (e.g. Ctrl+K for search while History is already open from a
   * toolbar click) used to stack two of them at once instead of replacing
   * one with the other, since each "open" button only ever set its own
   * boolean to true and never touched the rest. Routes every open through
   * here so opening any one panel always closes the rest first.
   */
  function openPanel(panel: "history" | "twin" | "whatsapp" | "collaborators" | "search" | "shortcuts") {
    setShowHistory(panel === "history");
    setShowTwin(panel === "twin");
    setShowWhatsApp(panel === "whatsapp");
    setShowCollaborators(panel === "collaborators");
    setShowSearch(panel === "search");
    setShowShortcuts(panel === "shortcuts");
  }

  /**
   * Ctrl/Cmd+K opens global search from anywhere in the preview screen (a
   * command-palette convention users already know from other tools), and
   * Escape closes whichever overlay panel is currently open. Only active
   * in the preview view so it can't fire while filling in the home-screen
   * idea textarea or the spec-review form.
   *
   * "/" is a second, even more familiar way to open the same search (the
   * convention GitHub, Slack, and others already use), guarded by
   * isEditableEventTarget so it doesn't hijack every literal "/" a person
   * types into the refine box or a record's own text field.
   *
   * "?" opens a cheat-sheet of every keyboard shortcut this app actually
   * has (this one included, plus j/k row navigation from EntityPanel.tsx,
   * round 188) -- these accumulated one round at a time with no single
   * place a person could ever see the full list, so nobody who didn't
   * read a changelog would know most of them existed. Same
   * isEditableEventTarget guard as "/", since "?" is just as ordinary a
   * character to type into a text field.
   */
  useEffect(() => {
    if (view !== "preview") return;
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openPanel("search");
        return;
      }
      if (e.key === "/" && !isEditableEventTarget(e.target)) {
        e.preventDefault();
        openPanel("search");
        return;
      }
      if (e.key === "?" && !isEditableEventTarget(e.target)) {
        e.preventDefault();
        openPanel("shortcuts");
        return;
      }
      if (e.key === "Escape") {
        setShowHistory(false);
        setShowTwin(false);
        setShowSearch(false);
        setShowWhatsApp(false);
        setShowCollaborators(false);
        setShowShortcuts(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [view]);

  useEffect(() => {
    if (!getToken()) {
      setCheckingSession(false);
      return;
    }
    me()
      .then(({ user }) => setUser(user))
      .catch(() => clearToken())
      .finally(() => setCheckingSession(false));
  }, []);

  /**
   * `project` is plain in-memory React state with nothing behind it once
   * the tab reloads or a fresh login happens -- there was previously no way
   * back into a project you'd already created, not even your own, since
   * nothing ever called listProjects(). That also meant a collaborator
   * invited to someone else's project (see CollaboratorsPanel) had no way
   * to actually reach it: the API granted them real access immediately,
   * but the UI never showed them anything beyond "start something new".
   * Reloading on every return to the home screen (not just once on login)
   * keeps this list correct after creating a project, being removed as a
   * collaborator, etc., without needing a dedicated refresh action.
   */
  useEffect(() => {
    if (!user || view !== "home") return;
    listProjects()
      .then(({ projects }) => setMyProjects(projects))
      .catch(() => setMyProjects([]));
  }, [user, view]);

  /**
   * Both handleExport/handleBackup's own downloads resolve the instant the
   * browser's own save dialog is triggered, with nothing shown afterward --
   * the button just silently reverted to its idle label, easy to miss for a
   * multi-second zip download. Same transient "done" flash + auto-reset
   * idiom as BuildProgress.tsx's own copyStatus (round 222+), just for a
   * real file download instead of a clipboard copy. Declared here (above
   * the `if (!user) return <AuthScreen />` early return further down) so
   * these two hooks run on every render regardless of auth state, like
   * every other hook in this component -- declaring them further down,
   * after that early return, would call a different number of hooks
   * between the signed-out and signed-in renders and crash React.
   */
  useEffect(() => {
    if (!exportDone) return;
    const timer = setTimeout(() => setExportDone(false), 2000);
    return () => clearTimeout(timer);
  }, [exportDone]);

  useEffect(() => {
    if (!backupDone) return;
    const timer = setTimeout(() => setBackupDone(false), 2000);
    return () => clearTimeout(timer);
  }, [backupDone]);

  /**
   * The browser tab title otherwise stays a static "Forge AI" the entire
   * session, whether or not a project is open -- with two or more projects
   * open in separate tabs there's no way to tell them apart from the tab
   * bar, alt-tab switcher, or browser history. Declared above the
   * `if (!user) return <AuthScreen />` early return below like every other
   * hook in this component (see the comment above the exportDone/backupDone
   * effects for why that placement is required).
   */
  useEffect(() => {
    document.title = formatDocumentTitle(project?.name ?? null);
  }, [project]);

  function openExistingProject(p: Project) {
    setProject(p);
    setActiveEntity(p.spec.entities[0]?.name ?? null);
    setSpecProvider(null);
    setView(p.status === "built" ? "preview" : "spec");
  }

  /**
   * Clones a project's blueprint (spec + description) into a brand-new
   * draft the requester owns -- never the source's actual data, so this
   * is safe to offer on a shared project too (see the API route's own
   * comment). Jumps straight into the new project's spec review screen,
   * same as creating one from scratch, rather than leaving the user on
   * the home screen wondering whether anything happened.
   */
  async function handleDuplicateProject(p: Project) {
    setCloningId(p.id);
    setError(null);
    try {
      const { project: cloned } = await cloneProject(p.id);
      openExistingProject(cloned);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCloningId(null);
    }
  }

  /**
   * Permanently deletes a project (the API's own requireProjectOwner
   * restricts this to the owner -- a collaborator only has read/write
   * access to the project's data, not the right to take it away from
   * everyone else, so this button is only ever rendered for the owner in
   * the first place). Irreversible, so it's gated behind a plain
   * window.confirm, matching this codebase's one existing delete
   * confirmation (EntityPanel's own record-delete). Updates myProjects
   * directly instead of re-fetching the whole list, since the home
   * screen's own listProjects() effect only re-runs on a `view` change,
   * not after every mutation.
   */
  async function handleDeleteProject(p: Project) {
    if (!window.confirm(t("home.myProjects.confirmDelete", { name: p.name }))) return;
    setDeletingId(p.id);
    setError(null);
    try {
      await deleteProject(p.id);
      setMyProjects((prev) => prev.filter((existing) => existing.id !== p.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingId(null);
    }
  }

  function toggleProjectSelected(id: string) {
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Same Promise.allSettled resilience as EntityPanel's own handleBulkDelete:
  // a single rejected delete (a dropped connection, a project someone else
  // already removed) must not hide the ones that *did* succeed.
  async function handleBulkDeleteProjects() {
    const ids = [...visibleSelectedProjectIds];
    if (ids.length === 0) return;
    if (!window.confirm(t("home.myProjects.bulk.confirmDelete", { count: ids.length }))) return;
    setError(null);
    const results = await Promise.allSettled(ids.map((id) => deleteProject(id)));
    const failedIds = ids.filter((_, i) => results[i].status === "rejected");
    const succeededIds = new Set(ids.filter((_, i) => results[i].status === "fulfilled"));
    setMyProjects((prev) => prev.filter((p) => !succeededIds.has(p.id)));
    setSelectedProjectIds(new Set(failedIds));
    if (failedIds.length > 0) {
      const firstFailure = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
      setError(
        failedIds.length === ids.length
          ? (firstFailure.reason as Error).message
          : t("home.myProjects.bulk.partialFailure", { failed: failedIds.length, total: ids.length }),
      );
    }
  }

  // role="status" (implying aria-live="polite") so a screen-reader user is
  // actually told the server is waking up, instead of sitting through up to
  // a minute of silence with no way to tell a slow cold start from a hang.
  const wakingBanner = waking && (
    <p className="waking banner" role="status">
      {t("app.waking")}
    </p>
  );

  if (checkingSession) {
    return (
      <div className="app">
        {wakingBanner}
        <p className="muted">{t("app.loading")}</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="app">
        {wakingBanner}
        <AuthScreen onAuthenticated={setUser} />
      </div>
    );
  }

  // Only the owner's own projects can ever be deleted (mirrors
  // handleDeleteProject's own ownerId check on the single-delete button), so
  // "select all" only ever selects/deselects the ones bulk-delete could
  // actually act on -- a collaborator's shared project never gets a
  // checkbox at all.
  const toggleSelectAllOwnedProjects = () => {
    const ownedIds = visibleMyProjects.filter((p) => p.ownerId === user.id).map((p) => p.id);
    const allSelected = ownedIds.length > 0 && ownedIds.every((id) => selectedProjectIds.has(id));
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of ownedIds) next.delete(id);
      } else {
        for (const id of ownedIds) next.add(id);
      }
      return next;
    });
  };

  async function handleDescribe(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { project, providerName } = await createProject(description);
      setProject(project);
      setSpecProvider(providerName);
      setView("spec");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * The "improve my idea then build" loop: sends the raw idea to the Prompt
   * Architect Agent, shows the rewritten prompt it wrote back in the
   * textarea (nothing hidden), then immediately runs that AI-written prompt
   * through the normal create-project pipeline -- the app builds its own
   * prompt, then builds itself from it.
   */
  async function handleEnhanceAndBuild() {
    if (!description.trim()) return;
    setEnhanceBusy(true);
    setError(null);
    try {
      const { enhanced } = await enhanceIdea(description);
      setDescription(enhanced);
      saveIdeaDraft(enhanced);
      const { project, providerName } = await createProject(enhanced);
      setProject(project);
      setSpecProvider(providerName);
      setView("spec");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setEnhanceBusy(false);
    }
  }

  // Leaves the just-created draft project exactly as-is (never deletes it
  // -- it's still reachable and re-openable from "Your projects", same as
  // any other unbuilt draft) and just navigates back. Keeps `description`
  // populated so the idea text is still there to tweak and resubmit, but
  // clears selectedAnswers/additionalRequest since those answered the
  // now-abandoned draft's own open questions, not whatever gets created next.
  function handleBackToHome() {
    setView("home");
    setProject(null);
    setSpecProvider(null);
    setSelectedAnswers({});
    setAdditionalRequest("");
  }

  /**
   * Once a project was built, there was no way back to "Your projects"
   * short of logging all the way out and back in -- the topbar's own
   * brand logo was purely decorative, and handleBackToHome above only
   * ever runs from the spec review screen's own Back button. Reuses the
   * exact same leftover-state cleanup handleLogout's own comment already
   * describes (a stale activeEntity/refineHistory/etc. bleeding into
   * whatever project gets opened next), just without touching the
   * authenticated user or the home screen's own saved idea draft.
   */
  function handleGoHome() {
    setView("home");
    setProject(null);
    setSpecProvider(null);
    setSelectedAnswers({});
    setAdditionalRequest("");
    setActiveEntity(null);
    setRefineText("");
    setRefineHistory([]);
    setRefineHistorySearch("");
  }

  async function handleExport() {
    if (!project) return;
    setExportBusy(true);
    setError(null);
    try {
      await exportProject(project.id, project.name);
      setExportDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExportBusy(false);
    }
  }

  async function handleBackup() {
    if (!project) return;
    setBackupBusy(true);
    setError(null);
    try {
      await backupProject(project.id, project.name);
      setBackupDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleBuild() {
    if (!project) return;
    const answered = Object.fromEntries(Object.entries(selectedAnswers).filter(([, v]) => v.trim().length > 0));
    const request = additionalRequest.trim();
    if (Object.keys(answered).length > 0 || request.length > 0) {
      setBusy(true);
      setError(null);
      try {
        const { project: updated } = await answerQuestions(project.id, answered, request || undefined);
        setProject(updated);
      } catch (err) {
        setError((err as Error).message);
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    setView("building");
  }

  function handleRefine(e: React.FormEvent) {
    e.preventDefault();
    if (!refineText.trim()) return;
    pendingRefineInstruction.current = refineText.trim();
    refineEvents.current = [];
    setRefineRunning(true);
  }

  /**
   * Clicking a past refine's own instruction text loads it back into the
   * refine box, instead of only ever showing it as inert history a person
   * had to retype from scratch to run again (e.g. "add a discount field"
   * a second time with a small tweak, or after refining it away by
   * mistake). Only ever prefills the box for editing -- it never
   * auto-submits, so it's never a surprise second refine firing on a
   * single click. Ignored while a refine is already running: the box
   * itself is hidden behind the live BuildProgress view then, so setting
   * it would just be invisible state a person never asked for.
   */
  function handleReuseRefineInstruction(instruction: string) {
    if (refineRunning) return;
    setRefineText(instruction);
  }

  function handleRemoveRefineHistoryEntry(id: string) {
    setRefineHistory((prev) => removeRefineHistoryEntry(prev, id));
  }

  function handleBuildComplete(builtProject: Project) {
    if (refineRunning && pendingRefineInstruction.current) {
      const entry: RefineHistoryEntry = {
        id: crypto.randomUUID(),
        instruction: pendingRefineInstruction.current,
        summary: summarizeRefineImpact(refineEvents.current, t),
        completedAt: new Date().toISOString(),
      };
      setRefineHistory((prev) => [...prev, entry]);
    }
    pendingRefineInstruction.current = null;
    setProject(builtProject);
    // A refine's regenerated spec is free to drop an entity the previous
    // one had (the AI provider isn't guaranteed to keep every entity, e.g.
    // an instruction like "remove deals tracking, focus on invoices" --
    // see routes/projects.ts's own comment on /refine). Keeping the stale
    // `prev` tab name in that case leaves the entity-tabs filter matching
    // nothing (`.filter((e) => e.name === activeEntity)`), so the preview
    // pane goes blank with no tab visibly selected until the user manually
    // clicks another one -- the same "stale activeEntity" failure mode
    // handleLogout's own cleanup below already guards against.
    setActiveEntity((prev) =>
      prev && builtProject.spec.entities.some((e) => e.name === prev) ? prev : (builtProject.spec.entities[0]?.name ?? null),
    );
    setRefineText("");
    setAdditionalRequest("");
    setRefineRunning(false);
    setView("preview");
  }

  async function handleLogout() {
    await logout();
    setUser(null);
    setProject(null);
    setView("home");
    // Without these, the browser tab stays mounted (no page reload happens
    // on logout) and the next project built in the same session -- by the
    // same user logging back in, or a different one on a shared machine --
    // inherits the previous project's leftover UI state: a stale
    // activeEntity tab name that doesn't exist on the new project's spec
    // (rendering a blank preview pane until manually re-clicked), the old
    // project's refine-history chat entries, and half-filled form state.
    setDescription("");
    clearIdeaDraft();
    setError(null);
    setActiveEntity(null);
    setSelectedAnswers({});
    setAdditionalRequest("");
    setRefineText("");
    setRefineHistory([]);
    setRefineHistorySearch("");
  }

  /**
   * Runs once DeleteAccountPanel's own DELETE /auth/account call has
   * already succeeded server-side -- the account, its projects, and every
   * one of its sessions (including this one) are already gone by this
   * point, so unlike handleLogout above this never calls the API's own
   * logout() (there's no session left to revoke, and the token is already
   * dead) -- just the same local-state cleanup, straight back to the auth screen.
   */
  function handleAccountDeleted() {
    clearToken();
    setShowDeleteAccount(false);
    setUser(null);
    setProject(null);
    setView("home");
    setDescription("");
    clearIdeaDraft();
    setError(null);
    setActiveEntity(null);
    setSelectedAnswers({});
    setAdditionalRequest("");
    setRefineText("");
    setRefineHistory([]);
    setRefineHistorySearch("");
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title">
          {(() => {
            const brandContent = (
              <>
                <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                  <path
                    d="M16 2c1.2 4.4-1.6 6.4-3.4 8.6-2.2 2.7-3.2 5.6-1.8 8.9 1 2.3 3 3.7 5.2 3.7-1.4-2-1.4-3.8-.3-5.6 1-1.6 2.6-2.3 2.9-4.3.9 1.6 1.4 3.2 1.2 5-.2 2.1-1.4 3.7-1.4 3.7 3.6-.6 6.6-3.6 6.6-7.6 0-3.4-2-5.6-3.8-7.6-2.6-2.9-4.4-5.6-5.2-8.8Z"
                    fill="var(--accent)"
                  />
                </svg>
                <span className="brand">Forge AI</span>
              </>
            );
            // Deliberately not clickable while a build/refine is actively
            // streaming (view === "building") -- BuildProgress's own design
            // only ever offers a way out on failure, and this shouldn't
            // silently disagree with that by giving a second, unguarded exit.
            return view !== "home" && view !== "building" ? (
              <button type="button" className="brand-row brand-row-link" onClick={handleGoHome} title={t("topbar.goHome")}>
                {brandContent}
              </button>
            ) : (
              <div className="brand-row">{brandContent}</div>
            );
          })()}
          <span className="tagline">{t("brand.tagline")}</span>
        </div>
        <div className="topbar-right">
          <ThemeSwitcher />
          <LanguageSwitcher />
          <span className="muted small">{user.email}</span>
          <button type="button" className="secondary" onClick={() => setShowChangePassword(true)}>
            {t("topbar.changePassword")}
          </button>
          <button type="button" className="secondary" onClick={() => setShowDeleteAccount(true)}>
            {t("topbar.deleteAccount")}
          </button>
          <button type="button" className="secondary" onClick={handleLogout}>
            {t("topbar.logout")}
          </button>
        </div>
      </header>

      {showChangePassword && <ChangePasswordPanel onClose={() => setShowChangePassword(false)} />}
      {showDeleteAccount && (
        <DeleteAccountPanel
          email={user.email}
          userId={user.id}
          onClose={() => setShowDeleteAccount(false)}
          onDeleted={handleAccountDeleted}
        />
      )}

      {wakingBanner}
      {error && <p className="error banner">{error}</p>}

      {view === "home" && (
        <main className="home">
          {myProjects.length > 0 && (
            <div className="my-projects">
              <h2>
                {t("home.myProjects.heading")}
                <span className="muted small home-projects-count">
                  {" "}
                  — {formatMyProjectsCount(visibleMyProjects.length, myProjects.length, t)}
                </span>
              </h2>
              {myProjects.length > 5 && (
                <input
                  type="text"
                  className="my-projects-search"
                  placeholder={t("home.myProjects.search.placeholder")}
                  aria-label={t("home.myProjects.search.placeholder")}
                  value={projectSearch}
                  onChange={(e) => setProjectSearch(e.target.value)}
                />
              )}
              {myProjects.length > 1 && (
                <div className="my-projects-sort view-toggle">
                  <button
                    type="button"
                    className={projectSortMode === "recent" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                    onClick={() => handleSetProjectSortMode("recent")}
                  >
                    {t("home.myProjects.sort.recent")}
                  </button>
                  <button
                    type="button"
                    className={projectSortMode === "alphabetical" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                    onClick={() => handleSetProjectSortMode("alphabetical")}
                  >
                    {t("home.myProjects.sort.alphabetical")}
                  </button>
                </div>
              )}
              {myProjects.length > 1 && (
                <select
                  className="my-projects-status-filter"
                  aria-label={t("home.myProjects.filter.label")}
                  value={projectStatusFilter}
                  onChange={(e) => handleSetProjectStatusFilter(e.target.value as ProjectStatusFilter)}
                >
                  <option value="all">{t("home.myProjects.filter.all")}</option>
                  <option value="built">{t("home.myProjects.filter.built")}</option>
                  <option value="draft">{t("home.myProjects.filter.draft")}</option>
                </select>
              )}
              {visibleMyProjects.length === 0 ? (
                <p className="muted">{t("home.myProjects.noResults")}</p>
              ) : (
              <>
              {visibleMyProjects.some((p) => p.ownerId === user.id) && (
                <label className="my-projects-select-all">
                  <input
                    type="checkbox"
                    aria-label={t("home.myProjects.bulk.selectAll")}
                    checked={visibleMyProjects
                      .filter((p) => p.ownerId === user.id)
                      .every((p) => selectedProjectIds.has(p.id))}
                    ref={(el) => {
                      if (!el) return;
                      const owned = visibleMyProjects.filter((p) => p.ownerId === user.id);
                      const someSelected = owned.some((p) => selectedProjectIds.has(p.id));
                      const allSelected = owned.length > 0 && owned.every((p) => selectedProjectIds.has(p.id));
                      el.indeterminate = someSelected && !allSelected;
                    }}
                    onChange={toggleSelectAllOwnedProjects}
                  />
                  {t("home.myProjects.bulk.selectAll")}
                </label>
              )}
              {visibleSelectedProjectIds.size > 0 && (
                <div className="bulk-actions-bar">
                  <span>{t("home.myProjects.bulk.selectedCount", { count: visibleSelectedProjectIds.size })}</span>
                  <button type="button" className="danger" onClick={handleBulkDeleteProjects}>
                    {t("home.myProjects.bulk.deleteSelected")}
                  </button>
                </div>
              )}
              <ul className="my-projects-list">
                {visibleMyProjects.map((p) => (
                  <li key={p.id}>
                    <div className="my-project-card">
                      {p.ownerId === user.id && (
                        <input
                          type="checkbox"
                          className="my-project-select"
                          aria-label={t("home.myProjects.bulk.selectRow")}
                          checked={selectedProjectIds.has(p.id)}
                          onChange={() => toggleProjectSelected(p.id)}
                        />
                      )}
                      <button
                        type="button"
                        className={pinnedIds.has(p.id) ? "my-project-pin my-project-pin-active" : "my-project-pin"}
                        aria-label={pinnedIds.has(p.id) ? t("home.myProjects.unpin") : t("home.myProjects.pin")}
                        title={pinnedIds.has(p.id) ? t("home.myProjects.unpin") : t("home.myProjects.pin")}
                        onClick={() => setPinnedIds(togglePinned(p.id))}
                      >
                        {pinnedIds.has(p.id) ? "⭐" : "☆"}
                      </button>
                      <button type="button" className="my-project-open" onClick={() => openExistingProject(p)}>
                        <strong>{p.name}</strong>
                        {p.ownerId !== user.id && <span className="chip">{t("home.myProjects.shared")}</span>}
                        {p.status === "draft" && <span className="chip">{t("home.myProjects.draft")}</span>}
                        <span className="my-project-created muted small">
                          {t("home.myProjects.createdOn", { date: formatProjectCreatedDate(p.createdAt, lang) })}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="secondary my-project-duplicate"
                        disabled={cloningId !== null}
                        onClick={() => handleDuplicateProject(p)}
                      >
                        {cloningId === p.id ? t("home.myProjects.duplicate.busy") : t("home.myProjects.duplicate")}
                      </button>
                      {p.ownerId === user.id && (
                        <button
                          type="button"
                          className="secondary danger my-project-delete"
                          disabled={deletingId !== null}
                          onClick={() => handleDeleteProject(p)}
                        >
                          {deletingId === p.id ? t("home.myProjects.delete.busy") : t("home.myProjects.delete")}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              </>
              )}
            </div>
          )}
          <h1>{t("home.title")}</h1>
          <form onSubmit={handleDescribe}>
            <textarea
              rows={5}
              placeholder={t("home.placeholder")}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                saveIdeaDraft(e.target.value);
              }}
            />
            <button type="submit" disabled={busy || enhanceBusy}>
              {busy ? t("home.submit.busy") : t("home.submit")}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || enhanceBusy || !description.trim()}
              onClick={handleEnhanceAndBuild}
            >
              {enhanceBusy ? t("home.enhance.busy") : t("home.enhance")}
            </button>
            <p className="muted small">{t("home.enhance.hint")}</p>
          </form>

          <div className="idea-examples">
            <h2>{t("home.examples.heading")}</h2>
            <div className="idea-examples-grid">
              {IDEA_EXAMPLES.map((example) => (
                <button
                  type="button"
                  key={example.labelKey}
                  className="idea-example-card"
                  disabled={busy || enhanceBusy}
                  onClick={() => {
                    setDescription(t(example.textKey));
                    saveIdeaDraft(t(example.textKey));
                  }}
                >
                  <span className="idea-example-icon">{example.icon}</span>
                  <span className="idea-example-label">{t(example.labelKey)}</span>
                </button>
              ))}
            </div>
          </div>
        </main>
      )}

      {view === "spec" && project && (
        <main className="spec-review">
          <ProjectNameEditor project={project} onRenamed={setProject} />
          <p className="muted small">{t("spec.title")}</p>
          <p>{project.spec.summary}</p>
          {specProviderLabel(specProvider, t) && (
            <p className={specProvider === "anthropic-fallback" ? "error" : "muted small"}>
              {specProviderLabel(specProvider, t)}
            </p>
          )}

          <section>
            <h2>{t("spec.roles.heading")}</h2>
            <div className="chips">
              {project.spec.roles.map((r, i) => (
                <RoleChip
                  key={`${i}-${r}`}
                  role={r}
                  projectId={project.id}
                  index={i}
                  canRemove={project.spec.roles.length > 1}
                  onRenamed={setProject}
                  onRemoved={setProject}
                />
              ))}
            </div>
            <AddRoleForm projectId={project.id} onAdded={setProject} />
          </section>

          <section>
            <h2>{t("spec.entities.heading")}</h2>
            {project.spec.entities.map((entity) => (
              <EntitySummaryItem
                key={entity.name}
                entity={entity}
                summary={formatEntityFieldSummary(entity.fields)}
                projectId={project.id}
                canRemove={project.spec.entities.length > 1}
                onRenamed={setProject}
                onRemoved={setProject}
              />
            ))}
            {project.spec.entities.some((e) => e.fields.some((f) => f.required)) && (
              <p className="muted small">{t("spec.entities.requiredHint")}</p>
            )}
            <AddEntityForm projectId={project.id} onAdded={setProject} />
          </section>

          <section>
            <h2>{t("spec.assumptions.heading")}</h2>
            <ul>
              {project.spec.assumptions.map((a, i) => (
                <AssumptionItem
                  key={`${i}-${a}`}
                  assumption={a}
                  projectId={project.id}
                  index={i}
                  onRenamed={setProject}
                  onRemoved={setProject}
                />
              ))}
            </ul>
            <AddAssumptionForm projectId={project.id} onAdded={setProject} />
          </section>

          {project.spec.openQuestions.length > 0 && (
            <section>
              <h2>{t("spec.openQuestions.heading")}</h2>
              <p className="muted small">{formatOpenQuestionsProgress(project.spec.openQuestions, selectedAnswers, t)}</p>
              {project.spec.openQuestions.map((q, i) => (
                <div key={i} className="open-question">
                  <p>{q.question}</p>
                  <div className="chips">
                    {q.options.map((opt) => (
                      <button
                        type="button"
                        key={opt}
                        className={selectedAnswers[q.question] === opt ? "chip chip-selected" : "chip chip-button"}
                        onClick={() => setSelectedAnswers((prev) => ({ ...prev, [q.question]: opt }))}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    className="answer-input"
                    placeholder={t("spec.answerInput.placeholder")}
                    value={selectedAnswers[q.question] ?? ""}
                    onChange={(e) => setSelectedAnswers((prev) => ({ ...prev, [q.question]: e.target.value }))}
                  />
                  {q.recommendation && (
                    <p className="muted small">
                      {t("spec.recommendation")}
                      {q.recommendation}
                    </p>
                  )}
                </div>
              ))}
            </section>
          )}

          <section>
            <h2>{t("spec.additionalRequest.heading")}</h2>
            <p className="muted small">{t("spec.additionalRequest.description")}</p>
            <textarea
              rows={3}
              placeholder={t("spec.additionalRequest.placeholder")}
              value={additionalRequest}
              onChange={(e) => setAdditionalRequest(e.target.value)}
            />
          </section>

          <div className="form-actions">
            <button type="button" className="secondary" onClick={handleBackToHome} disabled={busy}>
              {t("spec.back")}
            </button>
            <button type="button" onClick={handleBuild} disabled={busy}>
              {busy ? t("spec.build.busy") : t("spec.build.submit")}
            </button>
          </div>
        </main>
      )}

      {view === "building" && project && (
        <BuildProgress
          title={t("build.title.build")}
          projectName={project.name}
          run={(onEvent) => streamBuild(project.id, onEvent)}
          onComplete={handleBuildComplete}
          onBack={() => setView("spec")}
        />
      )}

      {view === "preview" && project && (
        <main className="preview">
          <div className="preview-header">
            <ProjectNameEditor project={project} onRenamed={setProject} />
            <div className="preview-header-actions">
              <button type="button" className="secondary" onClick={() => openPanel("search")}>
                {t("preview.search")}
                <span className="shortcut-hint">Ctrl+K · /</span>
              </button>
              <button type="button" className="secondary" onClick={() => openPanel("twin")}>
                {t("preview.twin")}
              </button>
              <button type="button" className="secondary" onClick={handleExport} disabled={exportBusy}>
                {exportBusy ? t("preview.export.busy") : exportDone ? t("preview.export.done") : t("preview.export")}
              </button>
              <button type="button" className="secondary" onClick={handleBackup} disabled={backupBusy}>
                {backupBusy ? t("preview.backup.busy") : backupDone ? t("preview.backup.done") : t("preview.backup")}
              </button>
              <button type="button" className="secondary" onClick={() => openPanel("whatsapp")}>
                {t("preview.whatsapp")}
              </button>
              <button type="button" className="secondary" onClick={() => openPanel("collaborators")}>
                {t("preview.collaborators")}
              </button>
              <button type="button" className="secondary" onClick={() => openPanel("history")}>
                {t("preview.history")}
              </button>
              <button type="button" className="secondary" onClick={() => openPanel("shortcuts")}>
                {t("preview.shortcuts")}
                <span className="shortcut-hint">?</span>
              </button>
            </div>
          </div>

          <div className="preview-body">
            <div className="preview-chat-pane">
              {refineRunning ? (
                <BuildProgress
                  compact
                  projectName={project.name}
                  run={(onEvent) => {
                    const wrappedOnEvent = (event: AgentStepEvent) => {
                      refineEvents.current.push(event);
                      onEvent(event);
                    };
                    return streamRefine(project.id, refineText, wrappedOnEvent);
                  }}
                  onComplete={handleBuildComplete}
                  onBack={() => setRefineRunning(false)}
                />
              ) : (
                <form className="refine-box" onSubmit={handleRefine}>
                  <input
                    type="text"
                    placeholder={t("preview.refine.placeholder")}
                    aria-label={t("preview.refine.placeholder")}
                    value={refineText}
                    onChange={(e) => setRefineText(e.target.value)}
                  />
                  <button type="submit" disabled={!refineText.trim()}>
                    {t("preview.refine.submit")}
                  </button>
                </form>
              )}

              {refineHistory.length > 0 && (
                <div className="refine-history">
                  <h2>{t("preview.refineHistory.heading")}</h2>
                  {refineHistory.length > 5 && (
                    <input
                      type="text"
                      className="refine-history-search"
                      placeholder={t("preview.refineHistory.search.placeholder")}
                      aria-label={t("preview.refineHistory.search.placeholder")}
                      value={refineHistorySearch}
                      onChange={(e) => setRefineHistorySearch(e.target.value)}
                    />
                  )}
                  {visibleRefineHistory.length === 0 ? (
                    <p className="muted small">{t("preview.refineHistory.search.noResults")}</p>
                  ) : (
                    <ul className="refine-history-list">
                      {visibleRefineHistory.map((entry) => (
                        <li key={entry.id}>
                          <div className="refine-history-row">
                            <button
                              type="button"
                              className="link-button refine-history-instruction"
                              title={t("preview.refineHistory.reuse.hint")}
                              disabled={refineRunning}
                              onClick={() => handleReuseRefineInstruction(entry.instruction)}
                            >
                              {entry.instruction}
                            </button>
                            <button
                              type="button"
                              className="refine-history-delete"
                              title={t("preview.refineHistory.remove.hint")}
                              aria-label={t("preview.refineHistory.remove.hint")}
                              onClick={() => handleRemoveRefineHistoryEntry(entry.id)}
                            >
                              🗑️
                            </button>
                          </div>
                          <p className="muted small">{entry.summary}</p>
                          <p className="refine-history-time muted small">{formatRefineTimestamp(entry.completedAt, lang)}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <div className="preview-live-pane">
              <nav className="entity-tabs">
                {orderedEntities.map((entity) => (
                  <button
                    key={entity.name}
                    className={
                      activeEntity === entity.name
                        ? "tab tab-active"
                        : dragOverEntityTab === entity.name
                          ? "tab tab-drag-over"
                          : "tab"
                    }
                    draggable
                    onDragStart={() => setDraggedEntityTab(entity.name)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverEntityTab(entity.name);
                    }}
                    onDragLeave={() => setDragOverEntityTab((prev) => (prev === entity.name ? null : prev))}
                    onDrop={(e) => {
                      e.preventDefault();
                      handleReorderEntityTab(entity.name);
                    }}
                    onClick={() => setActiveEntity(entity.name)}
                  >
                    {entity.label ?? entity.name}
                  </button>
                ))}
              </nav>
              {project.spec.entities
                .filter((e) => e.name === activeEntity)
                .map((entity) => (
                  <EntityPanel
                    key={entity.name}
                    projectId={project.id}
                    entity={entity}
                    allEntities={project.spec.entities}
                    onEntityRenamed={setProject}
                    highlightRecordId={highlightRecordId}
                    onHighlightHandled={() => setHighlightRecordId(null)}
                    onJumpToRecord={(targetEntity, recordId) => {
                      setActiveEntity(targetEntity);
                      setHighlightRecordId(recordId);
                    }}
                  />
                ))}
            </div>
          </div>

          {showHistory && (
            <HistoryPanel
              projectId={project.id}
              projectName={project.name}
              currentSpec={project.spec}
              onClose={() => setShowHistory(false)}
              onRestored={(restored) => {
                setProject(restored);
                setActiveEntity(restored.spec.entities[0]?.name ?? null);
                setShowHistory(false);
              }}
            />
          )}

          {showTwin && (
            <BusinessTwinPanel
              projectId={project.id}
              projectName={project.name}
              onClose={() => setShowTwin(false)}
              onJumpToEntity={(entityName) => {
                setActiveEntity(entityName);
                setShowTwin(false);
              }}
              onJumpToRecord={(entityName, recordId) => {
                setActiveEntity(entityName);
                setHighlightRecordId(recordId);
                setShowTwin(false);
              }}
            />
          )}

          {showWhatsApp && (
            <WhatsAppPanel
              projectId={project.id}
              projectName={project.name}
              onClose={() => setShowWhatsApp(false)}
              onJumpToEntity={(entityName) => {
                setActiveEntity(entityName);
                setShowWhatsApp(false);
              }}
              onJumpToRecord={(entityName, recordId) => {
                setActiveEntity(entityName);
                setHighlightRecordId(recordId);
                setShowWhatsApp(false);
              }}
            />
          )}

          {showCollaborators && (
            <CollaboratorsPanel
              projectId={project.id}
              isOwner={user?.id === project.ownerId}
              currentUserId={user?.id}
              onClose={() => setShowCollaborators(false)}
              onLeft={() => {
                setShowCollaborators(false);
                handleGoHome();
              }}
            />
          )}

          {showSearch && (
            <GlobalSearchPanel
              projectId={project.id}
              projectName={project.name}
              entities={project.spec.entities}
              onClose={() => setShowSearch(false)}
              onJumpToEntity={(entityName) => {
                setActiveEntity(entityName);
                setShowSearch(false);
              }}
              onJumpToRecord={(entityName, recordId) => {
                setActiveEntity(entityName);
                setHighlightRecordId(recordId);
                setShowSearch(false);
              }}
            />
          )}

          {showShortcuts && <ShortcutsPanel onClose={() => setShowShortcuts(false)} />}
        </main>
      )}
    </div>
  );
}
