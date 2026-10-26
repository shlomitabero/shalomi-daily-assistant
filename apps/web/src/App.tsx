import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentStepEvent, Field, OpenQuestion, Project, User } from "@forge/shared";
import {
  answerQuestions,
  backupProject,
  clearToken,
  cloneProject,
  createProject,
  createProjectFromTemplate,
  deleteProject,
  enhanceIdea,
  exportProject,
  getEntityCounts,
  getToken,
  getWhatsAppStatus,
  listAutomationRules,
  listCollaborators,
  listProjects,
  listTemplates,
  listWhatsAppMessages,
  logout,
  me,
  streamBuild,
  streamRefine,
  subscribeAuthExpired,
  subscribeProjectGone,
  subscribeViewerDemoted,
  subscribeWakeStatus,
  type CollaboratorRole,
  type TemplateSummary,
  type WhatsAppMessageLogEntry,
} from "./api.js";
import { AuthScreen } from "./AuthScreen.js";
import { BuildProgress } from "./BuildProgress.js";
import { BusinessTwinPanel } from "./BusinessTwinPanel.js";
import { EntityPanel } from "./EntityPanel.js";
import { GlobalSearchPanel } from "./GlobalSearchPanel.js";
import { HistoryPanel } from "./HistoryPanel.js";
import { WhatsAppPanel } from "./WhatsAppPanel.js";
import { AutomationsPanel } from "./AutomationsPanel.js";
import { CollaboratorsPanel } from "./CollaboratorsPanel.js";
import { ChangePasswordPanel } from "./ChangePasswordPanel.js";
import { DeleteAccountPanel } from "./DeleteAccountPanel.js";
import { ProjectNameEditor } from "./ProjectNameEditor.js";
import { ProjectDescriptionEditor } from "./ProjectDescriptionEditor.js";
import { ShortcutsPanel } from "./ShortcutsPanel.js";
import { isAnyDialogOpen } from "./useDialogFocusTrap.js";
import {
  AddAssumptionForm,
  AddEntityForm,
  AddPersonaForm,
  AddRoleForm,
  AssumptionItem,
  EntitySummaryItem,
  PersonaItem,
  RoleChip,
} from "./SpecListItemRemover.js";
import { applyColumnOrder, getColumnOrder, reorderColumns } from "./columnOrder.js";
import { getEntityTabOrder, setEntityTabOrder } from "./entityTabOrder.js";
import { getPinnedIds, sortByPinned, togglePinned } from "./pinnedProjects.js";
import { getSeenSharedTimestamps, markSharedProjectSeen, isNewShare } from "./sharedProjectSeen.js";
import { purgeProjectPreferences } from "./projectPreferenceCleanup.js";
import { purgeEntityPreferences } from "./entityPreferenceCleanup.js";
import {
  addRecentProjectSearch,
  clearRecentProjectSearches,
  getRecentProjectSearches,
  removeRecentProjectSearch,
} from "./recentProjectSearches.js";
import { visibleSelectedIds } from "./projectSelection.js";
import { getProjectSortMode, setProjectSortMode, type ProjectSortMode } from "./projectSortMode.js";
import {
  getProjectStatusFilter,
  setProjectStatusFilter as persistProjectStatusFilter,
  type ProjectStatusFilter,
} from "./projectStatusFilter.js";
import { clearIdeaDraft, getIdeaDraft, saveIdeaDraft } from "./ideaDraft.js";
import { formatDocumentTitle } from "./documentTitle.js";
import { countUnreadWhatsAppMessages, getWhatsAppLastSeen } from "./whatsappUnread.js";
import { findNewInboundMessages, type LastNotifiedWhatsAppMessage } from "./whatsappNotify.js";
import { LanguageProvider, useTranslation } from "./i18n/LanguageContext.js";
import { LanguageSwitcher } from "./i18n/LanguageSwitcher.js";
import type { Lang } from "./i18n/language.js";
import { ThemeProvider } from "./theme/ThemeContext.js";
import { ThemeSwitcher } from "./theme/ThemeSwitcher.js";

type View = "home" | "spec" | "building" | "preview";

const LOCALE: Record<string, string> = { he: "he-IL", en: "en-US" };

/** How often the topbar's own WhatsApp unread-badge poll checks for new messages -- lighter than WhatsAppPanel's own 10s CONNECTED_POLL_INTERVAL_MS since this runs for every built project, not just while its panel happens to be open. */
const WHATSAPP_UNREAD_POLL_INTERVAL_MS = 20000;
/** How often the topbar's own failing-automations badge poll re-checks rule status. Slightly longer than WHATSAPP_UNREAD_POLL_INTERVAL_MS since a rule's lastStatus only changes when it actually fires (schedule/webhook/field-change), not on every incoming message. */
const AUTOMATIONS_FAILING_POLL_INTERVAL_MS = 30000;
/** How often a non-owner's own myRole poll re-checks their real collaborator role. Longer than the other two polls above since a role change is rarer than either an incoming message or a firing automation rule. */
const MY_ROLE_POLL_INTERVAL_MS = 45000;

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

