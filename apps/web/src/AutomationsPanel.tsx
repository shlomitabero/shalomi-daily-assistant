import { useEffect, useMemo, useState } from "react";
import type { Entity, Project } from "@forge/shared";
import {
  createAutomationRule,
  deleteAutomationRule,
  listAutomationRules,
  listAutomationRuns,
  updateAutomationRule,
  type AutomationActionType,
  type AutomationRuleView,
  type AutomationRunView,
  type AutomationToMode,
  type AutomationTrigger,
} from "./api.js";
import { downloadAutomationsReport, formatAutomationsReport } from "./automationsReport.js";
import { uniqueEnumValues } from "./entityFormatting.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";

const LOCALE: Record<string, string> = { he: "he-IL", en: "en-US" };

/**
 * If-this-then-that automation rules on top of this app's existing
 * WhatsApp integration: "when a record in this entity is created, or a
 * field on it is set to a given value, send a WhatsApp message." Firing
 * happens server-side (apps/api/src/automations.ts) on every record
 * create/update -- this panel only manages the rules themselves (create,
 * enable/disable, delete) and shows each rule's most recent outcome.
 * Structurally mirrors CollaboratorsPanel.tsx (list + add-form + remove,
 * same overlay/dialog chrome), the most similarly-scoped existing panel.
 */
