import { useEffect, useMemo, useState } from "react";
import type { Entity, EntityRecord, Field } from "@forge/shared";
import { createRecord, deleteRecord, listRecords, updateRecord } from "./api.js";
import {
  badgeTone,
  buildCalendarMonth,
  buildImportRecords,
  calendarChipLabelField,
  findBoardField,
  findDateField,
  formatDateValue,
  formatNumberValue,
  groupByField,
  LOCALE,
  matchesSearch,
  parseCsv,
  recordDisplayLabel,
  relationDisplayLabel,
  recordsToCsv,
  sortRecords,
  type RelatedRecordsByEntity,
  type SortDirection,
} from "./entityFormatting.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import type { Lang } from "./i18n/language.js";

type ViewMode = "table" | "board" | "calendar";

function emptyForm(entity: Entity): Record<string, unknown> {
  const form: Record<string, unknown> = {};
  for (const field of entity.fields) {
    form[field.name] = field.type === "boolean" ? false : "";
  }
  return form;
}

/** Renders a table cell for a field's value -- a status badge for enums, a
 * checkmark/dash for booleans, a locale-formatted date or number, and plain
 * text otherwise -- instead of one generic string for every field type. */
function Cell({
  field,
  value,
  lang,
  t,
  relationLabel,
}: {
  field: Field;
  value: unknown;
  lang: Lang;
  t: (key: string) => string;
  relationLabel?: string;
}) {
  if (value === null || value === undefined || value === "") {
    return <span className="muted">{t("entity.empty")}</span>;
  }
  if (field.type === "relation") {
    return <>{relationLabel || `#${value}`}</>;
  }
  if (field.type === "boolean") {
    return value ? <span className="bool-yes">✓</span> : <span className="muted">–</span>;
  }
  if (field.type === "enum") {
    const label = field.enumLabels?.[String(value)] ?? String(value);
    return <span className={`badge badge-${badgeTone(String(value))}`}>{label}</span>;
  }
  if (field.type === "date") {
    return <>{formatDateValue(String(value), lang)}</>;
  }
  if (field.type === "number") {
    return <>{formatNumberValue(Number(value), lang)}</>;
  }
  return <>{String(value)}</>;
}

/**
 * One card in the board view: the record's other fields (never the board
 * field itself, since that's implied by which column the card is in), a
 * select to move it directly to another column, and the same Edit/Delete
 * actions the table row has.
 */