/** Same shape as specProviderLabel, for the separate enhance-step provider signal (enhanceProvider). */
export function enhanceProviderLabel(providerName: string | null, t: (key: string) => string): string | null {
  if (providerName === null) return null;
  if (providerName === "anthropic") return t("enhance.provider.ai");
  if (providerName === "anthropic-fallback") return t("enhance.provider.aiFallback");
  return t("enhance.provider.heuristic");
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
  providerName: string | null;
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
  changedEntities: { name: string; label: string; newFieldNames: string[]; removedFieldNames?: string[]; tightenedFieldNames?: string[] }[];
  removedEntities?: { name: string; label: string }[];
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
 * selectedAnswers[index] slot (see the spec-review view below), so an
 * answer is just a non-blank value there, regardless of which control set
 * it. Backs the "answered N of M" progress line, so a person with a long
 * list of open questions doesn't have to scroll and count for themselves
 * whether they've addressed everything before clicking build.
 *
 * Keyed by each question's own array INDEX, not its `question` text --
 * OpenQuestionSchema carries no uniqueness constraint on `question` (unlike
 * entity names, which get a real collision check), and the AI provider has
 * no reason to avoid asking two unrelated questions with identical wording
 * (e.g. two different features each prompting "Should notifications be
 * sent via email or SMS?"). Keying by text would have let the second such
 * question's chip silently read as pre-answered the moment the first one
 * was touched, and both would count toward "answered" from a single click.
 */
export function countAnsweredOpenQuestions(
  openQuestions: OpenQuestion[],
  selectedAnswers: Record<string, string>,
): { answered: number; total: number } {
  const answered = openQuestions.filter((_, i) => (selectedAnswers[String(i)] ?? "").trim().length > 0).length;
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
    if (e.newFieldNames.length > 0) {
      parts.push(`${e.label}${t("build.detail.architect.gainedFields")}${e.newFieldNames.join(", ")}`);
    }
    if ((e.removedFieldNames ?? []).length > 0) {
      parts.push(`${e.label} ${t("build.detail.architect.lostFields")}${(e.removedFieldNames ?? []).join(", ")}`);
    }
    if ((e.tightenedFieldNames ?? []).length > 0) {
      parts.push(`${e.label} ${t("build.detail.architect.tightenedFields")}${(e.tightenedFieldNames ?? []).join(", ")}`);
    }
  }
  for (const e of detail.removedEntities ?? []) {
    parts.push(`${e.label} ${t("build.detail.architect.entityRemoved")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : t("preview.refineHistory.noChange");
}

/**
 * Pulls the AI-vs-heuristic provider signal (pipeline.ts's own
 * PipelineOptions.providerName) back out of a completed refine's raw event
 * list. Unlike summarizeRefineImpact above, this reads the very first event
 * (always `{agent: "Architect", status: "running"}`, emitted exactly once
 * per pipeline run) rather than the last "success" one -- a Debug-recovered
 * refine re-emits a second Architect success event, but never a second
 * "running" one, so there's nothing to disambiguate here. Round 402 closed
 * this exact gap (generateSpec()'s honest signal silently discarded) for
 * the enhance step; /refine calls the identical generateSpec() and had the
 * identical gap, just with no render location of its own before now.
 */
export function extractRefineProviderName(events: AgentStepEvent[]): string | null {
  const first = events.find((e) => e.agent === "Architect" && e.status === "running");
  const detail = first?.detail as { providerName?: string } | undefined;
  return detail?.providerName ?? null;
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

/**
 * The topbar's brand-logo "go home" link was already deliberately
 * unclickable during a full-page build (view === "building") -- its own
 * comment reasons BuildProgress's design only ever offers a way out on
 * failure, and this link shouldn't silently disagree by giving a second,
 * unguarded exit. That reasoning applies equally to a refine's own
 * COMPACT BuildProgress, rendered inline on the "preview" view while
 * refineRunning is true -- but the condition never checked refineRunning,
 * so the logo stayed clickable throughout an active refine. Clicking it
 * (handleGoHome) wipes `project` and swaps the view away, unmounting that
 * compact BuildProgress while its streamRefine() request is still in
 * flight -- the exact silent, unguarded exit the "building" check was
 * written to prevent, just reached from a different view.
 */
export function canNavigateHome(view: "home" | "spec" | "building" | "preview", refineRunning: boolean): boolean {
  return view !== "home" && view !== "building" && !refineRunning;
}

/**
 * A real OS-level alert for a WhatsApp message that arrives while the tab
 * is backgrounded -- the topbar unread badge (round 288/289) is invisible
 * then, which is exactly the moment a live WhatsApp channel most needs one.
 * Pulled out of the unread-poll effect below as its own exported function
 * (rather than inline in the effect) so its actual decision-and-fire logic
 * -- not just findNewInboundMessages' own pure comparison -- has a real
 * regression test, the same "extract the impure glue too, not just the
 * pure helper underneath it" lesson round 292's commitPendingDelete fix
 * established.
 *
 * `lastNotifiedIdRef` is always updated to the newest message's id,
 * whether or not a notification actually fires -- once the tab is
 * focused when new messages arrive, the topbar badge already shows them,
 * so no notification should fire retroactively once the tab is later
 * backgrounded for messages the user has already effectively seen arrive.
 */
export function maybeNotifyNewWhatsAppMessages(
  messages: WhatsAppMessageLogEntry[],
  lastNotifiedIdRef: { current: LastNotifiedWhatsAppMessage | null },
  isTabHidden: boolean,
  t: (key: string, params?: Record<string, string>) => string,
): void {
  const newMessages = findNewInboundMessages(messages, lastNotifiedIdRef.current);
  lastNotifiedIdRef.current = messages[0] ? { id: messages[0].id, createdAt: messages[0].createdAt } : lastNotifiedIdRef.current;
  if (!newMessages || !isTabHidden) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const title =
    newMessages.count === 1
      ? t("whatsapp.notification.title.one", { from: newMessages.matchedLabel ?? newMessages.fromNumber })
      : t("whatsapp.notification.title.many", { count: String(newMessages.count) });
  new Notification(title, { body: newMessages.snippet });
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
  // The signed-in user's own standing on the currently open project: the
  // owner is always "owner" (never a row in project_collaborators at all --
  // see collaborators.ts's own comment), and a collaborator is either
  // "editor" (full access, the original behavior) or "viewer" (read-only,
  // enforced server-side by requireProjectWriteAccess -- this is only the
  // UI-layer reflection of that, via the readOnly props threaded into
  // EntityPanel/AutomationsPanel/WhatsAppPanel/HistoryPanel/the editors
  // below). Set in openExistingProject (and every project-creation path,
  // which always makes the creator the owner); never recomputed afterwards
  // for the project already open, since nothing in this session can change
  // the signed-in user's own role on it.
  const [myRole, setMyRole] = useState<"owner" | CollaboratorRole>("owner");
  // Which spec provider actually built the CURRENT draft's spec -- null for
  // a re-opened existing project (createProject's own response is the only
  // source of this, and it isn't stored on the project itself, so there's
  // nothing honest to show once you've navigated away and come back).
  const [specProvider, setSpecProvider] = useState<string | null>(null);
  // Same honest-signal shape as specProvider above, but for the separate
  // "✨ Enhance & build" idea-rewrite step (enhanceIdea), which has its own
  // independent AI-or-heuristic provider seam -- previously discarded
  // entirely (handleEnhanceAndBuild only ever destructured `{ enhanced }`),
  // so a real AI failure during the rewrite degraded silently into the
  // crude keyword-matched rewrite with no signal at all, the same gap
  // specProvider itself used to have for the build step. null whenever the
  // current draft wasn't created via that enhance step at all.
  const [enhanceProvider, setEnhanceProvider] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enhanceBusy, setEnhanceBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeEntity, setActiveEntity] = useState<string | null>(null);
  // One cheap COUNT(*) per entity, shown as a badge on each entity tab --
  // keyed by entity name so switching tabs never needs to re-fetch. Fetched
  // once per built project; the active tab's own count is then kept live
  // via EntityPanel's onRecordCountChange (every mutation it makes already
  // funnels through its own `records` state).
  const [entityCounts, setEntityCounts] = useState<Record<string, number>>({});
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
  const [showAutomations, setShowAutomations] = useState(false);
  // Mirrors showWhatsApp for checkUnread's closure below (round 560) --
  // read inside the poll's own interval tick without putting showWhatsApp
  // in that effect's dependency array, which would otherwise restart the
  // whole poll (and its WHATSAPP_UNREAD_POLL_INTERVAL_MS timer) every time
  // the panel opens or closes.
  const showWhatsAppRef = useRef(showWhatsApp);
  useEffect(() => {
    showWhatsAppRef.current = showWhatsApp;
  }, [showWhatsApp]);
  // Same idiom as showWhatsAppRef just above, for the same reason: useTranslation()
  // returns a brand-new `t` closure (bound to the then-current `lang`) on every
  // language change, but checkUnread's closure below is only re-created when the
  // poll effect itself re-runs (project?.id/project?.status) -- so without this ref,
  // a desktop notification fired after a mid-session language switch (same project,
  // tab backgrounded, a new WhatsApp message arrives) rendered its title in whatever
  // language was active when the poll last (re)started, not the current one.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  // Set alongside openPanel("whatsapp") by EntityPanel's "Send WhatsApp" row
  // action, so the panel opens with that record's number already in the
  // test-send box instead of the user having to copy/paste it themselves.
  const [whatsappPrefillTo, setWhatsappPrefillTo] = useState<string | null>(null);
  // Round 921: set by WhatsAppPanel's own "Create new record from this
  // message" button (an unmatched inbound message -- a brand-new contact --
  // had no path at all to becoming a record), carried through to the single
  // EntityPanel mount below as its createPrefill prop, the same way
  // highlightRecordId is carried through for "jump to record".
  const [createPrefill, setCreatePrefill] = useState<{ fieldName: string; value: string } | null>(null);
  const [whatsappUnreadCount, setWhatsappUnreadCount] = useState(0);
  // Count of enabled automation rules whose lastStatus is "failed" -- a
  // standing problem (webhook endpoint down, WhatsApp disconnected, a stale
  // toField after a refine), not an accumulating stream like WhatsApp
  // messages, so unlike whatsappUnreadCount this has no "last seen" marker
  // and no suppress-while-panel-open logic: it just tracks live server
  // truth, and drops back to 0 on its own once every failing rule actually
  // starts succeeding again or is fixed/disabled.
  const [automationsFailingCount, setAutomationsFailingCount] = useState(0);
  // The newest inbound WhatsApp message id a desktop notification has
  // already been shown for -- separate from the topbar badge's own "last
  // seen" marker (whatsappUnread.ts), which only moves when the panel is
  // actually opened and can stay stale for a long time. See the unread-poll
  // effect below for why this needs its own tracking.
  const lastNotifiedWhatsAppIdRef = useRef<LastNotifiedWhatsAppMessage | null>(null);
  // Every existing purgeProjectPreferences call site (handleDeleteProject,
  // handleBulkDeleteProjects, handleAccountDeleted, CollaboratorsPanel's
  // onLeft) is an action THIS browser just performed, so it can purge
  // synchronously right after. A project vanishing because a DIFFERENT
  // user (the owner) removed THIS browser's own account as a collaborator
  // has no such moment -- there's no websocket/push, so the only place
  // this browser ever learns about it is the next time this effect below
  // re-fetches the list and the id is simply gone from the response.
  // Tracking the ids this effect has already seen lets it notice exactly
  // that disappearance and purge for it too, the same way the other four
  // call sites already do for every other way a project becomes
  // permanently unreachable from this browser.
  const myProjectIdsRef = useRef<Set<string>>(new Set());
  const [showCollaborators, setShowCollaborators] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [myProjects, setMyProjects] = useState<Project[]>([]);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [templateBusy, setTemplateBusy] = useState<string | null>(null);
  // Round 1003: this used to lazy-init via getPinnedIds() with no userId at
  // all -- `user` is still null at this exact first-render moment (the
  // async session-check effect just below hasn't resolved yet), so there
  // was never a real user id available here anyway. Starts empty and gets
  // properly populated, scoped to the real signed-in user's own id, inside
  // that same session-check effect the moment `user` becomes known -- see
  // its own updated comment there, mirroring seenShared's own identical
  // round-995 fix just below.
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  // Round 995: this used to lazy-init via getSeenSharedTimestamps() with no
  // userId at all -- `user` is still null at this exact first-render
  // moment (the async session-check effect just below hasn't resolved
  // yet), so there was never a real user id available here anyway. Starts
  // empty and gets properly populated, scoped to the real signed-in
  // user's own id, inside that same session-check effect the moment
  // `user` becomes known -- see its own updated comment there. The home
  // screen that actually reads this (isNewShare, below) never renders
  // before that resolves, gated by `checkingSession`.
  const [seenShared, setSeenShared] = useState<Map<string, string>>(new Map());
  const [projectSortMode, setProjectSortModeState] = useState<ProjectSortMode>(() => getProjectSortMode());
  const [projectSearch, setProjectSearch] = useState("");
  const [recentProjectSearches, setRecentProjectSearches] = useState<string[]>(() => getRecentProjectSearches());
  const [projectStatusFilter, setProjectStatusFilterState] = useState<ProjectStatusFilter>(() => getProjectStatusFilter());
  const [cloningId, setCloningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Mirrors cloningId/deletingId's own busy-guard idiom for the single-row
  // actions right below -- without it, "Delete Selected" has nothing
  // disabling it (or itself) for the whole Promise.allSettled round trip,
  // so a second click before the first batch resolves starts a second,
  // fully independent deletion of the exact same already-selected ids. The
  // first batch's requests succeed; the second batch's requests each hit a
  // 404 (row already gone) or 409 PIPELINE_IN_PROGRESS server-side, so
  // Promise.allSettled sees every one of them rejected and reports the
  // bulk delete as having failed -- even though every project was, in
  // fact, already deleted by the winning first batch (round 543).
  const [bulkDeleteBusy, setBulkDeleteBusy] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [refineHistory, setRefineHistory] = useState<RefineHistoryEntry[]>([]);
  const [refineHistorySearch, setRefineHistorySearch] = useState("");
  const [refineRunning, setRefineRunning] = useState(false);
  // Set from BuildProgress's onComplete when a build/refine genuinely
  // completed but some earlier agent step's latest event is still "failed"
  // (e.g. Seed Data hit a real error that didn't stop the build). That
  // screen unmounts in the same tick it fires, so this is the only place
  // left that can ever show it.
  const [buildWarning, setBuildWarning] = useState<string | null>(null);
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

  /**
   * handleReorderEntityTab above is drag-and-drop only -- the same
   * keyboard-accessibility gap round 478 already closed for table columns
   * (EntityPanel.tsx's own handleMoveColumn) by adding "move earlier"/"move
   * later" buttons next to each column header. This mirrors that fix for
   * the entity-tab bar, reusing the identical reorderColumns primitive, so
   * a keyboard-only or screen-reader user gets the same tab-reordering
   * access a mouse-drag user already has.
   */
  function handleMoveEntityTab(entityName: string, direction: "earlier" | "later") {
    if (!project) return;
    const index = orderedEntities.findIndex((e) => e.name === entityName);
    if (index === -1) return;
    const neighborIndex = direction === "earlier" ? index - 1 : index + 1;
    if (neighborIndex < 0 || neighborIndex >= orderedEntities.length) return;
    const neighborName = orderedEntities[neighborIndex].name;
    const fullOrder = orderedEntities.map((e) => e.name);
    const next =
      direction === "earlier" ? reorderColumns(fullOrder, entityName, neighborName) : reorderColumns(fullOrder, neighborName, entityName);
    setEntityTabOrderState(setEntityTabOrder(project.id, next));
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
  function handleProjectSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && projectSearch.trim()) {
      setRecentProjectSearches(addRecentProjectSearch(projectSearch));
    }
  }
  function handleRecentProjectSearchClick(query: string) {
    setProjectSearch(query);
  }
  function handleRemoveRecentProjectSearch(query: string) {
    setRecentProjectSearches(removeRecentProjectSearch(query));
  }
  function handleClearRecentProjectSearches() {
    clearRecentProjectSearches();
    setRecentProjectSearches([]);
  }
  const visibleRefineHistory = useMemo(
    () => filterRefineHistory(refineHistory, refineHistorySearch),
    [refineHistory, refineHistorySearch],
  );

  useEffect(() => subscribeWakeStatus(setWaking), []);

  /**
   * Round 928: every one of the 7 overlay panels is rendered only inside
   * `view === "preview" && project && (...)` below -- so when `project`
   * gets nulled out (handleGoHome, or the subscribeProjectGone/
   * subscribeAuthExpired effects further down) while a panel's own
   * show* boolean is still true, the panel just unmounts along with the
   * rest of the preview, with nothing having ever reset that boolean back
   * to false. The next project opened (openExistingProject touches none
   * of these either) re-enters `view === "preview"` with that same stale
   * boolean still true, popping that panel open again, unprompted, for a
   * completely unrelated project -- carrying over whatsappPrefillTo/
   * highlightRecordId/createPrefill too if either was staged (e.g. a
   * phone number from a "Send WhatsApp" row action on the project the
   * viewer just lost access to). Every one of these flags is otherwise
   * only ever cleared by a panel's own onClose, onJumpTo*, or onLeft
   * callback, which never runs when the panel is torn down by project/view
   * changing out from under it instead of a user actually closing it.
   */
  function closeAllPanels() {
    setShowHistory(false);
    setShowTwin(false);
    setShowWhatsApp(false);
    setShowAutomations(false);
    setShowCollaborators(false);
    setShowSearch(false);
    setShowShortcuts(false);
    setWhatsappPrefillTo(null);
    setHighlightRecordId(null);
    setCreatePrefill(null);
  }

  /**
   * The seven overlay panels (History, Business Twin, WhatsApp,
   * Automations, Collaborators, Search, Shortcuts) are each a full-screen backdrop (see
   * "history-overlay" in styles.css) -- opening one without closing the
   * others (e.g. Ctrl+K for search while History is already open from a
   * toolbar click) used to stack two of them at once instead of replacing
   * one with the other, since each "open" button only ever set its own
   * boolean to true and never touched the rest. Routes every open through
   * here so opening any one panel always closes the rest first.
   */
  function openPanel(panel: "history" | "twin" | "whatsapp" | "automations" | "collaborators" | "search" | "shortcuts") {
    setShowHistory(panel === "history");
    setShowTwin(panel === "twin");
    setShowWhatsApp(panel === "whatsapp");
    setShowAutomations(panel === "automations");
    setShowCollaborators(panel === "collaborators");
    setShowSearch(panel === "search");
    setShowShortcuts(panel === "shortcuts");
    // Opening the WhatsApp panel is itself "marking read" from the user's
    // point of view -- she's about to see every message right now. Zeroing
    // this immediately (rather than waiting for the next background poll
    // tick below) avoids a stale badge count flashing for a few seconds
    // after she's already looking at the log. WhatsAppPanel's own effect
    // then keeps the real "last seen" marker in storage in sync as it loads.
    if (panel === "whatsapp") setWhatsappUnreadCount(0);
  }

  /**
   * A real, visible unread-message signal on the topbar's own WhatsApp
   * button -- previously the only way to know a new WhatsApp message had
   * arrived was to open the panel and look (round 288 made the panel
   * itself live-update once open, but gave no signal at all while it was
   * closed, which is most of the time). Runs independently of
   * WhatsAppPanel (which unmounts entirely when the panel is closed, see
   * `{showWhatsApp && <WhatsAppPanel .../>}` below) so the badge keeps
   * updating even with the panel shut. Checks the connection status first
   * and only fetches the message list -- and only keeps polling -- while
   * actually connected, so a project that never connected WhatsApp (the
   * common case) costs nothing beyond one cheap status check.
   *
   * Being independent of WhatsAppPanel cuts both ways (round 560): this
   * poll and WhatsAppPanel's own poll run on separate, unsynchronized
   * schedules, so a tick landing between a new message arriving and
   * WhatsAppPanel's own poll updating the "last seen" marker would count
   * that message as unread and flash a stale nonzero badge next to a
   * message the user is already looking at live in the open panel --
   * openPanel("whatsapp") only zeroes the badge once, at the moment the
   * panel opens, with nothing to re-suppress it afterward. checkUnread
   * reads showWhatsAppRef.current to force the badge to 0 whenever the
   * panel is currently open, instead of trusting the possibly-still-stale
   * last-seen marker.
   */
  useEffect(() => {
    if (!project || project.status !== "built") {
      setWhatsappUnreadCount(0);
      return;
    }
    const projectId = project.id;
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    // A fresh baseline per project/reconnect -- see findNewInboundMessages'
    // own doc comment for why a null baseline must never fire a desktop
    // notification for a customer's entire pre-existing message history.
    lastNotifiedWhatsAppIdRef.current = null;

    async function checkUnread() {
      try {
        const status = await getWhatsAppStatus(projectId);
        if (cancelled) return;
        if (status.status !== "connected") {
          setWhatsappUnreadCount(0);
          return;
        }
        const { messages } = await listWhatsAppMessages(projectId);
        if (cancelled) return;
        setWhatsappUnreadCount(
          showWhatsAppRef.current ? 0 : countUnreadWhatsAppMessages(messages, getWhatsAppLastSeen(projectId)),
        );
        maybeNotifyNewWhatsAppMessages(messages, lastNotifiedWhatsAppIdRef, document.hidden, tRef.current);
      } catch {
        // A single failed background check isn't worth surfacing to the
        // user -- just skip this tick and try again on the next one.
      }
    }

    checkUnread();
    intervalId = setInterval(checkUnread, WHATSAPP_UNREAD_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [project?.id, project?.status]);

  /**
   * Mirrors the WhatsApp unread-badge poll just above, so that a rule
   * failing silently in the background (webhook endpoint down, WhatsApp
   * disconnected, a stale toField after a refine) surfaces the same way an
   * unread WhatsApp message does -- without the user having to remember to
   * open "⚡ Automations" and read each rule's own "last run" line one by
   * one. listAutomationRules already returns every rule's lastStatus.
   */
  useEffect(() => {
    if (!project || project.status !== "built") {
      setAutomationsFailingCount(0);
      return;
    }
    const projectId = project.id;
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    async function checkFailingAutomations() {
      try {
        const { rules } = await listAutomationRules(projectId);
        if (cancelled) return;
        setAutomationsFailingCount(rules.filter((r) => r.enabled && r.lastStatus === "failed").length);
      } catch {
        // A single failed background check isn't worth surfacing to the
        // user -- just skip this tick and try again on the next one.
      }
    }

    checkFailingAutomations();
    intervalId = setInterval(checkFailingAutomations, AUTOMATIONS_FAILING_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [project?.id, project?.status]);

  /**
   * Ctrl/Cmd+K opens global search from anywhere in the preview screen (a
   * command-palette convention users already know from other tools). Only
   * active in the preview view so it can't fire while filling in the
   * home-screen idea textarea or the spec-review form.
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
   *
   * Escape-to-close used to live here too, enumerating six of this app's
   * eight overlay dialogs by hand (History, Business Twin, WhatsApp,
   * Collaborators, Global Search, Shortcuts) -- ChangePassword and
   * DeleteAccount were missing from that list entirely, and this whole
   * handler only runs while `view === "preview"`, while both of those two
   * are reachable from every view via the topbar. Moved into
   * useDialogFocusTrap.ts (round 290) so every dialog built on that shared
   * hook gets Escape uniformly, with no separate list to keep in sync here.
   *
   * isAnyDialogOpen() guards opening a SECOND dialog on top of
   * ChangePassword/DeleteAccount specifically (round 366): openPanel()
   * itself is already mutually exclusive among its own six panels, so
   * Ctrl+K/"/"/"?" swapping between THOSE is intentional, expected UX --
   * but ChangePassword and DeleteAccount aren't routed through openPanel
   * at all (opened directly via their own topbar buttons, independent of
   * `view`), so nothing previously stopped Ctrl+K or "?" from stacking
   * GlobalSearchPanel or ShortcutsPanel on top of an open delete-account
   * confirmation -- two simultaneous focus traps fighting over the same
   * Tab cycle and background inert state. Reusing the same counter round
   * 365 added (rather than hand-checking showChangePassword/
   * showDeleteAccount here) avoids exactly the "a list to keep in sync"
   * trap this comment already warned about above for Escape.
   */
  useEffect(() => {
    if (view !== "preview") return;
    function handleKeyDown(e: KeyboardEvent) {
      if (isAnyDialogOpen()) return;
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
   * Round 1018: pinnedIds/seenShared's own lazy init (above) couldn't know
   * the real signed-in user's own id yet -- this used to load their real,
   * per-user content inline inside the mount-only session-restore effect
   * just above, the moment `me()` resolved. But `user` can ALSO become
   * non-null a second way that effect never covers: AuthScreen's own
   * onAuthenticated prop (wired below to a bare `setUser`) for a fresh
   * login/signup, or a re-login right after subscribeAuthExpired reacted
   * to an expired/revoked session by forcing `user` back to null -- both
   * genuinely ordinary flows, not edge cases, and neither reloads the page
   * or re-invokes this effect (it only ever runs once, on mount). Without
   * this, pinnedIds/seenShared stayed stuck at their initial empty values
   * through a same-tab re-login: a previously-pinned project's star
   * rendered unfilled, and clicking it to "re-pin" what the user sees as
   * unpinned actually called togglePinned against the REAL stored ids
   * (not this stale state) and silently UNPINNED it instead -- genuine,
   * silent loss of a real saved preference, not just a cosmetic stale
   * render. Keyed on user?.id (not the mount-only effect's own one-shot
   * `[]`) so it re-populates every time the signed-in user actually
   * changes, covering both paths uniformly -- including the original
   * mount-time restore, which also goes through this the moment the
   * effect above calls setUser.
   */
  useEffect(() => {
    if (!user) return;
    setPinnedIds(getPinnedIds(user.id));
    setSeenShared(getSeenSharedTimestamps(user.id));
  }, [user?.id]);

  /**
   * Forces a sign-out (back to the login screen) the moment ANY request
   * reports the session is gone -- a 401 SESSION_EXPIRED/AUTH_REQUIRED
   * (e.g. the token expired, or was revoked from another tab/device via
   * "sign out everywhere" or a password change) previously only ever
   * surfaced as that one request's own translated inline error text,
   * wherever it happened to be made from. `user` stayed set and the rest
   * of the authenticated UI kept rendering with a now-useless stored
   * token, leaving the person stuck until they happened to notice and
   * manually hit Logout. Mirrors handleAccountDeleted's own
   * clearToken+reset-to-home sequence below, just reactively instead of
   * after a specific user action, and without a redundant server call
   * (the session is already gone server-side) -- plus one reset neither
   * handleLogout nor handleAccountDeleted needs: whatsappPrefillTo. Both
   * of those only ever run from a Logout/Delete-account button click, and
   * useDialogFocusTrap's own inert-background guard already makes every
   * such button unreachable while WhatsAppPanel is open, so by the time
   * either handler runs, WhatsAppPanel's own onClose/onJumpTo* callbacks
   * have already cleared this. This effect is the one path that forces the
   * same sign-out from an async 401 instead of a click, so it's the one
   * way to land back on the login screen with any of the 7 overlay panels
   * still mounted and their own state never cleared -- surfacing on the
   * next login, in the same tab, as a stale panel (and, for WhatsApp, a
   * stale phone number silently pre-filled into its "To" field) from a
   * completely unrelated prior session. Round 928: originally this only
   * reset whatsappPrefillTo, reasoning (correctly, for handleLogout/
   * handleAccountDeleted's OWN resets) that the focus-trap guard above
   * makes those two button-driven paths unreachable while a panel is
   * open -- but this effect is itself the one path that fires reactively,
   * bypassing any click or focus trap, so it needed the full
   * closeAllPanels() reset the other two never did.
   */
  useEffect(() => {
    return subscribeAuthExpired(() => {
      clearToken();
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
      // Round 993: see handleLogout's own identical reset for why this
      // must be cleared here too -- this effect is the one path that
      // signs a user out reactively (an expired/revoked session), so it
      // needs the same reset handleLogout/handleAccountDeleted apply on
      // their own button-driven paths.
      clearRecentProjectSearches();
      setRecentProjectSearches([]);
      closeAllPanels();
    });
  }, []);

  /**
   * Mirrors the subscribeAuthExpired effect just above, for a narrower
   * event: the currently-open project itself is gone (deleted, or this
   * account's own collaborator access to it was just revoked -- the exact
   * same "no access to this project from this browser ever again" case
   * CollaboratorsPanel's own onLeft callback below already reaches via a
   * self-service "leave project" click). Without this, every subsequent
   * action in the now-stale project view (a background refresh, any
   * mutation) 404ed the same way forever, with the project shell (tabs,
   * stale records) still rendered and no path back to the project list.
   * Guarded by project id so an unrelated/stale notification (there
   * shouldn't be one, since only one project is ever open at a time, but
   * matching defensively costs nothing) never kicks the viewer out of a
   * DIFFERENT project they've since navigated to.
   */
  useEffect(() => {
    return subscribeProjectGone((projectId, message) => {
      if (project?.id !== projectId) return;
      purgeProjectPreferences(projectId);
      handleGoHome();
      setError(message);
    });
  }, [project]);

  /**
   * myRole is fetched once, in openExistingProject, and never revalidated
   * afterward -- there's no poll or websocket for it. If the project
   * owner demotes this collaborator to "viewer" while they still have the
   * project open, every write control kept rendering as before and the
   * next action just 403ed with VIEWER_READ_ONLY, repeating indefinitely
   * with no way for the UI to catch up. Any write request hitting that
   * same 403 now calls notifyViewerDemoted (see api.ts), so just flip
   * myRole to "viewer" here and let the existing readOnly={myRole ===
   * "viewer"} wiring already threaded through every panel take it from
   * there -- no reset-to-home needed, unlike subscribeProjectGone above.
   */
  useEffect(() => {
    return subscribeViewerDemoted((projectId) => {
      if (project?.id !== projectId) return;
      setMyRole("viewer");
    });
  }, [project]);

  /**
   * subscribeViewerDemoted just above only fires on the back of a failed
   * write (a VIEWER_READ_ONLY 403) -- it structurally can't ever catch
   * the mirror-image case, a collaborator PROMOTED (e.g. viewer ->
   * editor) while they still have the project open: their next write
   * would simply succeed server-side, generating no error to hook into,
   * so myRole stayed stuck at the stale, now-too-restrictive role with no
   * way for the UI to catch up short of leaving and reopening the
   * project. Mirrors the WhatsApp-unread/failing-automations polls above
   * (same immediate-check-then-interval shape) to periodically re-derive
   * myRole the same way openExistingProject's own initial fetch does --
   * this also means a demotion is now caught at most MY_ROLE_POLL_
   * INTERVAL_MS sooner than waiting on the next failed write, a free
   * side benefit, not this poll's primary purpose.
   */
  useEffect(() => {
    if (!project || !user || project.ownerId === user.id) return;
    const projectId = project.id;
    const userId = user.id;
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    async function checkMyRole() {
      try {
        const { collaborators } = await listCollaborators(projectId);
        if (cancelled) return;
        const mine = collaborators.find((c) => c.userId === userId);
        setMyRole(mine?.role ?? "editor");
      } catch {
        // A single failed background check isn't worth surfacing to the
        // user -- just skip this tick and try again on the next one.
      }
    }

    intervalId = setInterval(checkMyRole, MY_ROLE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [project?.id, project?.ownerId, user?.id]);

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
      .then(({ projects }) => {
        const freshIds = new Set(projects.map((p) => p.id));
        for (const id of myProjectIdsRef.current) {
          if (!freshIds.has(id)) purgeProjectPreferences(id);
        }
        myProjectIdsRef.current = freshIds;
        setMyProjects(projects);
      })
      .catch(() => setMyProjects([]));
  }, [user, view]);

  // The Templates Gallery catalog is fixed, server-side static data (see
  // @forge/spec-engine's TEMPLATES) -- unlike myProjects above, it never
  // changes during a session, so this only needs to fetch once per login
  // rather than re-running on every visit to the home screen. A fetch
  // failure just leaves the gallery empty (the free-text idea box above it
  // still works fine on its own), so this deliberately swallows the error
  // instead of surfacing it as a blocking page-level failure.
  useEffect(() => {
    if (!user || templates.length > 0) return;
    listTemplates()
      .then(({ templates }) => setTemplates(templates))
      .catch(() => setTemplates([]));
  }, [user, templates.length]);

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
   *
   * Also prefixes a real unread-WhatsApp count (whatsappUnreadCount, the
   * same state the in-page whatsapp-unread-badge already renders) and a
   * failing-automations count (automationsFailingCount, the same state the
   * in-page automations-failing-badge already renders) -- those in-page
   * badges only ever caught someone's eye while this tab was already
   * focused; a count in the tab's own title/favicon-adjacent text is
   * visible from the tab bar or alt-tab switcher while working in a
   * completely different tab, the same Gmail/Slack convention.
   */
  useEffect(() => {
    document.title = formatDocumentTitle(project?.name ?? null, whatsappUnreadCount, automationsFailingCount);
  }, [project, whatsappUnreadCount, automationsFailingCount]);

  /**
   * Fetches every entity's record count once per built project, for the
   * entity-tabs badges -- a single cheap request instead of one per tab.
   * Reset to empty first so a just-opened project never briefly shows the
   * PREVIOUS project's stale counts while this request is in flight.
   */
  useEffect(() => {
    setEntityCounts({});
    if (project?.status !== "built") return;
    let cancelled = false;
    getEntityCounts(project.id)
      .then(({ counts }) => {
        if (!cancelled) setEntityCounts(counts);
      })
      .catch(() => {
        /* Tab badges are a nice-to-have -- a failed fetch here shouldn't surface its own error banner. */
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id, project?.status]);

  function openExistingProject(p: Project) {
    setProject(p);
    setActiveEntity(p.spec.entities[0]?.name ?? null);
    setSpecProvider(null);
    setEnhanceProvider(null);
    setBuildWarning(null);
    setView(p.status === "built" ? "preview" : "spec");
    if (user && p.ownerId !== user.id && p.sharedAt) setSeenShared(markSharedProjectSeen(user.id, p.id, p.sharedAt));
    if (!user || p.ownerId === user.id) {
      setMyRole("owner");
    } else {
      // Optimistic "editor" while the real role loads -- matches full
      // access, the only thing every collaborator had before roles
      // existed, so a slow network never shows a false read-only banner.
      // If this collaborator's access was actually revoked, the next
      // write attempt gets the real 403/404 from the server regardless,
      // which is the actual enforcement; this is only a UX nicety on top.
      setMyRole("editor");
      listCollaborators(p.id)
        .then(({ collaborators }) => {
          const mine = collaborators.find((c) => c.userId === user.id);
          setMyRole(mine?.role ?? "editor");
        })
        .catch(() => {});
    }
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
      purgeProjectPreferences(p.id);
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
    if (bulkDeleteBusy) return;
    const ids = [...visibleSelectedProjectIds];
    if (ids.length === 0) return;
    if (!window.confirm(t("home.myProjects.bulk.confirmDelete", { count: ids.length }))) return;
    setBulkDeleteBusy(true);
    setError(null);
    try {
      const results = await Promise.allSettled(ids.map((id) => deleteProject(id)));
      const failedIds = ids.filter((_, i) => results[i].status === "rejected");
      const succeededIds = new Set(ids.filter((_, i) => results[i].status === "fulfilled"));
      setMyProjects((prev) => prev.filter((p) => !succeededIds.has(p.id)));
      for (const id of succeededIds) purgeProjectPreferences(id);
      setSelectedProjectIds(new Set(failedIds));
      if (failedIds.length > 0) {
        const firstFailure = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
        setError(
          failedIds.length === ids.length
            ? (firstFailure.reason as Error).message
            : t("home.myProjects.bulk.partialFailure", { failed: failedIds.length, total: ids.length }),
        );
      }
    } finally {
      setBulkDeleteBusy(false);
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
        <p className="muted" role="status">
          {t("app.loading")}
        </p>
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
      setMyRole("owner");
      setSpecProvider(providerName);
      setEnhanceProvider(null);
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
   * textarea (nothing hidden -- including the honest signal for whether
   * the rewrite itself came from real AI or the offline heuristic fell
   * back to it, round 402, the same gap specProviderLabel closed for the
   * build step), then immediately runs that AI-written prompt through the
   * normal create-project pipeline -- the app builds its own prompt, then
   * builds itself from it.
   */
  async function handleEnhanceAndBuild() {
    if (!description.trim()) return;
    setEnhanceBusy(true);
    setError(null);
    try {
      const { enhanced, providerName: enhanceProviderName } = await enhanceIdea(description);
      setDescription(enhanced);
      saveIdeaDraft(enhanced);
      setEnhanceProvider(enhanceProviderName);
      const { project, providerName } = await createProject(enhanced);
      setProject(project);
      setMyRole("owner");
      setSpecProvider(providerName);
      setView("spec");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setEnhanceBusy(false);
    }
  }

  /**
   * The Templates Gallery's one-click path: unlike handleDescribe, there's
   * no free-text idea to send through generateSpec -- the chosen template's
   * spec is already a complete, valid ProductSpec, so this lands straight
   * on the spec review screen the same way handleDescribe's result does,
   * just with specProvider/enhanceProvider both cleared (neither the AI nor
   * the heuristic provider touched this draft, so there's nothing honest to
   * attribute it to -- see specProviderLabel/enhanceProviderLabel).
   * `templateBusy` (the chosen template's own id, not a plain boolean) lets
   * the gallery disable every card while keeping track of *which* card's
   * button should show its own busy label.
   */
  async function handleUseTemplate(templateId: string) {
    setTemplateBusy(templateId);
    setError(null);
    try {
      const { project } = await createProjectFromTemplate(templateId, lang);
      setProject(project);
      setMyRole("owner");
      setSpecProvider(null);
      setEnhanceProvider(null);
      setView("spec");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTemplateBusy(null);
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
    setEnhanceProvider(null);
    setSelectedAnswers({});
    setAdditionalRequest("");
    setBuildWarning(null);
    closeAllPanels();
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
    setEnhanceProvider(null);
    setSelectedAnswers({});
    setAdditionalRequest("");
    setActiveEntity(null);
    setRefineText("");
    setRefineHistory([]);
    setRefineHistorySearch("");
    setBuildWarning(null);
    closeAllPanels();
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
      // Every other export surface (table, per-entity CSV/Copy, both
      // Print sheets, Columns menu, board cards, the record form, the
      // calendar .ics export) already follows each entity's own
      // drag-reordered column order -- this is the one that didn't, since
      // the server backing this ZIP has no way to learn a client-only
      // localStorage preference on its own.
      const columnOrders: Record<string, string[]> = {};
      for (const entity of project.spec.entities) {
        const order = getColumnOrder(project.id, entity.name);
        if (order.length > 0) columnOrders[entity.name] = order;
      }
      await backupProject(project.id, project.name, columnOrders);
      setBackupDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleBuild() {
    if (!project) return;
    // Pairs each answer with its own question's text, by array index (see
    // selectedAnswers' own comment above countAnsweredOpenQuestions) --
    // never by the question text itself, so two identically-worded
    // questions each keep their own distinct answer instead of colliding.
    const answered = project.spec.openQuestions
      .map((q, i) => ({ question: q.question, answer: (selectedAnswers[String(i)] ?? "").trim() }))
      .filter((a) => a.answer.length > 0);
    const request = additionalRequest.trim();
    if (answered.length > 0 || request.length > 0) {
      setBusy(true);
      setError(null);
      try {
        const { project: updated, providerName } = await answerQuestions(project.id, answered, request || undefined);
        setProject(updated);
        if (providerName) setSpecProvider(providerName);
      } catch (err) {
        setError((err as Error).message);
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    setBuildWarning(null);
    setView("building");
  }

  function handleRefine(e: React.FormEvent) {
    e.preventDefault();
    if (!refineText.trim()) return;
    pendingRefineInstruction.current = refineText.trim();
    refineEvents.current = [];
    setBuildWarning(null);
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

  function handleBuildComplete(builtProject: Project, warning?: string) {
    if (refineRunning && pendingRefineInstruction.current) {
      const entry: RefineHistoryEntry = {
        id: crypto.randomUUID(),
        instruction: pendingRefineInstruction.current,
        summary: summarizeRefineImpact(refineEvents.current, t),
        completedAt: new Date().toISOString(),
        providerName: extractRefineProviderName(refineEvents.current),
      };
      setRefineHistory((prev) => [...prev, entry]);
    }
    // A refine's regenerated spec is free to drop an entity the previous
    // one had (the AI provider isn't guaranteed to keep every entity, e.g.
    // an instruction like "remove deals tracking, focus on invoices" --
    // see routes/projects.ts's own comment on /refine). Captured before
    // `setProject` below overwrites `project` with the new spec, so this
    // is still the PRE-refine entity list.
    // Round 988: falls back to a case-insensitive match when the exact
    // name misses -- mirrors pipeline.ts's own established
    // previousEntities ?? previousEntitiesByLowerName convention (rounds
    // 946/947/949/954) for the identical "a refine can rename an entity
    // by letter casing alone, a genuine no-op" hazard, which never
    // reached this client-side computation. Without it, a pure case
    // rename (e.g. "customer" -> "Customer") looked identical to that
    // entity being removed outright, below triggering a destructive
    // purgeEntityPreferences call against an entity that, semantically,
    // never actually changed.
    const builtEntityNamesLower = new Set(builtProject.spec.entities.map((be) => be.name.toLowerCase()));
    const droppedEntityNames = (project?.spec.entities ?? [])
      .filter((e) => !builtProject.spec.entities.some((be) => be.name === e.name) && !builtEntityNamesLower.has(e.name.toLowerCase()))
      .map((e) => e.name);
    pendingRefineInstruction.current = null;
    setBuildWarning(warning ?? null);
    setProject(builtProject);
    // Keeping the stale `prev` tab name in that case leaves the
    // entity-tabs filter matching nothing (`.filter((e) => e.name ===
    // activeEntity)`), so the preview pane goes blank with no tab visibly
    // selected until the user manually clicks another one -- the same
    // "stale activeEntity" failure mode handleLogout's own cleanup below
    // already guards against. Round 988: the same case-insensitive
    // fallback as droppedEntityNames just above -- a case-only rename of
    // the currently-open tab must carry `prev` forward under its new
    // spelling, not just fail to match and silently jump to a different
    // entity's tab entirely.
    setActiveEntity((prev) => {
      if (!prev) return builtProject.spec.entities[0]?.name ?? null;
      const exact = builtProject.spec.entities.find((e) => e.name === prev);
      if (exact) return prev;
      const renamed = builtProject.spec.entities.find((e) => e.name.toLowerCase() === prev.toLowerCase());
      return renamed ? renamed.name : (builtProject.spec.entities[0]?.name ?? null);
    });
    // Round 853: that same dropped entity's own per-entity-keyed
    // localStorage preferences (column widths/order/hidden fields, field
    // filters, group-by, collapsed board columns/groups, sort keys, view
    // mode, recent searches) were never purged either -- unlike whole-
    // project deletion, which projectPreferenceCleanup.ts already sweeps
    // thoroughly. See entityPreferenceCleanup.ts's own doc comment.
    for (const entityName of droppedEntityNames) {
      purgeEntityPreferences(builtProject.id, entityName);
    }
    setRefineText("");
    setAdditionalRequest("");
    setRefineRunning(false);
    setView("preview");
  }

  async function handleLogout() {
    await logout();
    setUser(null);
    setProject(null);
    setBuildWarning(null);
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
    // Round 993: recentProjectSearches is ideaDraft's own direct sibling --
    // a single flat, global, unscoped localStorage key holding freeform
    // user-typed text on this same home screen -- but was never added here
    // when ideaDraft's own clear was. Without this, a different user
    // logging into the same shared-machine tab (the exact scenario this
    // function's own comment above already describes) sees the PREVIOUS
    // account's typed search terms in the Recent Searches dropdown, and
    // (unlike the in-memory-only state above) that leak survives even a
    // full page reload since it's backed by localStorage.
    clearRecentProjectSearches();
    setRecentProjectSearches([]);
  }

  /**
   * Runs once DeleteAccountPanel's own DELETE /auth/account call has
   * already succeeded server-side -- the account, its projects, and every
   * one of its sessions (including this one) are already gone by this
   * point, so unlike handleLogout above this never calls the API's own
   * logout() (there's no session left to revoke, and the token is already
   * dead). Also purges every deleted project's own client-side preference
   * entries (round 403 -- this used to only reset local UI state, same as
   * handleLogout, leaving this account's localStorage entries behind
   * forever, the one "a project is gone" path purgeProjectPreferences's
   * own two existing callers, handleDeleteProject/handleBulkDeleteProjects,
   * never covered), then resets local UI state straight back to the auth screen.
   */
  function handleAccountDeleted(ownedProjectIds: string[], sharedProjectIds: string[]) {
    // DELETE /auth/account deletes every one of these server-side via the
    // exact same cascade handleDeleteProject/handleBulkDeleteProjects use
    // for a single/several projects -- but unlike those two, this path
    // never called purgeProjectPreferences, so this account's own entries
    // in all eighteen localStorage preference stores (projectPreferenceCleanup.ts)
    // sat there forever. Round 403's own fix.
    for (const id of ownedProjectIds) purgeProjectPreferences(id);
    // Round 423: the server side of DELETE /auth/account also calls
    // removeAllCollaborationsForUser, revoking this account's access to
    // every project it merely collaborates on (not deleting those projects
    // themselves, just this account's own grant on them) -- the exact same
    // "this browser can never reach this project again" event the
    // Collaborators panel's own onLeft callback below already sweeps for a
    // single project (round 404). Round 403 only ever passed the owned ids
    // here, so a shared project's own preference entries sat here forever.
    for (const id of sharedProjectIds) purgeProjectPreferences(id);
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
    // Round 993: see handleLogout's own identical reset, just above, for
    // why this must be cleared here too.
    clearRecentProjectSearches();
    setRecentProjectSearches([]);
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
            // streaming (view === "building", or a refine's own compact
            // BuildProgress on "preview" -- see canNavigateHome's own
            // comment) -- BuildProgress's own design only ever offers a way
            // out on failure, and this shouldn't silently disagree with that
            // by giving a second, unguarded exit.
            return canNavigateHome(view, refineRunning) ? (
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
          <div className="topbar-controls">
            <ThemeSwitcher />
            <LanguageSwitcher />
          </div>
          <div className="topbar-account">
            <span className="muted small topbar-account-email">{user.email}</span>
            <button type="button" className="secondary" onClick={() => setShowChangePassword(true)}>
              {t("topbar.changePassword")}
            </button>
            <button type="button" className="secondary" onClick={handleLogout}>
              {t("topbar.logout")}
            </button>
            <button type="button" className="danger" onClick={() => setShowDeleteAccount(true)}>
              {t("topbar.deleteAccount")}
            </button>
          </div>
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
                  onKeyDown={handleProjectSearchKeyDown}
                />
              )}
              {myProjects.length > 5 && !projectSearch.trim() && recentProjectSearches.length > 0 && (
                <div className="my-projects-search-recent">
                  <div className="my-projects-search-recent-header">
                    <span className="muted small">{t("home.myProjects.search.recent.heading")}</span>
                    <button type="button" className="link-button small" onClick={handleClearRecentProjectSearches}>
                      {t("home.myProjects.search.recent.clear")}
                    </button>
                  </div>
                  <div className="chips">
                    {recentProjectSearches.map((q) => (
                      <span className="chip chip-removable" key={q}>
                        <button type="button" className="chip-text" onClick={() => handleRecentProjectSearchClick(q)}>
                          {q}
                        </button>
                        <button
                          type="button"
                          className="chip-remove"
                          title={t("home.myProjects.search.recent.remove", { query: q })}
                          aria-label={t("home.myProjects.search.recent.remove", { query: q })}
                          onClick={() => handleRemoveRecentProjectSearch(q)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
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
                  <button type="button" className="danger" disabled={bulkDeleteBusy} onClick={handleBulkDeleteProjects}>
                    {bulkDeleteBusy ? t("home.myProjects.bulk.deleteSelected.busy") : t("home.myProjects.bulk.deleteSelected")}
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
                        onClick={() => setPinnedIds(togglePinned(user.id, p.id))}
                      >
                        {pinnedIds.has(p.id) ? "⭐" : "☆"}
                      </button>
                      <button type="button" className="my-project-open" onClick={() => openExistingProject(p)}>
                        <strong>{p.name}</strong>
                        {p.ownerId !== user.id && <span className="chip">{t("home.myProjects.shared")}</span>}
                        {p.ownerId !== user.id && isNewShare(seenShared, p.id, p.sharedAt) && (
                          <span className="chip chip-new">{t("home.myProjects.newShare")}</span>
                        )}
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
          <div className="hero3d" aria-hidden="true">
            <div className="hero3d-cube">
              <div className="hero3d-face hero3d-face-front" />
              <div className="hero3d-face hero3d-face-back" />
              <div className="hero3d-face hero3d-face-right" />
              <div className="hero3d-face hero3d-face-left" />
              <div className="hero3d-face hero3d-face-top" />
              <div className="hero3d-face hero3d-face-bottom" />
            </div>
          </div>
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
              className="button-ai"
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
                  <span className="idea-example-icon" aria-hidden="true">{example.icon}</span>
                  <span className="idea-example-label">{t(example.labelKey)}</span>
                </button>
              ))}
            </div>
          </div>

          {templates.length > 0 && (
            <div className="templates-gallery">
              <h2>{t("home.templates.heading")}</h2>
              <p className="muted small">{t("home.templates.subheading")}</p>
              <div className="templates-gallery-grid">
                {templates.map((template) => (
                  <div className="template-card" key={template.id}>
                    <span className="template-card-icon" aria-hidden="true">{template.icon}</span>
                    <h3 className="template-card-name">{lang === "en" ? template.name : template.nameHe}</h3>
                    <p className="muted small template-card-description">
                      {lang === "en" ? template.description : template.descriptionHe}
                    </p>
                    {(lang === "en" ? template.entityNamesEn : template.entityNames).length > 0 && (
                      <p className="muted small template-card-entities">
                        {t("home.templates.includes")}: {(lang === "en" ? template.entityNamesEn : template.entityNames).join(", ")}
                      </p>
                    )}
                    <button
                      type="button"
                      disabled={templateBusy !== null}
                      onClick={() => handleUseTemplate(template.id)}
                    >
                      {templateBusy === template.id ? t("home.templates.use.busy") : t("home.templates.use")}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      )}

      {view === "spec" && project && (
        <main className="spec-review">
          <ProjectNameEditor project={project} onRenamed={setProject} readOnly={myRole === "viewer"} />
          <p className="muted small">{t("spec.title")}</p>
          <p>{project.spec.summary}</p>
          {specProviderLabel(specProvider, t) && (
            <p className={specProvider === "anthropic-fallback" ? "error" : "muted small"}>
              {specProviderLabel(specProvider, t)}
            </p>
          )}
          {enhanceProviderLabel(enhanceProvider, t) && (
            <p className={enhanceProvider === "anthropic-fallback" ? "error" : "muted small"}>
              {enhanceProviderLabel(enhanceProvider, t)}
            </p>
          )}

          <section>
            <h2>{t("spec.description.heading")}</h2>
            <p className="muted small">{t("spec.description.hint")}</p>
            <ProjectDescriptionEditor project={project} onChanged={setProject} readOnly={myRole === "viewer"} />
          </section>

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
                  readOnly={myRole === "viewer"}
                />
              ))}
            </div>
            <AddRoleForm projectId={project.id} onAdded={setProject} readOnly={myRole === "viewer"} />
          </section>

          <section>
            <h2>{t("spec.personas.heading")}</h2>
            <ul>
              {project.spec.personas.map((p, i) => (
                <PersonaItem
                  key={`${i}-${p}`}
                  persona={p}
                  projectId={project.id}
                  index={i}
                  onRenamed={setProject}
                  onRemoved={setProject}
                  readOnly={myRole === "viewer"}
                />
              ))}
            </ul>
            <AddPersonaForm projectId={project.id} onAdded={setProject} readOnly={myRole === "viewer"} />
          </section>

          <section>
            <h2>{t("spec.entities.heading")}</h2>
            {project.spec.entities.map((entity) => (
              <EntitySummaryItem
                key={entity.name}
                entity={entity}
                allEntities={project.spec.entities}
                fieldsSummary={formatEntityFieldSummary(entity.fields)}
                projectId={project.id}
                canRemove={project.spec.entities.length > 1}
                onRenamed={setProject}
                onRemoved={setProject}
                readOnly={myRole === "viewer"}
              />
            ))}
            {project.spec.entities.some((e) => e.fields.some((f) => f.required)) && (
              <p className="muted small">{t("spec.entities.requiredHint")}</p>
            )}
            <AddEntityForm projectId={project.id} onAdded={setProject} readOnly={myRole === "viewer"} />
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
                  readOnly={myRole === "viewer"}
                />
              ))}
            </ul>
            <AddAssumptionForm projectId={project.id} onAdded={setProject} readOnly={myRole === "viewer"} />
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
                        className={selectedAnswers[String(i)] === opt ? "chip chip-selected" : "chip chip-button"}
                        onClick={() => setSelectedAnswers((prev) => ({ ...prev, [String(i)]: opt }))}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    className="answer-input"
                    placeholder={t("spec.answerInput.placeholder")}
                    value={selectedAnswers[String(i)] ?? ""}
                    onChange={(e) => setSelectedAnswers((prev) => ({ ...prev, [String(i)]: e.target.value }))}
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
          onBack={() => {
            // Mirrors handleBackToHome/handleGoHome's own identical cleanup
            // (see their doc comments) -- the spec screen this lands back
            // on, after a failed build, is showing project.spec as
            // /answers just replaced it (a brand-new openQuestions array,
            // different questions/count/order from whatever selectedAnswers
            // was keyed against by array index before this build attempt).
            // Without this, re-submitting Build pairs a NEW question at
            // index i with a STALE answer written for a completely
            // different, now-gone question at that same index, silently
            // feeding a mismatched question/answer pair into the next real
            // generateSpec() call with no warning shown anywhere.
            setSelectedAnswers({});
            setAdditionalRequest("");
            setView("spec");
          }}
          specProviderNotice={
            specProviderLabel(specProvider, t) && (
              <p className={specProvider === "anthropic-fallback" ? "error" : "muted small"}>{specProviderLabel(specProvider, t)}</p>
            )
          }
        />
      )}

      {view === "preview" && project && (
        <main className="preview">
          <div className="preview-header">
            <ProjectNameEditor project={project} onRenamed={setProject} readOnly={myRole === "viewer"} />
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
                {whatsappUnreadCount > 0 && (
                  <span className="whatsapp-unread-badge" aria-label={t("whatsapp.unreadBadge", { count: String(whatsappUnreadCount) })}>
                    {whatsappUnreadCount}
                  </span>
                )}
              </button>
              <button type="button" className="secondary" onClick={() => openPanel("automations")}>
                {t("preview.automations")}
                {automationsFailingCount > 0 && (
                  <span
                    className="automations-failing-badge"
                    aria-label={t("automations.failingBadge", { count: String(automationsFailingCount) })}
                  >
                    {automationsFailingCount}
                  </span>
                )}
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

          {myRole === "viewer" && <p className="viewer-readonly-banner">{t("viewer.readOnlyBanner")}</p>}

          {buildWarning && (
            <p className="muted small" role="status">
              {t("preview.buildWarning", { detail: buildWarning })}
            </p>
          )}

          {/* Round 905: the spec-review screen (pre-build) already had this
              editor, but it was never mounted here -- project.description is
              re-sent as AI context on every /refine call for the entire
              post-build life of the project (see ProjectDescriptionEditor's
              own comment), yet a built project had no way to ever see or fix
              it again. The server's PATCH /projects/:id/description route
              already supports this unconditionally (no project.status
              guard); only the UI was missing. */}
          <section className="preview-description-section">
            <h2>{t("spec.description.heading")}</h2>
            <p className="muted small">{t("spec.description.hint")}</p>
            <ProjectDescriptionEditor project={project} onChanged={setProject} readOnly={myRole === "viewer"} />
          </section>

          {/* Round 906: the same round-905 gap, for roles/personas/
              assumptions instead of the description -- these three edit
              controls (RoleChip/PersonaItem/AssumptionItem + their Add*Form
              siblings) were only ever mounted on the pre-build spec-review
              screen, which becomes permanently unreachable once a project
              builds (App.tsx's own openExistingProject/handleBuildComplete
              always route a built project to "preview", never "spec"
              again). The server's own POST/DELETE/PATCH routes for all
              three have no project.status guard at all (only the same
              activePipelines check every other spec-edit route already
              has) -- their own comment explicitly analogizes them to the
              entity/field-label routes, which already DO have a working
              post-build UI path via EntityPanel.tsx. Reuses the exact same
              JSX the spec-review screen already renders, unchanged. */}
          <section className="preview-roles-section">
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
                  readOnly={myRole === "viewer"}
                />
              ))}
            </div>
            <AddRoleForm projectId={project.id} onAdded={setProject} readOnly={myRole === "viewer"} />
          </section>

          <section className="preview-personas-section">
            <h2>{t("spec.personas.heading")}</h2>
            <ul>
              {project.spec.personas.map((p, i) => (
                <PersonaItem
                  key={`${i}-${p}`}
                  persona={p}
                  projectId={project.id}
                  index={i}
                  onRenamed={setProject}
                  onRemoved={setProject}
                  readOnly={myRole === "viewer"}
                />
              ))}
            </ul>
            <AddPersonaForm projectId={project.id} onAdded={setProject} readOnly={myRole === "viewer"} />
          </section>

          <section className="preview-assumptions-section">
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
                  readOnly={myRole === "viewer"}
                />
              ))}
            </ul>
            <AddAssumptionForm projectId={project.id} onAdded={setProject} readOnly={myRole === "viewer"} />
          </section>

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
                    // Round 938: refineText itself stays untrimmed until
                    // handleBuildComplete clears it at the very end of this
                    // whole stream -- sending it raw here, instead of the
                    // already-trimmed pendingRefineInstruction.current
                    // handleRefine set just above, would bake a stray
                    // leading/trailing space the user typed into this
                    // checkpoint's own PERMANENT label (changeLabel on the
                    // server), while the local refine-history chat pane
                    // right next to it shows the clean, trimmed text for
                    // the exact same action.
                    return streamRefine(project.id, pendingRefineInstruction.current ?? refineText, wrappedOnEvent);
                  }}
                  onComplete={handleBuildComplete}
                  onBack={() => setRefineRunning(false)}
                />
              ) : myRole !== "viewer" ? (
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
              ) : null}

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
                          {specProviderLabel(entry.providerName, t) && (
                            <p className={entry.providerName === "anthropic-fallback" ? "error" : "muted small"}>
                              {specProviderLabel(entry.providerName, t)}
                            </p>
                          )}
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
                {orderedEntities.map((entity, entityTabIndex) => (
                  <span key={entity.name} className="tab-wrapper">
                    <button
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
                      {entityCounts[entity.name] != null && (
                        <span className="tab-count" aria-label={t("entity.tab.recordCount", { count: String(entityCounts[entity.name]) })}>
                          {entityCounts[entity.name]}
                        </span>
                      )}
                    </button>
                    <span className="tab-move-buttons">
                      <button
                        type="button"
                        className="tab-move-btn"
                        onClick={() => handleMoveEntityTab(entity.name, "earlier")}
                        disabled={entityTabIndex === 0}
                        aria-label={t("entity.tab.moveEarlier", { entity: entity.label ?? entity.name })}
                      >
                        ‹
                      </button>
                      <button
                        type="button"
                        className="tab-move-btn"
                        onClick={() => handleMoveEntityTab(entity.name, "later")}
                        disabled={entityTabIndex === orderedEntities.length - 1}
                        aria-label={t("entity.tab.moveLater", { entity: entity.label ?? entity.name })}
                      >
                        ›
                      </button>
                    </span>
                  </span>
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
                    userId={user.id}
                    onEntityRenamed={setProject}
                    highlightRecordId={highlightRecordId}
                    onHighlightHandled={() => setHighlightRecordId(null)}
                    createPrefill={createPrefill}
                    onCreatePrefillHandled={() => setCreatePrefill(null)}
                    onJumpToRecord={(targetEntity, recordId) => {
                      setActiveEntity(targetEntity);
                      setHighlightRecordId(recordId);
                    }}
                    onSendWhatsApp={(phoneNumber) => {
                      setWhatsappPrefillTo(phoneNumber);
                      openPanel("whatsapp");
                    }}
                    onRecordCountChange={(entityName, count) =>
                      setEntityCounts((prev) => (prev[entityName] === count ? prev : { ...prev, [entityName]: count }))
                    }
                    readOnly={myRole === "viewer"}
                  />
                ))}
            </div>
          </div>

          {showHistory && (
            <HistoryPanel
              projectId={project.id}
              projectName={project.name}
              currentSpec={project.spec}
              userId={user.id}
              onClose={() => setShowHistory(false)}
              onRestored={(restored) => {
                // Restoring an older checkpoint is, like a refine
                // (handleBuildComplete above), a normal way for an entity to
                // disappear from the live spec -- routes/projects.ts's own
                // restore-checkpoint comment explicitly names "missing an
                // entity/field the user has been actively using" as an
                // expected outcome. Captured before `setProject` below
                // overwrites `project` with the restored spec, so this is
                // still the PRE-restore entity list.
                // Round 988: same case-insensitive fallback as
                // handleBuildComplete's own identical computation above --
                // a checkpoint whose entity differs from the live spec only
                // by letter casing is the same genuine no-op there too.
                const restoredEntityNamesLower = new Set(restored.spec.entities.map((re) => re.name.toLowerCase()));
                const droppedEntityNames = (project?.spec.entities ?? [])
                  .filter((e) => !restored.spec.entities.some((re) => re.name === e.name) && !restoredEntityNamesLower.has(e.name.toLowerCase()))
                  .map((e) => e.name);
                setProject(restored);
                setActiveEntity(restored.spec.entities[0]?.name ?? null);
                setBuildWarning(null);
                setShowHistory(false);
                // Round 866: the same per-entity-keyed localStorage sweep
                // handleBuildComplete already runs for a refine's dropped
                // entities (entityPreferenceCleanup.ts) was never run here,
                // even though a checkpoint restore drops entities just as
                // routinely.
                for (const entityName of droppedEntityNames) {
                  purgeEntityPreferences(restored.id, entityName);
                }
              }}
              readOnly={myRole === "viewer"}
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
              entities={project.spec.entities}
              userId={user.id}
              onClose={() => {
                setShowWhatsApp(false);
                setWhatsappPrefillTo(null);
              }}
              onJumpToEntity={(entityName) => {
                setActiveEntity(entityName);
                setShowWhatsApp(false);
                setWhatsappPrefillTo(null);
              }}
              onJumpToRecord={(entityName, recordId) => {
                setActiveEntity(entityName);
                setHighlightRecordId(recordId);
                setShowWhatsApp(false);
                setWhatsappPrefillTo(null);
              }}
              onCreateRecordFromMessage={(entityName, fieldName, phoneNumber) => {
                setActiveEntity(entityName);
                setCreatePrefill({ fieldName, value: phoneNumber });
                setShowWhatsApp(false);
                setWhatsappPrefillTo(null);
              }}
              prefillTo={whatsappPrefillTo}
              onMessageDeleted={(id) => {
                if (lastNotifiedWhatsAppIdRef.current?.id === id) lastNotifiedWhatsAppIdRef.current = null;
              }}
              onHistoryCleared={() => {
                lastNotifiedWhatsAppIdRef.current = null;
              }}
              readOnly={myRole === "viewer"}
            />
          )}

          {showAutomations && (
            // orderedEntities (the entity tab bar's own drag/keyboard-
            // reordered order, entityTabOrder.ts), not the raw
            // project.spec.entities -- the same fix round 713 already made
            // for GlobalSearchPanel below, for the identical reason: the
            // "Create automation rule" form's entity dropdown must follow
            // a user's own deliberate tab reorder, not the original spec/
            // build order.
            <AutomationsPanel
              projectId={project.id}
              project={project}
              entities={orderedEntities}
              onClose={() => setShowAutomations(false)}
              readOnly={myRole === "viewer"}
            />
          )}

          {showCollaborators && (
            <CollaboratorsPanel
              projectId={project.id}
              isOwner={user?.id === project.ownerId}
              currentUserId={user?.id}
              onClose={() => setShowCollaborators(false)}
              onLeft={() => {
                // Self-service "leave project" (CollaboratorsPanel's own
                // handleLeave) ends in the exact same state for this user as
                // the three paths round 390/392/403 already purge for
                // (owner delete, bulk delete, account delete): no access to
                // this project from this browser ever again -- but was
                // never wired into that sweep, a 4th convergent path to
                // "project gone" that round 403's own fix missed. Round 404.
                purgeProjectPreferences(project.id);
                setShowCollaborators(false);
                handleGoHome();
              }}
            />
          )}

          {showSearch && (
            // orderedEntities (the entity tab bar's own drag/keyboard-reordered
            // order, entityTabOrder.ts), not the raw project.spec.entities --
            // GlobalSearchPanel's result groups and arrow-key navigation order
            // follow this prop's own order exactly, so a user who has
            // deliberately moved, say, "Customers" to the top of their entity
            // tabs still saw search list it wherever it happened to fall in
            // the original spec/build order. The same convention every
            // orderedFields-respecting surface (filter dropdowns, group-by,
            // bulk-edit, CSV/ICS export) already follows for field order.
            <GlobalSearchPanel
              projectId={project.id}
              projectName={project.name}
              entities={orderedEntities}
              userId={user.id}
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

          {showShortcuts && (
            <ShortcutsPanel onClose={() => setShowShortcuts(false)} readOnly={myRole === "viewer"} />
          )}
        </main>
      )}
    </div>
  );
}
