import { useEffect, useState } from "react";
import type { Project, User } from "@forge/shared";
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

type View = "home" | "spec" | "building" | "preview";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [view, setView] = useState<View>("home");
  const [description, setDescription] = useState("");
  const [project, setProject] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeEntity, setActiveEntity] = useState<string | null>(null);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({});
  const [refineText, setRefineText] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [buildMode, setBuildMode] = useState<"build" | "refine">("build");
  const [exportBusy, setExportBusy] = useState(false);
  const [showTwin, setShowTwin] = useState(false);

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
        <p className="muted">טוען…</p>
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
    if (Object.keys(answered).length > 0) {
      setBusy(true);
      setError(null);
      try {
        const { project: updated } = await answerQuestions(project.id, answered);
        setProject(updated);
      } catch (err) {
        setError((err as Error).message);
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    setBuildMode("build");
    setView("building");
  }

  function handleRefine(e: React.FormEvent) {
    e.preventDefault();
    if (!refineText.trim()) return;
    setBuildMode("refine");
    setView("building");
  }

  function handleBuildComplete(builtProject: Project) {
    setProject(builtProject);
    setActiveEntity((prev) => prev ?? builtProject.spec.entities[0]?.name ?? null);
    setRefineText("");
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
          <span className="tagline">מתארים עסק במילים שלכם — ומקבלים אפליקציה עובדת.</span>
        </div>
        <div className="topbar-right">
          <span className="muted small">{user.email}</span>
          <button type="button" className="secondary" onClick={handleLogout}>
            יציאה
          </button>
        </div>
      </header>

      {error && <p className="error banner">{error}</p>}

      {view === "home" && (
        <main className="home">
          <h1>מה תרצו לבנות?</h1>
          <form onSubmit={handleDescribe}>
            <textarea
              rows={5}
              placeholder="לדוגמה: אפליקציה לניהול תורים למספרה, עם לקוחות, עובדים ושירותים, ולוח בקרה למנהל/ת."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <button type="submit" disabled={busy}>
              {busy ? "חושבים על זה…" : "בואו נתחיל"}
            </button>
          </form>
        </main>
      )}

      {view === "spec" && project && (
        <main className="spec-review">
          <h1>ככה הבנו את זה</h1>
          <p>{project.spec.summary}</p>

          <section>
            <h2>מי ישתמש באפליקציה</h2>
            <div className="chips">
              {project.spec.roles.map((r) => (
                <span className="chip" key={r}>
                  {r}
                </span>
              ))}
            </div>
          </section>

          <section>
            <h2>המסכים שנבנה</h2>
            {project.spec.entities.map((entity) => (
              <div key={entity.name} className="entity-summary">
                <strong>{entity.label ?? entity.name}</strong>
                <span className="muted"> — {entity.fields.map((f) => f.label ?? f.name).join(", ")}</span>
              </div>
            ))}
          </section>

          <section>
            <h2>הנחות שעשינו</h2>
            <ul>
              {project.spec.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </section>

          {project.spec.openQuestions.length > 0 && (
            <section>
              <h2>כדאי שתחליטו</h2>
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
                    placeholder="או כתבו תשובה משלכם…"
                    value={selectedAnswers[q.question] ?? ""}
                    onChange={(e) => setSelectedAnswers((prev) => ({ ...prev, [q.question]: e.target.value }))}
                  />
                  {q.recommendation && <p className="muted small">ההמלצה שלנו: {q.recommendation}</p>}
                </div>
              ))}
            </section>
          )}

          <button type="button" onClick={handleBuild} disabled={busy}>
            {busy ? "מיישמים את התשובות שלכם…" : "🔥 לבנות את האפליקציה"}
          </button>
        </main>
      )}

      {view === "building" && project && (
        <BuildProgress
          title={buildMode === "build" ? "צוות ה-AI בונה את האפליקציה שלכם" : "צוות ה-AI מיישם את השינוי"}
          run={(onEvent) =>
            buildMode === "build" ? streamBuild(project.id, onEvent) : streamRefine(project.id, refineText, onEvent)
          }
          onComplete={handleBuildComplete}
          onBack={() => setView(buildMode === "build" ? "spec" : "preview")}
        />
      )}

      {view === "preview" && project && (
        <main className="preview">
          <div className="preview-header">
            <h1>{project.name}</h1>
            <div className="preview-header-actions">
              <button type="button" className="secondary" onClick={() => setShowTwin(true)}>
                🧠 תמונת העסק
              </button>
              <button type="button" className="secondary" onClick={handleExport} disabled={exportBusy}>
                {exportBusy ? "מייצא…" : "⬇️ ייצוא קוד"}
              </button>
              <button type="button" className="secondary" onClick={() => setShowHistory(true)}>
                🕘 ציר זמן
              </button>
            </div>
          </div>

          <form className="refine-box" onSubmit={handleRefine}>
            <input
              type="text"
              placeholder='לדוגמה: "רוצה לעקוב גם אחרי חשבוניות ללקוחות"'
              value={refineText}
              onChange={(e) => setRefineText(e.target.value)}
            />
            <button type="submit" disabled={!refineText.trim()}>
              שיפור האפליקציה
            </button>
          </form>

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