function BoardCard({
  entity,
  boardField,
  record,
  lang,
  t,
  allEntities,
  relatedRecords,
  onMove,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  entity: Entity;
  boardField: Field;
  record: EntityRecord;
  lang: Lang;
  t: (key: string) => string;
  allEntities: Entity[];
  relatedRecords: RelatedRecordsByEntity;
  onMove: (value: string) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const otherFields = entity.fields.filter((f) => f.name !== boardField.name);
  return (
    <div className="board-card">
      {otherFields.map((f) => (
        <div key={f.name} className="board-card-field">
          <span className="muted small">{f.label ?? f.name}</span>
          <Cell
            field={f}
            value={record[f.name]}
            lang={lang}
            t={t}
            relationLabel={
              f.type === "relation" ? relationDisplayLabel(f, record[f.name], allEntities, relatedRecords) : undefined
            }
          />
        </div>
      ))}
      <select
        className="board-card-move"
        value={String(record[boardField.name] ?? "")}
        onChange={(e) => onMove(e.target.value)}
      >
        {(boardField.enumValues ?? []).map((v) => (
          <option key={v} value={v}>
            {boardField.enumLabels?.[v] ?? v}
          </option>
        ))}
      </select>
      <div className="row-actions">
        <button type="button" onClick={onEdit}>
          {t("entity.edit")}
        </button>
        <button type="button" onClick={onDuplicate}>
          {t("entity.duplicate")}
        </button>
        <button type="button" className="danger" onClick={onDelete}>
          {t("entity.delete")}
        </button>
      </div>
    </div>
  );
}

/**
 * Renders a month grid for entities with a date field (e.g. "Appointment"),
 * so a date-heavy entity gets a real calendar instead of the same table
 * shape every entity gets. Each day cell shows a chip per record landing on
 * that date (click to edit), with a "+N more" overflow instead of an
 * ever-growing cell.
 */
function CalendarView({
  entity,
  dateField,
  records,
  month,
  lang,
  t,
  onPrevMonth,
  onNextMonth,
  onEdit,
}: {
  entity: Entity;
  dateField: Field;
  records: EntityRecord[];
  month: Date;
  lang: Lang;
  t: (key: string, params?: Record<string, string | number>) => string;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onEdit: (record: EntityRecord) => void;
}) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const days = useMemo(
    () => buildCalendarMonth(records, dateField, year, monthIndex),
    [records, dateField, year, monthIndex],
  );
  const monthLabel = month.toLocaleDateString(LOCALE[lang], { month: "long", year: "numeric" });
  const weekdayLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(LOCALE[lang], { weekday: "short" });
    return days.slice(0, 7).map((d) => formatter.format(d.date));
  }, [days, lang]);
  const labelField = calendarChipLabelField(entity, dateField);

  return (
    <div className="calendar-view">
      <div className="calendar-nav">
        <button type="button" onClick={onPrevMonth} aria-label={t("entity.calendar.prev")}>
          ‹
        </button>
        <span className="calendar-month-label">{monthLabel}</span>
        <button type="button" onClick={onNextMonth} aria-label={t("entity.calendar.next")}>
          ›
        </button>
      </div>
      <div className="calendar-grid calendar-weekdays">
        {weekdayLabels.map((label, i) => (
          <div key={i} className="calendar-weekday">
            {label}
          </div>
        ))}
      </div>
      <div className="calendar-grid calendar-days">
        {days.map((day, i) => (
          <div key={i} className={day.inCurrentMonth ? "calendar-day" : "calendar-day calendar-day-outside"}>
            <span className="calendar-day-number">{day.date.getDate()}</span>
            <div className="calendar-day-records">
              {day.records.slice(0, 3).map((record) => (
                <button
                  type="button"
                  key={record.id as number}
                  className="calendar-record-chip"
                  onClick={() => onEdit(record)}
                >
                  {String(record[labelField.name] ?? "")}
                </button>
              ))}
              {day.records.length > 3 && (
                <span className="calendar-record-more">
                  {t("entity.calendar.more", { count: day.records.length - 3 })}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  relatedEntity,
  relatedEntityRecords,
}: {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
  relatedEntity?: Entity;
  relatedEntityRecords?: EntityRecord[];
}) {
  const { t } = useTranslation();
  if (field.type === "relation" && relatedEntity && relatedEntityRecords) {
    return (
      <select
        value={value === "" || value === null || value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
      >
        <option value="">{t("entity.select")}</option>
        {relatedEntityRecords.map((r) => (
          <option key={r.id as number} value={r.id as number}>
            {recordDisplayLabel(relatedEntity, r)}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "boolean") {
    return (
      <input
        type="checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (field.type === "enum") {
    return (
      <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>
          {t("entity.select")}
        </option>
        {field.enumValues?.map((v) => (
          <option key={v} value={v}>
            {field.enumLabels?.[v] ?? v}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "longtext") {
    return <textarea value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} rows={2} />;
  }
  if (field.type === "number" || field.type === "relation") {
    return (
      <input
        type="number"
        value={value === "" || value === null || value === undefined ? "" : Number(value)}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        placeholder={field.type === "relation" ? t("entity.relation.placeholder") : undefined}
      />
    );
  }
  if (field.type === "date") {
    return <input type="date" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
  }
  return <input type="text" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
}

export function EntityPanel({
  projectId,
  entity,
  allEntities,
}: {
  projectId: string;
  entity: Entity;
  allEntities: Entity[];
}) {
  const { t, lang } = useTranslation();
  const [records, setRecords] = useState<EntityRecord[]>([]);
  const [form, setForm] = useState<Record<string, unknown>>(() => emptyForm(entity));
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [relatedRecords, setRelatedRecords] = useState<RelatedRecordsByEntity>({});
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [showImportErrors, setShowImportErrors] = useState(false);
  const boardField = useMemo(() => findBoardField(entity.fields), [entity.fields]);
  const dateField = useMemo(() => findDateField(entity.fields), [entity.fields]);
  const relationTargets = useMemo(() => {
    const names = entity.fields
      .filter((f) => f.type === "relation" && f.relationTo)
      .map((f) => f.relationTo!);
    return [...new Set(names)].filter((name) => allEntities.some((e) => e.name === name));
  }, [entity.fields, allEntities]);

  useEffect(() => {
    let cancelled = false;
    async function loadRelated() {
      if (relationTargets.length === 0) {
        setRelatedRecords({});
        return;
      }
      const entries = await Promise.all(
        relationTargets.map(async (name) => {
          try {
            const { records: related } = await listRecords(projectId, name);
            return [name, related] as const;
          } catch {
            return [name, []] as const;
          }
        }),
      );
      if (!cancelled) setRelatedRecords(Object.fromEntries(entries));
    }
    void loadRelated();
    return () => {
      cancelled = true;
    };
  }, [projectId, relationTargets]);

  async function refresh() {
    setLoading(true);
    try {
      const { records } = await listRecords(projectId, entity.name);
      setRecords(records);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setForm(emptyForm(entity));
    setEditingId(null);
    setSearch("");
    setSortField(null);
    setViewMode("table");
    setCalendarMonth(new Date());
    setSelectedIds(new Set());
    setImportMessage(null);
    setImportErrors([]);
    setShowImportErrors(false);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.name]);

  function toggleSort(fieldName: string) {
    if (sortField !== fieldName) {
      setSortField(fieldName);
      setSortDir("asc");
    } else {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    }
  }

  const visibleRecords = useMemo(
    () => sortRecords(records.filter((r) => matchesSearch(r, entity.fields, search)), sortField, sortDir),
    [records, entity.fields, search, sortField, sortDir],
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (editingId != null) {
        await updateRecord(projectId, entity.name, editingId, form);
      } else {
        await createRecord(projectId, entity.name, form);
      }
      setForm(emptyForm(entity));
      setEditingId(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function startEdit(record: EntityRecord) {
    setEditingId(record.id as number);
    setForm({ ...record });
  }

  async function handleDelete(id: number) {
    const record = records.find((r) => (r.id as number) === id);
    const label = record ? recordDisplayLabel(entity, record) : `#${id}`;
    if (!window.confirm(t("entity.confirmDelete", { label }))) return;
    setError(null);
    try {
      await deleteRecord(projectId, entity.name, id);
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Copies a record's own field values into a real new record -- a quick
  // way to create several similar entries (e.g. a recurring appointment,
  // near-identical orders) without retyping the whole form. Only the
  // entity's own fields are sent (id/createdAt are server-assigned), and
  // nothing is asked for confirmation since duplicating, unlike deleting,
  // creates rather than destroys data.
  async function handleDuplicate(id: number) {
    const record = records.find((r) => (r.id as number) === id);
    if (!record) return;
    setError(null);
    try {
      const copy: Record<string, unknown> = {};
      for (const field of entity.fields) copy[field.name] = record[field.name];
      await createRecord(projectId, entity.name, copy);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function toggleSelected(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    const visibleIds = visibleRecords.map((r) => r.id as number);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }

  // Promise.allSettled rather than Promise.all: a single rejected delete
  // (a dropped connection, a record another tab already removed) must not
  // hide the ones that *did* succeed -- Promise.all would reject on the
  // first failure and skip both the refresh() and the selectedIds cleanup
  // below it, leaving already-deleted rows still shown as selected in a
  // now-stale table until the user manually reloads the page.
  async function handleBulkDelete() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(t("entity.bulk.confirmDelete", { count: ids.length }))) return;
    setError(null);
    const results = await Promise.allSettled(ids.map((id) => deleteRecord(projectId, entity.name, id)));
    const failedIds = ids.filter((_, i) => results[i].status === "rejected");
    setSelectedIds(new Set(failedIds));
    if (failedIds.length > 0) {
      const firstFailure = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
      setError(
        failedIds.length === ids.length
          ? (firstFailure.reason as Error).message
          : t("entity.bulk.partialFailure", { failed: failedIds.length, total: ids.length }),
      );
    }
    await refresh();
  }

  function handleExportCsv() {
    const csv = recordsToCsv(entity.fields, visibleRecords, lang, allEntities, relatedRecords);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${entity.name}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /**
   * The complement to CSV export: parses an uploaded file with parseCsv,
   * converts it to record payloads with buildImportRecords (which already
   * validates types/required fields client-side), then POSTs each valid
   * row. Uses allSettled rather than assuming success once client-side
   * validation passes, since the server has the final say (e.g. a
   * cross-field rule this component doesn't know about) -- the summary
   * message reports real created/skipped counts either way, not an
   * optimistic guess.
   */
  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file to retry
    if (!file) return;
    setImportBusy(true);
    setImportMessage(null);
    setImportErrors([]);
    setShowImportErrors(false);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      const { records: parsedRecords, errors: parseErrors } = buildImportRecords(entity.fields, rows);

      if (parsedRecords.length === 0) {
        setImportErrors(parseErrors);
        setImportMessage(
          parseErrors.length > 0
            ? t("entity.import.allFailed", { errorCount: parseErrors.length })
            : t("entity.import.empty"),
        );
        return;
      }

      const results = await Promise.allSettled(
        parsedRecords.map((record) => createRecord(projectId, entity.name, record)),
      );
      const serverErrors = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => (r.reason as Error).message);
      const createdCount = results.length - serverErrors.length;
      const allErrors = [...parseErrors, ...serverErrors];
      setImportErrors(allErrors);
      setImportMessage(
        allErrors.length === 0
          ? t("entity.import.success", { count: createdCount })
          : t("entity.import.successWithErrors", { count: createdCount, errorCount: allErrors.length }),
      );
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImportBusy(false);
    }
  }

  async function handleMove(id: number, fieldName: string, value: string) {
    setError(null);
    try {
      await updateRecord(projectId, entity.name, id, { [fieldName]: value });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="entity-panel">
      <h3>{entity.label ?? entity.name}</h3>
      {entity.description && <p className="muted">{entity.description}</p>}

      <form className="record-form" onSubmit={handleSubmit}>
        {entity.fields.map((field) => (
          <label key={field.name} className="field-row">
            <span>
              {field.label ?? field.name}
              {field.required ? " *" : ""}
            </span>
            <FieldInput
              field={field}
              value={form[field.name]}
              onChange={(v) => setForm((prev) => ({ ...prev, [field.name]: v }))}
              relatedEntity={field.relationTo ? allEntities.find((e) => e.name === field.relationTo) : undefined}
              relatedEntityRecords={field.relationTo ? relatedRecords[field.relationTo] : undefined}
            />
          </label>
        ))}
        <div className="form-actions">
          <button type="submit">{editingId != null ? t("entity.save") : t("entity.add")}</button>
          {editingId != null && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setEditingId(null);
                setForm(emptyForm(entity));
              }}
            >
              {t("entity.cancel")}
            </button>
          )}
        </div>
      </form>

      {error && (
        <p className="error" role="status">
          {error}
        </p>
      )}

      <div className="csv-import-row">
        <label className="csv-import-label">
          {importBusy ? t("entity.import.parsing") : t("entity.importCsv")}
          <input type="file" accept=".csv,text/csv" onChange={handleImportFile} disabled={importBusy} hidden />
        </label>
        {importMessage && (
          <span className="muted small" role="status">
            {importMessage}
          </span>
        )}
        {importErrors.length > 0 && (
          <button type="button" className="secondary small" onClick={() => setShowImportErrors((v) => !v)}>
            {showImportErrors ? t("entity.import.hideErrors") : t("entity.import.showErrors")}
          </button>
        )}
      </div>
      {showImportErrors && importErrors.length > 0 && (
        <ul className="csv-import-errors">
          {importErrors.map((msg, i) => (
            <li key={i}>{msg}</li>
          ))}
        </ul>
      )}

      {loading ? (
        <p className="muted">{t("entity.loading")}</p>
      ) : records.length === 0 ? (
        <div className="empty-state">
          <p>{t("entity.noRecords")}</p>
        </div>
      ) : (
        <>
          <div className="entity-toolbar">
            <input
              type="text"
              className="entity-search"
              placeholder={t("entity.search.placeholder")}
              aria-label={t("entity.search.placeholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {(boardField || dateField) && (
              <div className="view-toggle" role="group">
                <button
                  type="button"
                  className={viewMode === "table" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                  onClick={() => setViewMode("table")}
                >
                  {t("entity.view.table")}
                </button>
                {boardField && (
                  <button
                    type="button"
                    className={viewMode === "board" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                    onClick={() => setViewMode("board")}
                  >
                    {t("entity.view.board")}
                  </button>
                )}
                {dateField && (
                  <button
                    type="button"
                    className={viewMode === "calendar" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                    onClick={() => setViewMode("calendar")}
                  >
                    {t("entity.view.calendar")}
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              className="secondary csv-export-btn"
              onClick={handleExportCsv}
              disabled={visibleRecords.length === 0}
            >
              {t("entity.exportCsv")}
            </button>
          </div>
          {visibleRecords.length === 0 ? (
            <div className="empty-state">
              <p>{t("entity.noResults")}</p>
            </div>
          ) : viewMode === "board" && boardField ? (
            <div className="board-scroll">
              {groupByField(visibleRecords, boardField).map((column) => (
                <div className="board-column" key={column.value}>
                  <div className="board-column-header">
                    <span className={`badge badge-${badgeTone(column.value)}`}>{column.label}</span>
                    <span className="muted small">{column.records.length}</span>
                  </div>
                  {column.records.map((record) => (
                    <BoardCard
                      key={record.id as number}
                      entity={entity}
                      boardField={boardField}
                      record={record}
                      lang={lang}
                      t={t}
                      allEntities={allEntities}
                      relatedRecords={relatedRecords}
                      onMove={(value) => handleMove(record.id as number, boardField.name, value)}
                      onEdit={() => startEdit(record)}
                      onDuplicate={() => handleDuplicate(record.id as number)}
                      onDelete={() => handleDelete(record.id as number)}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : viewMode === "calendar" && dateField ? (
            <CalendarView
              entity={entity}
              dateField={dateField}
              records={visibleRecords}
              month={calendarMonth}
              lang={lang}
              t={t}
              onPrevMonth={() => setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              onNextMonth={() => setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
              onEdit={startEdit}
            />
          ) : (
            <div className="table-scroll">
              {selectedIds.size > 0 && (
                <div className="bulk-actions-bar">
                  <span>{t("entity.bulk.selectedCount", { count: selectedIds.size })}</span>
                  <button type="button" className="danger" onClick={handleBulkDelete}>
                    {t("entity.bulk.deleteSelected")}
                  </button>
                </div>
              )}
              <table>
                <thead>
                  <tr>
                    <th className="select-col">
                      <input
                        type="checkbox"
                        aria-label={t("entity.bulk.selectAll")}
                        checked={
                          visibleRecords.length > 0 && visibleRecords.every((r) => selectedIds.has(r.id as number))
                        }
                        ref={(el) => {
                          if (!el) return;
                          const someSelected = visibleRecords.some((r) => selectedIds.has(r.id as number));
                          const allSelected = visibleRecords.length > 0 && visibleRecords.every((r) => selectedIds.has(r.id as number));
                          el.indeterminate = someSelected && !allSelected;
                        }}
                        onChange={toggleSelectAllVisible}
                      />
                    </th>
                    {entity.fields.map((f) => (
                      <th
                        key={f.name}
                        aria-sort={sortField === f.name ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                      >
                        <button type="button" className="sort-header" onClick={() => toggleSort(f.name)}>
                          {f.label ?? f.name}
                          {sortField === f.name ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                        </button>
                      </th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visibleRecords.map((record) => (
                    <tr key={record.id as number}>
                      <td className="select-col">
                        <input
                          type="checkbox"
                          aria-label={t("entity.bulk.selectRow")}
                          checked={selectedIds.has(record.id as number)}
                          onChange={() => toggleSelected(record.id as number)}
                        />
                      </td>
                      {entity.fields.map((f) => (
                        <td key={f.name}>
                          <Cell
                            field={f}
                            value={record[f.name]}
                            lang={lang}
                            t={t}
                            relationLabel={
                              f.type === "relation"
                                ? relationDisplayLabel(f, record[f.name], allEntities, relatedRecords)
                                : undefined
                            }
                          />
                        </td>
                      ))}
                      <td className="row-actions">
                        <button type="button" onClick={() => startEdit(record)}>
                          {t("entity.edit")}
                        </button>
                        <button type="button" onClick={() => handleDuplicate(record.id as number)}>
                          {t("entity.duplicate")}
                        </button>
                        <button type="button" className="danger" onClick={() => handleDelete(record.id as number)}>
                          {t("entity.delete")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
