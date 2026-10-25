import { useEffect, useMemo, useState } from "react";
import type { Entity, EntityRecord, Project } from "@forge/shared";
import {
  createAutomationRule,
  deleteAutomationRule,
  listAutomationRules,
  listAutomationRuns,
  listRecords,
  retryAutomationRun,
  updateAutomationRule,
  KNOWN_WHATSAPP_SEND_ERROR_CODES,
  type AutomationActionType,
  type AutomationRuleView,
  type AutomationRunView,
  type AutomationToMode,
  type AutomationTrigger,
} from "./api.js";
import { downloadAutomationsReport, formatAutomationsReport } from "./automationsReport.js";
import { applyColumnOrder, getColumnOrder } from "./columnOrder.js";
import { fieldDisplayLabel, fieldLabelOccurrences, parseFieldDate, recordDisplayLabel, uniqueEnumValues, type RelatedRecordsByEntity } from "./entityFormatting.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { resolveErrorMessage } from "./i18n/language.js";
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
  // Defaults to project.spec.entities' own declared/build order for
  // backward compatibility with every existing caller/test that doesn't
  // pass this -- App.tsx's real call site passes its own orderedEntities
  // (entityTabOrder.ts's persisted drag/keyboard-reordered tab order) the
  // same way it already does for GlobalSearchPanel (round 713). Without
  // this, the "Create automation rule" form's entity dropdown always
  // listed entities in build order, ignoring a user's own deliberate
  // reorder of their entity tabs -- the same "orderedFields-respecting
  // surface" convention every field-order-sensitive picker in this app
  // (filter dropdowns, group-by, bulk-edit, CSV/ICS export) already
  // follows for field order, just never extended to this entity-order
  // case until now.
  entities = project.spec.entities,
  onClose,
  readOnly = false,
}: {
  projectId: string;
  project: Project;
  entities?: Entity[];
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
  // Round 922: keyed per rule id, mirroring runsByRuleId right above --
  // these used to be single, panel-wide values shared across every rule's
  // own history fetch. Expanding rule A's history (fetch in flight), then
  // switching to rule B's before A's settles, let A's fetch's own
  // .catch/.finally write into the SAME shared slot B's row was now
  // reading: B's panel could show A's unrelated error message (and never
  // clear it, since a successful fetch never reset historyError), or
  // briefly flash B's "no runs yet" empty state when A's .finally fired
  // while B's own fetch was still pending.
  const [historyErrorByRuleId, setHistoryErrorByRuleId] = useState<Record<string, string>>({});
  const [loadingHistoryRuleIds, setLoadingHistoryRuleIds] = useState<Record<string, boolean>>({});
  // Round 971: which single run (by its own id, unique across every rule)
  // is currently being retried, and any error from that run's own last
  // retry attempt -- keyed per run, not per rule, since a rule's History
  // list can show several failed runs at once and retrying one must never
  // disable or show a stale error for a sibling run's own Retry button.
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);
  const [retryErrorByRunId, setRetryErrorByRunId] = useState<Record<string, string>>({});
  const dialogRef = useDialogFocusTrap<HTMLDivElement>(onClose);

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
  // Round 967: the real IANA timezone scheduleTimeUtc/scheduleDays are
  // wall-clock values in -- defaults to the browser's own detected zone
  // for a brand-new rule, so "Create automation rule" now schedules in
  // the user's own local time/day by default instead of silently meaning
  // UTC. Overwritten by handleStartEdit with the rule's own stored zone
  // when editing an existing one (see its own comment there for why this
  // is NOT re-defaulted to the browser's zone on edit).
  const [scheduleTimezone, setScheduleTimezone] = useState<string>(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [actionType, setActionType] = useState<AutomationActionType>("send_whatsapp");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

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

  // Mirrors EntityPanel.tsx's own fieldTypesKey (rounds 780/781/800/805) --
  // this panel is mounted once per showAutomations toggle and keeps
  // receiving the live `entities` prop straight from App.tsx's own
  // `project` state, so it never remounts when a background Refine
  // finishes. A field's NAME surviving a retype is exactly what the three
  // effects below already rely on to keep pointed at "the same field", but
  // none of them were keyed on the field's own TYPE -- only on entityName
  // or fieldName (the name, not the type). Added to those effects' own
  // dependency arrays below.
  const fieldTypesKey = useMemo(
    () => (selectedEntity ? selectedEntity.fields.map((f) => `${f.name}:${f.type}`).join(",") : ""),
    [selectedEntity],
  );

  // A Refine can also narrow, widen, or rename an enum field's own options
  // while the field keeps the exact same name AND type ("enum" -> "enum")
  // -- fieldTypesKey alone doesn't notice, since neither of those changed.
  // EntityPanel.tsx hit this same gap for its own fieldFilters state in
  // round 882 (fieldEnumCountsKey there). Joins the full option list, not
  // just its length, so a same-count rename (e.g. "InProgress" -> "Active")
  // is caught too, not just a widen/narrow.
  const fieldEnumValuesKey = useMemo(
    () => (selectedEntity ? selectedEntity.fields.map((f) => `${f.name}:${f.type === "enum" ? uniqueEnumValues(f.enumValues).join("|") : ""}`).join(",") : ""),
    [selectedEntity],
  );

  // The user's own drag-reordered column order (EntityPanel.tsx's table)
  // is the layout they see as their real field order everywhere else in
  // the app (bulk-edit, filters, CSV export, both Print sheets) -- without
  // this, every dropdown below would silently fall back to the entity's
  // raw declared/build order instead.
  const orderedSelectedEntityFields = useMemo(
    () => (selectedEntity ? applyColumnOrder(selectedEntity.fields, getColumnOrder(projectId, selectedEntity.name)) : []),
    [selectedEntity, projectId],
  );

  // Two fields on the same entity can legally share a label (the Field
  // Label editor doesn't enforce uniqueness) -- mirrors every other
  // field-selection surface in this app (EntityPanel.tsx's bulk-edit/filter
  // pickers, both Print sheets, CSV export), all of which disambiguate via
  // fieldDisplayLabel instead of rendering the bare, possibly-colliding
  // label.
  const selectedEntityFieldOccurrences = useMemo(
    () => fieldLabelOccurrences(selectedEntity?.fields ?? []),
    [selectedEntity],
  );

  // Only text/longtext fields can ever hold a phone number -- mirrors the
  // server's own validateAutomationToField (apps/api/src/routes/projects.ts),
  // which rejects every other field type at creation/update time.
  const phoneFields = orderedSelectedEntityFields.filter((f) => f.type === "text" || f.type === "longtext");

  // A file field's stored value is the raw upload JSON descriptor, never
  // something a person could type into the Value box below -- mirrors the
  // server's own validateAutomationFieldValue, which rejects it at
  // creation/update time for exactly that reason. Without this filter the
  // field dropdown would still offer it, saving a rule that can now only
  // ever fail with a 400 the user never asked for.
  const triggerableFields = orderedSelectedEntityFields.filter((f) => f.type !== "file");

  const selectedField = selectedEntity?.fields.find((f) => f.name === fieldName);

  // Keep the field/toField selects pointed at a real field whenever the
  // chosen entity changes (including on first render) -- an empty/stale
  // selection here would otherwise submit a field name that doesn't exist
  // on the newly-chosen entity. fieldName is further restricted to
  // triggerableFields and toField to phoneFields, since the server rejects
  // any other field type outright in each case.
  useEffect(() => {
    if (!selectedEntity) return;
    if (!triggerableFields.some((f) => f.name === fieldName)) {
      setFieldName(triggerableFields[0]?.name ?? "");
    }
    if (!phoneFields.some((f) => f.name === toField)) {
      setToField(phoneFields[0]?.name ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityName, fieldTypesKey]);

  // The "Value" control below renders a checkbox for a boolean field and a
  // <select> of enumValues for an enum field -- the same type-aware
  // controls FieldInput (EntityPanel.tsx) already uses, so the typed value
  // can only ever be one of the field's real, matchable options (the
  // server's own validateAutomationFieldValue, apps/api/src/routes/
  // projects.ts, rejects anything else at creation/update time regardless).
  // Whenever the selected field changes, point fieldValue at one of those
  // real options instead of carrying over unrelated free text left over
  // from a previously-selected field. Also keyed on fieldTypesKey, not
  // just fieldName: a Refine can retype the SAME still-selected field (its
  // name survives, e.g. enum -> boolean) while this panel stays mounted --
  // the checkbox below would otherwise render correctly-unchecked
  // (`fieldValue === "true"` is false for a stale leftover string like
  // "High"), masking that fieldValue itself is still that stale string,
  // which handleSubmit then sends straight to the server as a boolean
  // field's value.
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
  }, [fieldName, fieldTypesKey, fieldEnumValuesKey]);

  // The "Value" control's relation branch (below) needs the target
  // entity's own records loaded, to render a real picker instead of
  // forcing the user to type the related record's raw, never-shown
  // internal id by hand -- the server's own validateAutomationFieldValue
  // (apps/api/src/routes/projects.ts) accepts only that bare id, which no
  // other UI surface in this app ever shows (every other relation render
  // -- EntityPanel.tsx, table cells, CSV export -- uses relationDisplayLabel
  // instead). The same records are also needed to resolve an *existing*
  // rule's own stored id back to a label in the rule list/report below,
  // so this fetches for every relation-type field referenced by any rule,
  // not just the form's currently-selected one.
  const [relatedRecords, setRelatedRecords] = useState<RelatedRecordsByEntity>({});
  const relationTargetEntity =
    selectedField?.type === "relation" && selectedField.relationTo
      ? entities.find((e) => e.name === selectedField.relationTo)
      : undefined;
  const relationTargetRecords = relationTargetEntity ? relatedRecords[relationTargetEntity.name] : undefined;

  const relationFieldTargets = useMemo(() => {
    const names = new Set<string>();
    if (relationTargetEntity) names.add(relationTargetEntity.name);
    for (const rule of rules ?? []) {
      const ruleFieldEntity = entities.find((e) => e.name === rule.entityName);
      const field = ruleFieldEntity?.fields.find((f) => f.name === rule.fieldName);
      if (field?.type === "relation" && field.relationTo) names.add(field.relationTo);
    }
    return [...names].filter((name) => entities.some((e) => e.name === name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relationTargetEntity, rules, entities]);

  useEffect(() => {
    let cancelled = false;
    const missing = relationFieldTargets.filter((name) => !(name in relatedRecords));
    if (missing.length === 0) return;
    (async () => {
      const entries = await Promise.all(
        missing.map(async (name) => {
          try {
            const { records } = await listRecords(projectId, name);
            return [name, records] as const;
          } catch {
            return [name, []] as const;
          }
        }),
      );
      if (!cancelled) {
        setRelatedRecords((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [relationFieldTargets, relatedRecords, projectId]);

  // Mirrors the boolean/enum branches above, once relationTargetRecords
  // actually finishes loading (it starts out undefined, so this can't
  // just run alongside the [fieldName]-keyed effect above). Also keyed on
  // fieldTypesKey for the same live-refine reason as that effect -- a
  // field retyping INTO relation while its name survives needs this reset
  // too, not just a fieldName change.
  useEffect(() => {
    if (selectedField?.type !== "relation" || !relationTargetRecords) return;
    if (!relationTargetRecords.some((r) => String(r.id) === fieldValue)) {
      setFieldValue(relationTargetRecords[0] ? String(relationTargetRecords[0].id) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldName, fieldTypesKey, relationTargetRecords]);

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
    const firstTriggerableField = firstEntity?.fields.find((f) => f.type !== "file");
    setEditingRuleId(null);
    setEntityName(firstEntity?.name ?? "");
    setTrigger("record_created");
    setFieldName(firstTriggerableField?.name ?? "");
    setFieldValue("");
    setToMode("field");
    setToField(firstPhoneField?.name ?? "");
    setToNumber("");
    setMessageTemplate("");
    setScheduleTimeUtc("09:00");
    setScheduleDays([0, 1, 2, 3, 4, 5, 6]);
    setScheduleTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    setActionType("send_whatsapp");
    setWebhookUrl("");
    setWebhookSecret("");
  }

  // Seeds every form field from an existing rule and switches the form
  // into edit mode -- entityName included, even though a PATCH can never
  // change it, so the entity-specific field/toField selects below render
  // the rule's own real entity instead of whatever the create-form
  // happened to be pointed at before Edit was clicked.
  //
  // Round 883: fieldName/toField used to be seeded straight from the
  // stored rule with no validation against that entity's CURRENT fields.
  // disableAutomationRulesForField (packages/db/src/automations.ts)
  // deliberately disables a rule when its field is removed but leaves
  // fieldName/toField as the now-stale string in storage (for
  // restore-safety, per its own doc comment) -- the rule LIST already
  // handles this gracefully (fieldLabel's fallback to the raw name), but
  // this edit-seeding path had no equivalent guard. The effect just above
  // (lines ~179-188) exists for exactly this kind of staleness, but it's
  // keyed on [entityName, fieldTypesKey] -- it only reruns when the
  // SELECTED entity changes or a field retypes while mounted, never
  // merely because this function just set fieldName/toField to a value
  // that happens to be invalid for an entityName that was ALREADY
  // selected (editing two rules on the same entity back to back, or the
  // very first edit when that entity already defaults to entities[0]).
  // Validated directly here against the rule's own target entity's
  // current fields (not `selectedEntity`, which still reflects whatever
  // entity was selected before this call) -- the same fallback-to-first
  // field behavior as that effect, rather than a blank fallback, so a
  // stale value never gets to render as if it were still a valid pick.
  function handleStartEdit(rule: AutomationRuleView) {
    setError(null);
    setEditingRuleId(rule.id);
    setEntityName(rule.entityName);
    setTrigger(rule.trigger);
    const ruleEntityFields = entities.find((e) => e.name === rule.entityName)?.fields ?? [];
    const ruleTriggerableFields = ruleEntityFields.filter((f) => f.type !== "file");
    const rulePhoneFields = ruleEntityFields.filter((f) => f.type === "text" || f.type === "longtext");
    setFieldName(
      ruleTriggerableFields.some((f) => f.name === rule.fieldName) ? rule.fieldName ?? "" : ruleTriggerableFields[0]?.name ?? "",
    );
    setFieldValue(rule.fieldValue ?? "");
    setScheduleTimeUtc(rule.scheduleTimeUtc ?? "09:00");
    setScheduleDays(rule.scheduleDaysOfWeek ? rule.scheduleDaysOfWeek.split(",").map(Number) : [0, 1, 2, 3, 4, 5, 6]);
    // Shows (and, if saved unchanged, keeps) the rule's OWN stored zone --
    // never re-defaulted to the browser's own zone here. A rule created by
    // a different collaborator, or before this column existed at all
    // ("UTC" shown for a pre-round-967 rule, matching its real stored
    // meaning), must not silently start meaning "whichever computer last
    // opened the edit form" the moment anyone edits an unrelated field.
    setScheduleTimezone(rule.scheduleTimezone ?? "UTC");
    setActionType(rule.actionType);
    setToMode(rule.toMode);
    setToField(rulePhoneFields.some((f) => f.name === rule.toField) ? rule.toField ?? "" : rulePhoneFields[0]?.name ?? "");
    setToNumber(rule.toNumber ?? "");
    setWebhookUrl(rule.webhookUrl ?? "");
    setWebhookSecret(rule.webhookSecret ?? "");
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
          scheduleTimezone: trigger === "schedule" ? scheduleTimezone : null,
          actionType,
          toMode,
          toField: actionType === "send_whatsapp" && toMode === "field" ? toField : null,
          toNumber: actionType === "send_whatsapp" && toMode === "static" ? toNumber.trim() : null,
          webhookUrl: actionType === "webhook" ? webhookUrl.trim() : null,
          webhookSecret: actionType === "webhook" ? webhookSecret.trim() || null : null,
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
          scheduleTimezone: trigger === "schedule" ? scheduleTimezone : undefined,
          actionType,
          toMode,
          toField: actionType === "send_whatsapp" && toMode === "field" ? toField : undefined,
          toNumber: actionType === "send_whatsapp" && toMode === "static" ? toNumber.trim() : undefined,
          webhookUrl: actionType === "webhook" ? webhookUrl.trim() : undefined,
          webhookSecret: actionType === "webhook" ? webhookSecret.trim() || undefined : undefined,
          messageTemplate: messageTemplate.trim(),
        });
        setRules((prev) => [...(prev ?? []), rule]);
        setFieldValue("");
        setToNumber("");
        setWebhookUrl("");
        setWebhookSecret("");
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
      // The rule list's own Delete button stays clickable on every row
      // regardless of which one (if any) is currently open for editing
      // below -- without this, deleting the exact rule the form is mid-edit
      // on left editingRuleId pointing at an id that no longer exists on
      // the server. The form kept showing "Editing automation rule",
      // pre-filled with the now-deleted rule's stale data and a visible
      // Save button, with nothing on screen signalling that saving was
      // already impossible -- clicking it hit a confusing 404
      // AUTOMATION_RULE_NOT_FOUND with no way out except Cancel. Mirrors
      // EntityPanel.tsx's own identical "delete the record currently being
      // edited" guard (its in-form Delete button only resets editingId
      // once the delete actually went through).
      if (editingRuleId === rule.id) resetToCreateMode();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyRuleId(null);
    }
  }

  // Two entities can legally share a label too (the Entity Label editor
  // doesn't enforce uniqueness any more than the Field Label editor does
  // -- routes/projects.ts's PATCH /entities/:entityName/label accepts any
  // non-empty string with no collision check against sibling entities).
  // Mirrors (rather than imports, matching this codebase's established
  // per-surface convention -- see checkpointDiff.ts's own identical pair,
  // itself mirroring pipeline.ts's) the entity-level twin of
  // fieldLabelOccurrences/fieldDisplayLabel above. Without this, the
  // entity <select> below rendered two visually-identical <option> rows
  // with no way to tell which same-labeled entity a given one actually
  // is, and describeRule's own rule-list text gave zero way to tell which
  // of two same-labeled entities an EXISTING rule actually targets --
  // directly undermining the one thing this panel exists for (reviewing
  // which rule does what).
  function entityLabelOccurrences(allEntities: Entity[]): Map<string, number> {
    const occurrences = new Map<string, number>();
    for (const e of allEntities) {
      const label = e.label ?? e.name;
      occurrences.set(label, (occurrences.get(label) ?? 0) + 1);
    }
    return occurrences;
  }

  function entityDisplayLabel(entity: Entity, occurrences: Map<string, number>): string {
    const label = entity.label ?? entity.name;
    return (occurrences.get(label) ?? 0) > 1 ? `${label} (${entity.name})` : label;
  }

  const entityOccurrences = useMemo(() => entityLabelOccurrences(entities), [entities]);

  // Resolves a rule's stored entityName/fieldName/toField/fieldValue (the
  // raw internal identifiers listRecords etc. also use) to the same
  // human-facing, disambiguated label this panel's own create-form selects
  // already show (entityDisplayLabel for entities, fieldDisplayLabel for
  // fields) -- a Hebrew-labeled entity/field must not come back from
  // the server and then render in the rule list under its raw,
  // often-English internal name. Falls back to the raw identifier when the
  // entity/field can no longer be found (it was renamed or deleted after
  // the rule was created), matching label's own "falls back to name when
  // absent" convention in packages/shared.
  function ruleEntity(rule: AutomationRuleView): Entity | undefined {
    return entities.find((e) => e.name === rule.entityName);
  }

  function entityLabel(rule: AutomationRuleView): string {
    const entity = ruleEntity(rule);
    return entity ? entityDisplayLabel(entity, entityOccurrences) : rule.entityName;
  }

  function fieldLabel(rule: AutomationRuleView, fieldName: string | null): string {
    if (!fieldName) return "";
    const ruleFields = ruleEntity(rule)?.fields ?? [];
    const field = ruleFields.find((f) => f.name === fieldName);
    if (!field) return fieldName;
    return fieldDisplayLabel(field, fieldLabelOccurrences(ruleFields));
  }

  // Mirrors apps/api/src/automations.ts's own interpolateTemplate, which
  // resolves an enum field's raw stored value to its enumLabels display
  // text the same way before sending the real WhatsApp message. A
  // relation field's stored value is the related record's raw id -- the
  // same "degrade to the bare id when the target/records aren't
  // available" fallback relationDisplayLabel itself uses (relatedRecords
  // may not have finished loading, or the related record may have since
  // been deleted), rather than ever showing nothing at all. date/number
  // mirror interpolateTemplate's own date/number branches too -- without
  // these, a date field_equals rule's raw stored "2024-01-15" showed as
  // that literal ISO string in the rule list and Copy/Download report,
  // instead of the locale-formatted date every other date display in this
  // app (table cells, this same rule's own outgoing WhatsApp message) uses.
  // boolean mirrors interpolateTemplate's own uppercase "TRUE"/"FALSE"
  // convention too (also used by entityFormatting.ts's fieldDisplayValue,
  // backup.ts's CSV export, and calendarIcs.ts) -- the create-form's own
  // checkbox stores the raw lowercase string "true"/"false" as fieldValue,
  // which without this branch showed inconsistently lowercase here, the
  // one display surface in the app that didn't follow this convention.
  function fieldValueLabel(rule: AutomationRuleView): string {
    if (!rule.fieldValue) return "";
    const field = ruleEntity(rule)?.fields.find((f) => f.name === rule.fieldName);
    if (field?.type === "enum") return field.enumLabels?.[rule.fieldValue] ?? rule.fieldValue;
    if (field?.type === "relation" && field.relationTo) {
      const targetEntity = entities.find((e) => e.name === field.relationTo);
      const records = relatedRecords[field.relationTo];
      const match = targetEntity && records ? records.find((r) => String(r.id) === rule.fieldValue) : undefined;
      return match && targetEntity ? recordDisplayLabel(targetEntity, match) : rule.fieldValue;
    }
    if (field?.type === "date") {
      const date = parseFieldDate(rule.fieldValue);
      return Number.isNaN(date.getTime()) ? rule.fieldValue : date.toLocaleDateString(LOCALE[lang]);
    }
    if (field?.type === "number") return Number(rule.fieldValue).toLocaleString(LOCALE[lang]);
    if (field?.type === "boolean") return rule.fieldValue === "true" ? "TRUE" : "FALSE";
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
    return t("automations.rule.when.schedule", { time: rule.scheduleTimeUtc ?? "", days, timezone: rule.scheduleTimezone ?? "UTC" });
  }

  function describeRule(rule: AutomationRuleView): string {
    if (rule.trigger === "record_created") return t("automations.rule.when.created", { entity: entityLabel(rule) });
    if (rule.trigger === "record_deleted") return t("automations.rule.when.deleted", { entity: entityLabel(rule) });
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

  // Round 935: apps/api/src/automations.ts stores a `send_whatsapp`
  // rule's failed-run error as the exact stable snake_case code
  // whatsappWeb.ts's sendMessage returns ("missing_country_code" is the
  // COMMON case for a toMode:"field" rule reading a locally-formatted
  // phone field, per that file's own doc comment) -- never translated,
  // by design, since that's a client concern. api.ts's own
  // sendWhatsAppMessage (the manual "Send WhatsApp" panel) already
  // translates these same three codes via the `error.WHATSAPP_SEND_<CODE>`
  // i18n keys; this panel's own run-history/last-run text never did,
  // leaking the bare English code into this Hebrew-primary app's UI with
  // no actionable guidance. A webhook rule's error is passed through
  // unchanged, same as before.
  function translateAutomationError(actionType: AutomationActionType, error: string): string {
    if (actionType === "send_whatsapp" && KNOWN_WHATSAPP_SEND_ERROR_CODES.has(error)) {
      return resolveErrorMessage(lang, { code: `WHATSAPP_SEND_${error.toUpperCase()}`, error });
    }
    return error;
  }

  // Round 948: a rule's actionType can be edited after it last fired
  // (UpdateAutomationRuleSchema/updateAutomationRule never touch
  // lastTriggeredAt/lastStatus/lastError) -- using the rule's CURRENT
  // actionType to translate a stale lastError meant switching a rule from
  // send_whatsapp to webhook (or back) made its old, already-stored
  // WhatsApp error code render raw/untranslated again, the exact
  // regression round 935 closed, just reopened via an edit instead of a
  // fresh failure. lastActionType is the actionType snapshotted at the
  // moment lastError was actually written (recordAutomationRun,
  // packages/db/src/automations.ts) -- falls back to the rule's own
  // current actionType only for a legacy row recorded before that column
  // existed, where no better information is available.
  function describeLastRun(rule: AutomationRuleView): string {
    if (!rule.lastTriggeredAt) return t("automations.lastRun.never");
    const time = new Date(rule.lastTriggeredAt).toLocaleString(LOCALE[lang]);
    return rule.lastStatus === "sent"
      ? t("automations.lastRun.sent", { time })
      : t("automations.lastRun.failed", {
          time,
          error: translateAutomationError(rule.lastActionType ?? rule.actionType, rule.lastError ?? ""),
        });
  }

  // Round 948: same reasoning as describeLastRun above, but for every
  // individual historical run in the "History" list -- each run's OWN
  // actionType (snapshotted when it fired) must be used, not the rule's
  // current one, or editing a rule's actionType once would make every
  // past send_whatsapp failure in its history render raw/untranslated too,
  // not just the newest one.
  function describeRunStatus(run: AutomationRunView, ruleActionType: AutomationActionType): string {
    const time = new Date(run.triggeredAt).toLocaleString(LOCALE[lang]);
    return run.status === "sent"
      ? t("automations.lastRun.sent", { time })
      : t("automations.lastRun.failed", { time, error: translateAutomationError(run.actionType ?? ruleActionType, run.error ?? "") });
  }

  function handleToggleHistory(rule: AutomationRuleView) {
    if (expandedHistoryRuleId === rule.id) {
      setExpandedHistoryRuleId(null);
      return;
    }
    setExpandedHistoryRuleId(rule.id);
    setHistoryErrorByRuleId((prev) => {
      if (!(rule.id in prev)) return prev;
      const next = { ...prev };
      delete next[rule.id];
      return next;
    });
    if (runsByRuleId[rule.id]) return;
    setLoadingHistoryRuleIds((prev) => ({ ...prev, [rule.id]: true }));
    listAutomationRuns(projectId, rule.id)
      .then(({ runs }) => setRunsByRuleId((prev) => ({ ...prev, [rule.id]: runs })))
      .catch((err) => setHistoryErrorByRuleId((prev) => ({ ...prev, [rule.id]: (err as Error).message })))
      .finally(() =>
        setLoadingHistoryRuleIds((prev) => {
          const next = { ...prev };
          delete next[rule.id];
          return next;
        }),
      );
  }

  /**
   * Round 971: re-fires a specific failed run against its record's
   * current state, then re-fetches the full run list so the newly-
   * created run (the retry itself is recorded as its own new row, never
   * overwriting the one being retried) shows up immediately -- the same
   * "just re-fetch the list" approach handleToggleHistory's own initial
   * load already uses, rather than trying to splice one new row into
   * runsByRuleId by hand.
   */
  function handleRetryRun(rule: AutomationRuleView, run: AutomationRunView) {
    setRetryingRunId(run.id);
    setRetryErrorByRunId((prev) => {
      if (!(run.id in prev)) return prev;
      const next = { ...prev };
      delete next[run.id];
      return next;
    });
    retryAutomationRun(projectId, rule.id, run.id)
      .then(() => listAutomationRuns(projectId, rule.id))
      .then(({ runs }) => setRunsByRuleId((prev) => ({ ...prev, [rule.id]: runs })))
      .catch((err) => setRetryErrorByRunId((prev) => ({ ...prev, [run.id]: (err as Error).message })))
      .finally(() => setRetryingRunId((current) => (current === run.id ? null : current)));
  }

  function handleDownload() {
    downloadAutomationsReport(formatAutomationsReport(rules ?? [], entities, project.name, lang, t, relatedRecords), project.name);
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
      await navigator.clipboard.writeText(formatAutomationsReport(rules ?? [], entities, project.name, lang, t, relatedRecords));
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
                    {/* Round 959: hasTooManyConsecutiveFailuresToday's own cap (automations.ts,
                        rounds 924/934/951) was always computed and acted on server-side, but
                        never shown -- the enabled chip just above stays green the whole time the
                        scheduler has actually stopped retrying this rule for the rest of today,
                        with nothing distinguishing "still retrying every minute" from "gave up
                        until tomorrow's UTC rollover". */}
                    {rule.pausedForToday && (
                      <span className="chip automations-chip-paused" title={t("automations.status.pausedForToday.title")}>
                        {t("automations.status.pausedForToday")}
                      </span>
                    )}
                    {!readOnly && (
                      <>
                        {/* Also disabled by createBusy (round 831), not just busyRuleId -- the
                            form's own Save/Create submission has no idea, once it resolves,
                            whether editingRuleId still points at the same rule it started with.
                            Without this, clicking Edit on a different rule while an earlier
                            Save/Create was still in flight silently overwrote that in-progress
                            edit's own data the moment the original submission's unconditional
                            resetToCreateMode()/field-clearing code ran -- the same mutual-exclusion
                            busyRuleId already enforces for toggle/delete, just never extended to
                            the form's own in-flight submission. */}
                        <button type="button" className="secondary small" onClick={() => handleToggle(rule)} disabled={busyRuleId !== null || createBusy}>
                          {rule.enabled ? t("automations.disable") : t("automations.enable")}
                        </button>
                        <button type="button" className="secondary small" onClick={() => handleStartEdit(rule)} disabled={busyRuleId !== null || createBusy}>
                          {t("automations.edit")}
                        </button>
                        <button type="button" className="danger small" onClick={() => handleDelete(rule)} disabled={busyRuleId !== null || createBusy}>
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
                      {loadingHistoryRuleIds[rule.id] && !runsByRuleId[rule.id] ? (
                        <p className="muted small" role="status">
                          {t("automations.history.loading")}
                        </p>
                      ) : historyErrorByRuleId[rule.id] ? (
                        <p className="error small" role="alert">
                          {historyErrorByRuleId[rule.id]}
                        </p>
                      ) : (runsByRuleId[rule.id]?.length ?? 0) === 0 ? (
                        <p className="muted small">{t("automations.history.empty")}</p>
                      ) : (
                        <ul className="automations-rule-history-list">
                          {runsByRuleId[rule.id]!.map((run) => (
                            <li key={run.id} className="muted small">
                              {describeRunStatus(run, rule.actionType)}
                              {/* A failed run can be retried when it carries a
                                  recordId (a record-triggered rule's own run,
                                  record_deleted included -- round 991: the
                                  server now replays a record_deleted run's
                                  own saved snapshot instead of re-fetching a
                                  record that's guaranteed gone, so this
                                  button isn't a dead end for that trigger
                                  the way it used to be), OR when the rule
                                  itself is "schedule" -- round 972: a
                                  schedule rule's run never has a recordId at
                                  all (there's no triggering record), but once
                                  hasTooManyConsecutiveFailuresToday has
                                  tripped, the automatic per-tick retry this
                                  panel used to rely on stops running for the
                                  rest of the day with no other way to clear
                                  it -- the server's own retry route now
                                  re-fires a schedule rule's failed run
                                  directly for exactly this case. Hidden
                                  entirely in readOnly mode, same as this
                                  panel's other write actions
                                  (enable/disable/edit/delete). */}
                              {!readOnly && run.status === "failed" && (run.recordId !== null || rule.trigger === "schedule") && (
                                <>
                                  {" "}
                                  <button
                                    type="button"
                                    className="link-button small"
                                    onClick={() => handleRetryRun(rule, run)}
                                    disabled={retryingRunId === run.id}
                                  >
                                    {retryingRunId === run.id ? t("automations.run.retrying") : t("automations.run.retry")}
                                  </button>
                                </>
                              )}
                              {retryErrorByRunId[run.id] && (
                                <p className="error small" role="alert">
                                  {retryErrorByRunId[run.id]}
                                </p>
                              )}
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
                  {entityDisplayLabel(e, entityOccurrences)}
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
              <option value="record_deleted">{t("automations.trigger.recordDeleted")}</option>
            </select>
          </label>

          {trigger === "schedule" && (
            <>
              <label>
                {t("automations.schedule.time.label")}
                <input type="time" value={scheduleTimeUtc} onChange={(e) => setScheduleTimeUtc(e.target.value)} required />
              </label>
              <p className="muted small">{t("automations.schedule.time.hint", { timezone: scheduleTimezone })}</p>
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
                  {triggerableFields.map((f) => (
                    <option key={f.name} value={f.name}>
                      {fieldDisplayLabel(f, selectedEntityFieldOccurrences)}
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
              ) : relationTargetEntity ? (
                relationTargetRecords ? (
                  <select value={fieldValue} onChange={(e) => setFieldValue(e.target.value)} aria-label={t("automations.fieldValue.placeholder")}>
                    {relationTargetRecords.map((r) => (
                      <option key={r.id as number} value={String(r.id)}>
                        {recordDisplayLabel(relationTargetEntity, r)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select disabled aria-label={t("automations.fieldValue.placeholder")}>
                    <option>{t("entity.relation.loading")}</option>
                  </select>
                )
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
              <input
                type="text"
                placeholder={t("automations.webhookSecret.placeholder")}
                aria-label={t("automations.webhookSecret.placeholder")}
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
              />
              <p className="muted small">{t("automations.webhookSecret.hint")}</p>
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
                      {fieldDisplayLabel(f, selectedEntityFieldOccurrences)}
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
              placeholder={t(trigger === "schedule" ? "automations.messageTemplate.placeholder.schedule" : "automations.messageTemplate.placeholder")}
              value={messageTemplate}
              onChange={(e) => setMessageTemplate(e.target.value)}
            />
          </label>
          {/* Round 868: a schedule rule has no triggering record at all --
              fireScheduledRule's own doc comment (automations.ts) states
              this explicitly and sends messageTemplate completely raw, for
              both the WhatsApp and webhook action types this field is
              shared across (see the actionType branch above). Advertising
              {{fieldName}} interpolation here anyway, same as every other
              trigger, invited a user to write a placeholder that would
              reach a real WhatsApp recipient or webhook consumer
              completely unsubstituted -- a visibly broken message with no
              warning anywhere in the product that this would happen. */}
          <p className="muted small">{t(trigger === "schedule" ? "automations.messageTemplate.hint.schedule" : "automations.messageTemplate.hint")}</p>

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
