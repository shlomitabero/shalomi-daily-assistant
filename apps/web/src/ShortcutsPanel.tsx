import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";

/**
 * Every keyboard shortcut in the live preview accumulated one round at a
 * time (Ctrl/Cmd+K and Escape in round 68, j/k row navigation in round
 * 188, "/" in round 199) with no single place a person could ever see the
 * full list -- each was only discoverable by accident, or not at all.
 * This panel is that list, opened by its own "?" shortcut (a convention
 * from the same tools "/" already borrowed, GitHub and Slack among them)
 * or the topbar button next to it. Purely static content -- no state, no
 * network request -- so this is the simplest overlay panel in the app.
 */
const SHORTCUTS: { keys: string[]; descriptionKey: string }[] = [
  { keys: ["Ctrl", "K"], descriptionKey: "shortcuts.search" },
  { keys: ["/"], descriptionKey: "shortcuts.search" },
  { keys: ["?"], descriptionKey: "shortcuts.help" },
  { keys: ["Esc"], descriptionKey: "shortcuts.close" },
  { keys: ["j", "↓"], descriptionKey: "shortcuts.rowDown" },
  { keys: ["k", "↑"], descriptionKey: "shortcuts.rowUp" },
  { keys: ["Enter"], descriptionKey: "shortcuts.rowEdit" },
];

export function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const dialogRef = useDialogFocusTrap<HTMLDivElement>();

  return (
    <div className="history-overlay">
      <div className="history-panel" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <div className="history-header">
          <h2 id="shortcuts-title">{t("shortcuts.title")}</h2>
          <button type="button" className="secondary" onClick={onClose}>
            {t("history.close")}
          </button>
        </div>
        <ul className="shortcuts-list">
          {SHORTCUTS.map((row, i) => (
            <li key={i} className="shortcuts-row">
              <span className="shortcuts-keys">
                {row.keys.map((key, j) => (
                  <kbd key={j}>{key}</kbd>
                ))}
              </span>
              <span>{t(row.descriptionKey)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