export function AutomationsPanel({
  projectId,
  project,
  onClose,
  readOnly = false,
}: {
  projectId: string;
  project: Project;
  onClose: () => void;
  /** True for a "viewer" collaborator -- the server already rejects every write here with 403 VIEWER_READ_ONLY; this just keeps a viewer from clicking a control that can only ever fail. */
  readOnly?: boolean;
}) {
  const { t, lang } = useTranslation();
  const [rules, setRules] = useState<AutomationRuleView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  // A rule's own lastTriggeredAt/lastStatus/lastError only ever shows the
  // single most recent firing -- expanding "History" here fetches the
  // real run-by-run log (packages/db/src/automations.ts's own
  // automation_runs table) so a rule that fails intermittently doesn't
  // look perfectly healthy just because its latest attempt happened to
  // succeed. Only one rule's history is ever expanded at a time, same as
  // this panel's own single-draft-at-a-time edit convention; runsByRuleId
  // caches each rule's fetched runs so re-expanding the same rule doesn't
  // re-fetch.
  const [expandedHistoryRuleId, setExpandedHistoryRuleId] = useState<string | null>(null);
  const [runsByRuleId, setRunsByRuleId] = useState<Record<string, AutomationRunView[]>>({});
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const dialogRef = useDialogFocusTrap<HTMLDivElement>(onClose);

  const entities = project.spec.entities;
  const [entityName, setEntityName] = useState(entities[0]?.name ?? "");
  const [trigger, setTrigger] = useState<AutomationTrigger>("record_created");
  const [fieldName, setFieldName] = useState("");
  const [fieldValue, setFieldValue] = useState("");
  const [toMode, setToMode] = useState<AutomationToMode>("field");
  const [toField, setToField] = useState("");
  const [toNumber, setToNumber] = useState("");
  const [messageTemplate, setMessageTemplate] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  // Non-null while the form below is editing an existing rule instead of
  // creating a new one -- the same form/fields are reused for both (the
  // server's own UpdateAutomationRuleSchema accepts every field
  // CreateAutomationRuleSchema does, bar entityName, which a PATCH can
  // never change). handleStartEdit seeds every field from the chosen
  // rule; handleSubmit below branches on this to call updateAutomationRule
  // instead of createAutomationRule.
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [scheduleTimeUtc, setScheduleTimeUtc] = useState("09:00");
  // All seven days selected is "every day" -- sent as undefined (the
  // server/storage convention for "no restriction", see automations.ts's
  // own scheduleDaysOfWeek doc comment) rather than a literal "0,1,2,3,4,5,6"
  // string, so the common case doesn't bloat every stored rule with a
  // redundant value meaning the same thing as leaving it unset.
  const [scheduleDays, setScheduleDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [actionType, setActionType] = useState<AutomationActionType>("send_whatsapp");
  const [webhookUrl, setWebhookUrl] = useState("");

  // A schedule rule has no triggering record at all, so there's nothing a
  // toMode:"field" destination could ever read from (the server rejects
  // this combination outright -- see CreateAutomationRuleSchema's own
  // refine). Forced the moment "schedule" is chosen, not just validated at
  // submit time, so the toMode selector doesn't dishonestly keep showing
  // "field" as a live option underneath.
  useEffect(() => {
    if (trigger === "schedule") setToMode("static");
  }, [trigger]);

  const selectedEntity: Entity | undefined = useMemo(
    () => entities.find((e) => e.name === entityName),
    [entities, entityName],
  );

  // Only text/longtext fields can ever hold a phone number -- mirrors the
  // server's own validateAutomationToField (apps/api/src/routes/projects.ts),
  // which rejects every other field type at creation/update time.
  const phoneFields = selectedEntity?.fields.filter((f) => f.type === "text" || f.type === "longtext") ?? [];

  const selectedField = selectedEntity?.fields.find((f) => f.name === fieldName);

  // Keep the field/toField selects pointed at a real field whenever the
  // chosen entity changes (including on first render) -- an empty/stale
  // selection here would otherwise submit a field name that doesn't exist
  // on the newly-chosen entity. toField is further restricted to
  // phoneFields, since the server rejects any other field type outright.
  useEffect(() => {
    if (!selectedEntity) return;
    if (!selectedEntity.fields.some((f) => f.name === fieldName)) {
      setFieldName(selectedEntity.fields[0]?.name ?? "");
    }
    if (!phoneFields.some((f) => f.name === toField)) {
      setToField(phoneFields[0]?.name ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityName]);

  // The "Value" control below renders a checkbox for a boolean field and a
  // <select> of enumValues for an enum field -- the same type-aware
  // controls FieldInput (EntityPanel.tsx) already uses, so the typed value
  // can only ever be one of the field's real, matchable options (the
  // server's own validateAutomationFieldValue, apps/api/src/routes/
  // projects.ts, rejects anything else at creation/update time regardless).
  // Whenever the selected field changes, point fieldValue at one of those
  // real options instead of carrying over unrelated free text left over
  // from a previously-selected field.
  useEffect(() => {
    if (selectedField?.type === "boolean" && fieldValue !== "true" && fieldValue !== "false") {
      setFieldValue("true");
    } else if (selectedField?.type === "enum") {
      const enumValues = uniqueEnumValues(selectedField.enumValues);
      if (!enumValues.includes(fieldValue)) {
        setFieldValue(enumValues[0] ?? "");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldName]);

  function loadRules() {
    setLoadError(null);
    listAutomationRules(projectId)
      .then(({ rules }) => setRules(rules))
      .catch((err) => setLoadError((err as Error).message));
  }

  useEffect(() => {
    loadRules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Fully resets the form back to fresh-create defaults for the project's
  // first entity, computed directly from `entities` rather than through
  // selectedEntity/phoneFields -- those are memoized off the *current*
  // entityName, which is still the stale value at the moment this runs, so
  // reading them here would seed fieldName/toField from the wrong entity.
  function resetToCreateMode() {
    const firstEntity = entities[0];
    const firstPhoneField = firstEntity?.fields.find((f) => f.type === "text" || f.type === "longtext");
    setEditingRuleId(null);
    setEntityName(firstEntity?.name ?? "");
    setTrigger("record_created");
    setFieldName(firstEntity?.fields[0]?.name ?? "");
    setFieldValue("");
    setToMode("field");
    setToField(firstPhoneField?.name ?? "");
    setToNumber("");
    setMessageTemplate("");
    setScheduleTimeUtc("09:00");
    setScheduleDays([0, 1, 2, 3, 4, 5, 6]);
    setActionType("send_whatsapp");
    setWebhookUrl("");
  }

  // Seeds every form field from an existing rule and switches the form
  // into edit mode -- entityName included, even though a PATCH can never
  // change it, so the entity-specific field/toField selects below render
  // the rule's own real entity instead of whatever the create-form
  // happened to be pointed at before Edit was clicked.
  function handleStartEdit(rule: AutomationRuleView) {
    setError(null);
    setEditingRuleId(rule.id);
    setEntityName(rule.entityName);
    setTrigger(rule.trigger);
    setFieldName(rule.fieldName ?? "");
    setFieldValue(rule.fieldValue ?? "");
    setScheduleTimeUtc(rule.scheduleTimeUtc ?? "09:00");
    setScheduleDays(rule.scheduleDaysOfWeek ? rule.scheduleDaysOfWeek.split(",").map(Number) : [0, 1, 2, 3, 4, 5, 6]);
    setActionType(rule.actionType);
    setToMode(rule.toMode);
    setToField(rule.toField ?? "");
    setToNumber(rule.toNumber ?? "");
    setWebhookUrl(rule.webhookUrl ?? "");
    setMessageTemplate(rule.messageTemplate);
  }

  /**
   * The single source of truth for whether Create/Save may actually be
   * submitted -- shared between handleSubmit's own early-return guard and
   * the submit button's `disabled` attribute below, so the two can never
   * drift apart again. Before this, the button's `disabled` only checked
   * `!messageTemplate.trim()` while handleSubmit's guard also required
   * fieldValue (for trigger "field_equals"), a schedule time/day (for
   * trigger "schedule"), a webhook URL (for actionType "webhook"), and a
   * phone field or number (for actionType "send_whatsapp") -- each of
   * those was added for a later trigger/action type without the button's
   * own disabled condition being extended to match. Create/Save stayed
   * clickable, enabled, with no spinner and no error, and simply did
   * nothing at all when clicked in any of those states -- the one feature
   * in this app that silently failed to save with zero feedback.
   */
  const formIncomplete =
    !selectedEntity ||
    !messageTemplate.trim() ||
    (trigger === "field_equals" && (!fieldName || !fieldValue.trim())) ||
    (trigger === "schedule" && (!scheduleTimeUtc || scheduleDays.length === 0)) ||
    (actionType === "webhook" && !webhookUrl.trim()) ||
    (actionType === "send_whatsapp" && toMode === "field" && !toField) ||
    (actionType === "send_whatsapp" && toMode === "static" && !toNumber.trim());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (formIncomplete || !selectedEntity) return;
    setCreateBusy(true);
    setError(null);
    const everyDay = scheduleDays.length === 7;
    try {
      if (editingRuleId) {
        // Every field the form currently represents is sent explicitly,
        // nulling out whichever of fieldName/fieldValue/schedule*/toField/
        // toNumber/webhookUrl no longer applies to the chosen trigger/
        // actionType/toMode -- otherwise a value from before the edit
        // (e.g. the old toNumber after switching toMode to "field") would
        // survive the PATCH's `{ ...existing, ...patch }` merge as stale
        // data, the same clear-what-no-longer-applies rule round 676's
        // field-type PATCH route already follows for enumValues/relationTo.
        const { rule } = await updateAutomationRule(projectId, editingRuleId, {
          trigger,
          fieldName: trigger === "field_equals" ? fieldName : null,
          fieldValue: trigger === "field_equals" ? fieldValue.trim() : null,
          scheduleTimeUtc: trigger === "schedule" ? scheduleTimeUtc : null,
          scheduleDaysOfWeek: trigger === "schedule" && !everyDay ? [...scheduleDays].sort().join(",") : null,
          actionType,
          toMode,
          toField: actionType === "send_whatsapp" && toMode === "field" ? toField : null,
          toNumber: actionType === "send_whatsapp" && toMode === "static" ? toNumber.trim() : null,
          webhookUrl: actionType === "webhook" ? webhookUrl.trim() : null,
          messageTemplate: messageTemplate.trim(),
        });
        setRules((prev) => (prev ?? []).map((r) => (r.id === rule.id ? rule : r)));
        resetToCreateMode();
      } else {
        const { rule } = await createAutomationRule(projectId, selectedEntity.name, {
          trigger,
          fieldName: trigger === "field_equals" ? fieldName : undefined,
          fieldValue: trigger === "field_equals" ? fieldValue.trim() : undefined,
          scheduleTimeUtc: trigger === "schedule" ? scheduleTimeUtc : undefined,
          scheduleDaysOfWeek: trigger === "schedule" && !everyDay ? [...scheduleDays].sort().join(",") : undefined,
          actionType,
          toMode,
          toField: actionType === "send_whatsapp" && toMode === "field" ? toField : undefined,
          toNumber: actionType === "send_whatsapp" && toMode === "static" ? toNumber.trim() : undefined,
          webhookUrl: actionType === "webhook" ? webhookUrl.trim() : undefined,
          messageTemplate: messageTemplate.trim(),
        });
        setRules((prev) => [...(prev ?? []), rule]);
        setFieldValue("");
        setToNumber("");
        setWebhookUrl("");
        setMessageTemplate("");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreateBusy(false);
    }
  }

  async function handleToggle(rule: AutomationRuleView) {
    setBusyRuleId(rule.id);
    setError(null);
    try {
      const { rule: updated } = await updateAutomationRule(projectId, rule.id, { enabled: !rule.enabled });
      setRules((prev) => (prev ?? []).map((r) => (r.id === rule.id ? updated : r)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyRuleId(null);
    }
  }

  async function handleDelete(rule: AutomationRuleView) {
    if (!window.confirm(t("automations.confirmDelete"))) return;
    setBusyRuleId(rule.id);
    setError(null);
    try {
      await deleteAutomationRule(projectId, rule.id);
      setRules((prev) => (prev ?? []).filter((r) => r.id !== rule.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyRuleId(null);
    }
  }

  // Resolves a rule's stored entityName/fieldName/toField/fieldValue (the
  // raw internal identifiers listRecords etc. also use) to the same
  // human-facing label this panel's own create-form selects already show
  // (entities.map's `e.label ?? e.name`, `selectedEntity.fields.map`'s
  // `f.label ?? f.name`) -- a Hebrew-labeled entity/field must not come
  // back from the server and then render in the rule list under its raw,
  // often-English internal name. Falls back to the raw identifier when the
  // entity/field can no longer be found (it was renamed or deleted after
  // the rule was created), matching label's own "falls back to name when
  // absent" convention in packages/shared.
  function ruleEntity(rule: AutomationRuleView): Entity | undefined {
    return entities.find((e) => e.name === rule.entityName);
  }

  function entityLabel(rule: AutomationRuleView): string {
    return ruleEntity(rule)?.label ?? rule.entityName;
  }

  function fieldLabel(rule: AutomationRuleView, fieldName: string | null): string {
    if (!fieldName) return "";
    const field = ruleEntity(rule)?.fields.find((f) => f.name === fieldName);
    return field?.label ?? fieldName;
  }

  // Mirrors apps/api/src/automations.ts's own interpolateTemplate, which
  // resolves an enum field's raw stored value to its enumLabels display
  // text the same way before sending the real WhatsApp message.
  function fieldValueLabel(rule: AutomationRuleView): string {
    if (!rule.fieldValue) return "";
    const field = ruleEntity(rule)?.fields.find((f) => f.name === rule.fieldName);
    if (field?.type === "enum") return field.enumLabels?.[rule.fieldValue] ?? rule.fieldValue;
    return rule.fieldValue;
  }

  // The short, locale-aware day-of-week label for a schedule rule's own
  // description -- mirrors Date.prototype.getUTCDay()'s 0=Sunday numbering,
  // the same one scheduleDaysOfWeek itself is stored/compared in
  // (apps/api/src/automations.ts's isScheduledRuleDue), via each day's own
  // translated name formatted through the real Intl API rather than a
  // hand-maintained array of seven more translation keys.
  function scheduleDayLabel(day: number): string {
    const reference = new Date(Date.UTC(2024, 0, 7 + day)); // a known Sunday-anchored week
    return new Intl.DateTimeFormat(LOCALE[lang], { weekday: "short", timeZone: "UTC" }).format(reference);
  }

  function describeSchedule(rule: AutomationRuleView): string {
    const days = rule.scheduleDaysOfWeek
      ? rule.scheduleDaysOfWeek.split(",").map(Number).sort().map(scheduleDayLabel).join(", ")
      : t("automations.schedule.everyDay");
    return t("automations.rule.when.schedule", { time: rule.scheduleTimeUtc ?? "", days });
  }

  function describeRule(rule: AutomationRuleView): string {
    if (rule.trigger === "record_created") return t("automations.rule.when.created", { entity: entityLabel(rule) });
    if (rule.trigger === "schedule") return describeSchedule(rule);
    return t("automations.rule.when.fieldEquals", {
      field: fieldLabel(rule, rule.fieldName),
      entity: entityLabel(rule),
      value: fieldValueLabel(rule),
    });
  }

  function describeDestination(rule: AutomationRuleView): string {
    if (rule.actionType === "webhook") {
      return t("automations.rule.callsWebhook", { url: rule.webhookUrl ?? "" });
    }
    const destination =
      rule.toMode === "field"
        ? t("automations.rule.sendsField", { field: fieldLabel(rule, rule.toField) })
        : t("automations.rule.sendsStatic", { number: rule.toNumber ?? "" });
    return t("automations.rule.sends", { destination });
  }

  function describeLastRun(rule: AutomationRuleView): string {
    if (!rule.lastTriggeredAt) return t("automations.lastRun.never");
    const time = new Date(rule.lastTriggeredAt).toLocaleString(LOCALE[lang]);
    return rule.lastStatus === "sent"
      ? t("automations.lastRun.sent", { time })
      : t("automations.lastRun.failed", { time, error: rule.lastError ?? "" });
  }

  function describeRunStatus(run: AutomationRunView): string {
    const time = new Date(run.triggeredAt).toLocaleString(LOCALE[lang]);
    return run.status === "sent" ? t("automations.lastRun.sent", { time }) : t("automations.lastRun.failed", { time, error: run.error ?? "" });
  }

  function handleToggleHistory(rule: AutomationRuleView) {
    if (expandedHistoryRuleId === rule.id) {
      setExpandedHistoryRuleId(null);
      return;
    }
    setExpandedHistoryRuleId(rule.id);
    setHistoryError(null);
    if (runsByRuleId[rule.id]) return;
    setHistoryLoading(true);
    listAutomationRuns(projectId, rule.id)
      .then(({ runs }) => setRunsByRuleId((prev) => ({ ...prev, [rule.id]: runs })))
      .catch((err) => setHistoryError((err as Error).message))
      .finally(() => setHistoryLoading(false));
  }

  function handleDownload() {
    downloadAutomationsReport(formatAutomationsReport(rules ?? [], entities, project.name, lang, t), project.name);
  }

  /**
   * Same "Copy report" companion action every other read-heavy diagnostic
   * panel in this app already has for its own Download button (Business
   * Twin, WhatsApp log, Time Machine, Global Search) -- Automations was
   * the one panel left with no way to take its rule list and last-run
   * outcomes anywhere at all.
   */
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(formatAutomationsReport(rules ?? [], entities, project.name, lang, t));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = setTimeout(() => setCopyStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  return (
    <div className="history-overlay">
      <div className="history-panel" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="automations-panel-title">
        <div className="history-header">
          <h2 id="automations-panel-title">{t("automations.title")}</h2>
          <div className="history-header-actions">
            {rules !== null && rules.length > 0 && (
              <button type="button" className="secondary" onClick={handleCopy} aria-live="polite" aria-atomic="true">
                {copyStatus === "copied"
                  ? t("automations.copy.copied")
                  : copyStatus === "failed"
                    ? t("automations.copy.failed")
                    : t("automations.copy")}
              </button>
            )}
            {rules !== null && rules.length > 0 && (
              <button type="button" className="secondary" onClick={handleDownload}>
                {t("automations.download")}
              </button>
            )}
            <button type="button" className="secondary" onClick={onClose}>
              {t("history.close")}
            </button>
          </div>
        </div>
        <p className="muted small">{t("automations.description")}</p>
        <p className="muted small automations-whatsapp-hint">{t("automations.whatsappRequired")}</p>

        {error && (
          <p className="error" role="status">
            {error}
          </p>
        )}
        {loadError && (
          <div className="error-retry-row">
            <p className="error" role="status">
              {loadError}
            </p>
            <button type="button" className="secondary small" onClick={loadRules}>
              {t("automations.retry")}
            </button>
          </div>
        )}

        {rules === null && !loadError ? (
          <p className="muted" role="status">
            {t("automations.loading")}
          </p>
        ) : (
          <>
            {rules !== null && rules.length === 0 && <p className="muted small">{t("automations.empty")}</p>}
            <ul className="automations-list">
              {rules?.map((rule) => (
                <li key={rule.id} className="automations-rule-row">
                  <div className="automations-rule-info">
                    <div className="automations-rule-condition">{describeRule(rule)}</div>
                    <div className="muted small">{describeDestination(rule)}</div>
                    <div className="muted small">{rule.messageTemplate}</div>
                    <div className="muted small">{describeLastRun(rule)}</div>
                  </div>
                  <div className="automations-rule-actions">
                    <span className={`chip ${rule.enabled ? "automations-chip-enabled" : "automations-chip-disabled"}`}>
                      {rule.enabled ? t("automations.status.enabled") : t("automations.status.disabled")}
                    </span>
                    {!readOnly && (
                      <>
                        <button type="button" className="secondary small" onClick={() => handleToggle(rule)} disabled={busyRuleId !== null}>
                          {rule.enabled ? t("automations.disable") : t("automations.enable")}
                        </button>
                        <button type="button" className="secondary small" onClick={() => handleStartEdit(rule)} disabled={busyRuleId !== null}>
                          {t("automations.edit")}
                        </button>
                        <button type="button" className="danger small" onClick={() => handleDelete(rule)} disabled={busyRuleId !== null}>
                          {t("automations.delete")}
                        </button>
                      </>
                    )}
                    {/* Placed last -- the existing enable/disable/edit/delete
                        buttons above are already relied on positionally by
                        this panel's own existing tests (".automations-rule-actions
                        button" picking the first one), so a new control must
                        never be inserted before them. */}
                    <button type="button" className="secondary small" onClick={() => handleToggleHistory(rule)}>
                      {expandedHistoryRuleId === rule.id ? t("automations.history.hide") : t("automations.history.show")}
                    </button>
                  </div>
                  {expandedHistoryRuleId === rule.id && (
                    <div className="automations-rule-history">
                      {historyLoading && !runsByRuleId[rule.id] ? (
                        <p className="muted small" role="status">
                          {t("automations.history.loading")}
                        </p>
                      ) : historyError ? (
                        <p className="error small" role="alert">
                          {historyError}
                        </p>
                      ) : (runsByRuleId[rule.id]?.length ?? 0) === 0 ? (
                        <p className="muted small">{t("automations.history.empty")}</p>
                      ) : (
                        <ul className="automations-rule-history-list">
                          {runsByRuleId[rule.id]!.map((run) => (
                            <li key={run.id} className="muted small">
                              {describeRunStatus(run)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {!readOnly && (
        <>
        <h3 className="automations-new-heading">{editingRuleId ? t("automations.editing.heading") : t("automations.new.heading")}</h3>
        <form className="automations-create-form" onSubmit={handleSubmit}>
          <label>
            {t("automations.entity.label")}
            <select value={entityName} onChange={(e) => setEntityName(e.target.value)} disabled={editingRuleId !== null}>
              {entities.map((e) => (
                <option key={e.name} value={e.name}>
                  {e.label ?? e.name}
                </option>
              ))}
            </select>
          </label>
          {editingRuleId !== null && <p className="muted small">{t("automations.entity.fixedWhileEditing")}</p>}

          <label>
            {t("automations.trigger.label")}
            <select value={trigger} onChange={(e) => setTrigger(e.target.value as AutomationTrigger)}>
              <option value="record_created">{t("automations.trigger.recordCreated")}</option>
              <option value="field_equals">{t("automations.trigger.fieldEquals")}</option>
              <option value="schedule">{t("automations.trigger.schedule")}</option>
            </select>
          </label>

          {trigger === "schedule" && (
            <>
              <label>
                {t("automations.schedule.time.label")}
                <input type="time" value={scheduleTimeUtc} onChange={(e) => setScheduleTimeUtc(e.target.value)} required />
              </label>
              <p className="muted small">{t("automations.schedule.time.hint")}</p>
              <fieldset className="automations-schedule-days">
                <legend>{t("automations.schedule.days.label")}</legend>
                {[0, 1, 2, 3, 4, 5, 6].map((day) => (
                  <label key={day} className="automations-schedule-day">
                    <input
                      type="checkbox"
                      checked={scheduleDays.includes(day)}
                      onChange={() =>
                        setScheduleDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]))
                      }
                    />
                    {scheduleDayLabel(day)}
                  </label>
                ))}
              </fieldset>
            </>
          )}

          {trigger === "field_equals" && selectedEntity && (
            <>
              <label>
                {t("automations.field.label")}
                <select value={fieldName} onChange={(e) => setFieldName(e.target.value)}>
                  {selectedEntity.fields.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.label ?? f.name}
                    </option>
                  ))}
                </select>
              </label>
              {selectedField?.type === "boolean" ? (
                <label className="automations-field-value-checkbox">
                  <input type="checkbox" checked={fieldValue === "true"} onChange={(e) => setFieldValue(e.target.checked ? "true" : "false")} />
                  {t("automations.fieldValue.booleanLabel")}
                </label>
              ) : selectedField?.type === "enum" ? (
                <select value={fieldValue} onChange={(e) => setFieldValue(e.target.value)} aria-label={t("automations.fieldValue.placeholder")}>
                  {uniqueEnumValues(selectedField.enumValues).map((v) => (
                    <option key={v} value={v}>
                      {selectedField!.enumLabels?.[v] ?? v}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  placeholder={t("automations.fieldValue.placeholder")}
                  aria-label={t("automations.fieldValue.placeholder")}
                  value={fieldValue}
                  onChange={(e) => setFieldValue(e.target.value)}
                />
              )}
            </>
          )}

          <label>
            {t("automations.actionType.label")}
            <select value={actionType} onChange={(e) => setActionType(e.target.value as AutomationActionType)}>
              <option value="send_whatsapp">{t("automations.actionType.sendWhatsapp")}</option>
              <option value="webhook">{t("automations.actionType.webhook")}</option>
            </select>
          </label>

          {actionType === "webhook" ? (
            <>
              <input
                type="url"
                placeholder={t("automations.webhookUrl.placeholder")}
                aria-label={t("automations.webhookUrl.placeholder")}
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
              />
              <p className="muted small">{t("automations.webhookUrl.hint")}</p>
            </>
          ) : (
            <>
              {trigger !== "schedule" && (
                <label>
                  {t("automations.toMode.label")}
                  <select value={toMode} onChange={(e) => setToMode(e.target.value as AutomationToMode)}>
                    <option value="field">{t("automations.toMode.field")}</option>
                    <option value="static">{t("automations.toMode.static")}</option>
                  </select>
                </label>
              )}

              {toMode === "field" && selectedEntity && phoneFields.length > 0 ? (
                <select value={toField} onChange={(e) => setToField(e.target.value)} aria-label={t("automations.toField.placeholder")}>
                  {phoneFields.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.label ?? f.name}
                    </option>
                  ))}
                </select>
              ) : toMode === "field" && selectedEntity ? (
                <p role="alert">{t("automations.toField.none")}</p>
              ) : (
                <input
                  type="text"
                  placeholder={t("automations.toNumber.placeholder")}
                  aria-label={t("automations.toNumber.placeholder")}
                  value={toNumber}
                  onChange={(e) => setToNumber(e.target.value)}
                />
              )}
            </>
          )}

          <label>
            {t("automations.messageTemplate.label")}
            <textarea
              rows={3}
              placeholder={t("automations.messageTemplate.placeholder")}
              value={messageTemplate}
              onChange={(e) => setMessageTemplate(e.target.value)}
            />
          </label>
          <p className="muted small">{t("automations.messageTemplate.hint")}</p>

          <div className="automations-form-actions">
            <button type="submit" disabled={createBusy || formIncomplete}>
              {editingRuleId
                ? createBusy
                  ? t("automations.save.busy")
                  : t("automations.save")
                : createBusy
                  ? t("automations.create.busy")
                  : t("automations.create")}
            </button>
            {editingRuleId !== null && (
              <button type="button" className="secondary" onClick={resetToCreateMode} disabled={createBusy}>
                {t("automations.cancelEdit")}
              </button>
            )}
          </div>
        </form>
        </>
        )}
      </div>
    </div>
  );
}
