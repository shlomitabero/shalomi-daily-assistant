import { useEffect, useRef, useState } from "react";
import type { AgentStepEvent, Project, User } from "@forge/shared";
import {
  answerQuestions,
  clearToken,
  createProject,
  exportProject,
  getToken,
  logout,
  me,
  streamBuild,
  streamRefine,
} from "./api.js";
import { AuthScreen } from "./AuthScreen.js";
import { BuildProgress } from "./BuildProgress.js";
import { BusinessTwinPanel } from "./BusinessTwinPanel.js";
import { EntityPanel } from "./EntityPanel.js";
import { HistoryPanel } from "./HistoryPanel.js";
import { LanguageProvider, useTranslation } from "./i18n/LanguageContext.js";
import { LanguageSwitcher } from "./i18n/LanguageSwitcher.js";

type View = "home" | "spec" | "building" | "preview";

interface RefineHistoryEntry {
  id: string;
  instruction: string;
  summary: string;
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
function summarizeRefineImpact(events: AgentStepEvent[], t: (key: string) => string): string {
  const architectEvent = events.find((e) => e.agent === "Architect" && e.status === "success");
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

export default function App() {
  return (
    <LanguageProvider>
      <AppContent />
    </LanguageProvider>
  );
}

function AppContent() {
  const { t } = useTranslation();
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [view, setView] = useState<View>("home");
  const [description, setDescription] = useState("");
  const [project, setProject] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeEntity, setActiveEntity] = useState<string | null>(null);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({});
  const [additionalRequest, setAdditionalRequest] = useState("");
  const [refineText, setRefineText] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [showTwin, setShowTwin] = useState(false);
  const [refineHistory, setRefineHistory] = useState<RefineHistoryEntry[]>([]);
  const [refineRunning, setRefineRunning] = useState(false);
  const pendingRefineInstruction = useRef<string | null>(null);
  const refineEvents = useRef<AgentStepEvent[]>([]);

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

  if (checkingSession) {
    return (
      <div className="app">
        <p className="muted">{t("app.loading")}</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="app">
        <AuthScreen onAuthenticated={setUser} />
      </div>
    );
  }

  async function handleDescribe(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await createProject(description);
      setProject(project);
      setView("spec");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleExport() {
    if (!project) return;
    setExportBusy(true);
    setError(null);
    try {
      await exportProject(project.id, project.name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExportBusy(false);
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

  function handleBuildComplete(builtProject: Project) {
    if (refineRunning && pendingRefineInstruction.current) {
      const entry: RefineHistoryEntry = {
        id: crypto.randomUUID(),
        instruction: pendingRefineInstruction.current,
        summary: summarizeRefineImpact(refineEvents.current, t),
      };
      setRefineHistory((prev) => [...prev, entry]);
    }
    pendingRefineInstruction.current = null;
    setProject(builtProject);
    setActiveEntity((prev) => prev ?? builtProject.spec.entities[0]?.name ?? null);
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
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title">
          <div className="brand-row">
            <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <path
                d="M16 2c1.2 4.4-1.6 6.4-3.4 8.6-2.2 2.7-3.2 5.6-1.8 8.9 1 2.3 3 3.7 5.2 3.7-1.4-2-1.4-3.8-.3-5.6 1-1.6 2.6-2.3 2.9-4.3.9 1.6 1.4 3.2 1.2 5-.2 2.1-1.4 3.7-1.4 3.7 3.6-.6 6.6-3.6 6.6-7.6 0-3.4-2-5.6-3.8-7.6-2.6-2.9-4.4-5.6-5.2-8.8Z"
                fill="var(--accent)"
              />
            </svg>
            <span className="brand">Forge AI</span>
          </div>
          <span className="tagline">{t("brand.tagline")}</span>
        </div>
        <div className="topbar-right">
          <LanguageSwitcher />
          <span className="muted small">{user.email}</span>
          <button type="button" className="secondary" onClick={handleLogout}>
            {t("topbar.logout")}
          </button>
        </div>
      </header>

      {error && <p className="error banner">{error}</p>}

      {view === "home" && (
        <main className="home">
          <h1>{t("home.title")}</h1>
          <form onSubmit={handleDescribe}>
            <textarea
              rows={5}
              placeholder={t("home.placeholder")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <button type="submit" disabled={busy}>
              {busy ? t("home.submit.busy") : t("home.submit")}
            </button>
          </form>
        </main>
      )}

      {view === "spec" && project && (
        <main className="spec-review">
          <h1>{t("spec.title")}</h1>
          <p>{project.spec.summary}</p>

          <section>
            <h2>{t("spec.roles.heading")}</h2>
            <div className="chips">
              {project.spec.roles.map((r) => (
                <span className="chip" key={r}>
                  {r}
                </span>
              ))}
            </div>
          </section>

          <section>
            <h2>{t("spec.entities.heading")}</h2>
            {project.spec.entities.map((entity) => (
              <div key={entity.name} className="entity-summary">
                <strong>{entity.label ?? entity.name}</strong>
                <span className="muted"> — {entity.fields.map((f) => f.label ?? f.name).join(", ")}</span>
              </div>
            ))}
          </section>

          <section>
            <h2>{t("spec.assumptions.heading")}</h2>
            <ul>
              {project.spec.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </section>

          {project.spec.openQuestions.length > 0 && (
            <section>
              <h2>{t("spec.openQuestions.heading")}</h2>
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

          <button type="button" onClick={handleBuild} disabled={busy}>
            {busy ? t("spec.build.busy") : t("spec.build.submit")}
          </button>
        </main>
      )}

      {view === "building" && project && (
        <BuildProgress
          title={t("build.title.build")}
          run={(onEvent) => streamBuild(project.id, onEvent)}
          onComplete={handleBuildComplete}
          onBack={() => setView("spec")}
        />
      )}

      {view === "preview" && project && (
        <main className="preview">
          <div className="preview-header">
            <h1>{project.name}</h1>
            <div className="preview-header-actions">
              <button type="button" className="secondary" onClick={() => setShowTwin(true)}>
                {t("preview.twin")}
              </button>
              <button type="button" className="secondary" onClick={handleExport} disabled={exportBusy}>
                {exportBusy ? t("preview.export.busy") : t("preview.export")}
              </button>
              <button type="button" className="secondary" onClick={() => setShowHistory(true)}>
                {t("preview.history")}
              </button>
            </div>
          </div>

          <div className="preview-body">
            <div className="preview-chat-pane">
              {refineRunning ? (
                <BuildProgress
                  compact
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
                  <ul className="refine-history-list">
                    {refineHistory.map((entry) => (
                      <li key={entry.id}>
                        <p className="refine-history-instruction">{entry.instruction}</p>
                        <p className="muted small">{entry.summary}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="preview-live-pane">
              <nav className="entity-tabs">
                {project.spec.entities.map((entity) => (
                  <button
                    key={entity.name}
                    className={activeEntity === entity.name ? "tab tab-active" : "tab"}
                    onClick={() => setActiveEntity(entity.name)}
                  >
                    {entity.label ?? entity.name}
                  </button>
                ))}
              </nav>
              {project.spec.entities
                .filter((e) => e.name === activeEntity)
                .map((entity) => <EntityPanel key={entity.name} projectId={project.id} entity={entity} />)}
            </div>
          </div>

          {showHistory && (
            <HistoryPanel
              projectId={project.id}
              onClose={() => setShowHistory(false)}
              onRestored={(restored) => {
                setProject(restored);
                setActiveEntity(restored.spec.entities[0]?.name ?? null);
                setShowHistory(false);
              }}
            />
          )}

          {showTwin && <BusinessTwinPanel projectId={project.id} onClose={() => setShowTwin(false)} />}
        </main>
      )}
    </div>
  );
}
