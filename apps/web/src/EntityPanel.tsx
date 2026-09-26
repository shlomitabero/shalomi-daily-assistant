import { useEffect, useMemo, useRef, useState } from "react";
import type { Entity, EntityRecord, Field, Project } from "@forge/shared";
import { createRecord, deleteRecord, listRecords, updateRecord } from "./api.js";
import { getHiddenFields, toggleFieldVisibility } from "./columnVisibility.js";
import { computeResizedWidth, getColumnWidths, setColumnWidth } from "./columnWidths.js";
import { EntityLabelEditor } from "./EntityLabelEditor.js";
import { FieldLabelEditor } from "./FieldLabelEditor.js";
import {
  badgeTone,
  buildCalendarMonth,
  buildImportRecords,
  calendarChipLabelField,
  findBoardField,
  findDateField,
  formatDateForInput,
  formatDateValue,
  formatEntityRecordCount,
  formatNumberValue,
  formatRecordCreatedAt,
  groupByField,
  isSameMonth,
  LOCALE,
  matchesSearch,
  parseCsv,
  recordDisplayLabel,
  relationDisplayLabel,
  recordsToCsv,
  restoreRecordAt,
  sortRecordsMulti,
  type RelatedRecordsByEntity,
  type SortKey,
} from "./entityFormatting.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { dirFor } from "./i18n/language.js";
import type { Lang } from "./i18n/language.js";

type ViewMode = "table" | "board" | "calendar";

/**
 * How long a deleted record stays undoable before the delete actually
 * reaches the server -- long enough to notice and click Undo, short
 * enough that leaving it pending doesn't feel like the delete silently
 * didn't happen.
 */
const UNDO_WINDOW_MS = 5000;

interface PendingDelete {
  id: number;
  record: EntityRecord;
  index: number;
  label: string;
  timeoutId: ReturnType<typeof setTimeout>;
}

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
/**
 * The only DOM this renders is meant to be seen by a printer, never a
 * screen -- styles.css keeps `.print-record-sheet` at `display: none` on
 * screen, and a `@media print` rule hides everything else in the page
 * (via `visibility: hidden`) while un-hiding this one element. That's why
 * this always renders (never conditionally, so its `display: none` never
 * has to fight a mount/unmount race with `window.print()`) and just shows
 * nothing when there's no record queued to print.
 */
function RecordPrintSheet({
  entity,
  record,
  lang,
  t,
  allEntities,
  relatedRecords,
}: {
  entity: Entity;
  record: EntityRecord | null;
  lang: Lang;
  t: (key: string, params?: Record<string, string | number>) => string;
  allEntities: Entity[];
  relatedRecords: RelatedRecordsByEntity;
}) {
  if (!record) return <div className="print-record-sheet" />;
  return (
    <div className="print-record-sheet">
      <h1>{entity.label ?? entity.name}</h1>
      <dl>
        {entity.fields.map((f) => (
          <div key={f.name} className="print-field">
            <dt>{f.label ?? f.name}</dt>
            <dd>
              <Cell
                field={f}
                value={record[f.name]}
                lang={lang}
                t={t}
                relationLabel={
                  f.type === "relation" ? relationDisplayLabel(f, record[f.name], allEntities, relatedRecords) : undefined
                }
              />
            </dd>
          </div>
        ))}
      </dl>
      <p className="print-record-footer">{t("entity.print.generatedAt", { date: new Date().toLocaleString(LOCALE[lang]) })}</p>
    </div>
  );
}

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
    <div
      className="board-card"
      data-record-id={record.id as number}
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", String(record.id))}
    >
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
  onToday,
  onEdit,
  onDayClick,
}: {
  entity: Entity;
  dateField: Field;
  records: EntityRecord[];
  month: Date;
  lang: Lang;
  t: (key: string, params?: Record<string, string | number>) => string;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
  onEdit: (record: EntityRecord) => void;
  onDayClick: (date: Date) => void;
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
  const isCurrentMonth = isSameMonth(month, new Date());

  return (
    <div className="calendar-view">
      <div className="calendar-nav">
        <button type="button" className="secondary calendar-today-btn" onClick={onToday} disabled={isCurrentMonth}>
          {t("entity.calendar.today")}
        </button>
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
          <div
            key={i}
            className={
              day.inCurrentMonth ? "calendar-day calendar-day-clickable" : "calendar-day calendar-day-outside"
            }
            onClick={day.inCurrentMonth ? () => onDayClick(day.date) : undefined}
            title={day.inCurrentMonth ? t("entity.calendar.addOnDay") : undefined}
          >
            <span className="calendar-day-number">{day.date.getDate()}</span>
            <div className="calendar-day-records">
              {day.records.slice(0, 3).map((record) => (
                <button
                  type="button"
                  key={record.id as number}
                  className="calendar-record-chip"
                  onClick={(e) => {
                    // Clicking a record edits it -- without stopping the
                    // click from bubbling, the day cell's own onDayClick
                    // above would ALSO fire and silently blow away the
                    // in-progress edit with a fresh empty-record form for
                    // this same day.
                    e.stopPropagation();
                    onEdit(record);
                  }}
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
  onEntityRenamed,
  highlightRecordId,
  onHighlightHandled,
}: {
  projectId: string;
  entity: Entity;
  allEntities: Entity[];
  onEntityRenamed: (project: Project) => void;
  /** A record id to scroll to and highlight once loaded, e.g. after a global-search "jump to record" click. */
  highlightRecordId?: number | null;
  /** Called once the incoming highlightRecordId has actually been applied, so the caller can clear it and not re-trigger on the next render. */
  onHighlightHandled?: () => void;
}) {
  const { t, lang } = useTranslation();
  const [records, setRecords] = useState<EntityRecord[]>([]);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const pendingDeleteRef = useRef<PendingDelete | null>(null);
  const [form, setForm] = useState<Record<string, unknown>>(() => emptyForm(entity));
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sortKeys, setSortKeys] = useState<SortKey[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [relatedRecords, setRelatedRecords] = useState<RelatedRecordsByEntity>({});
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [showImportErrors, setShowImportErrors] = useState(false);
  const [recordToPrint, setRecordToPrint] = useState<EntityRecord | null>(null);
  const [hiddenFields, setHiddenFields] = useState<Set<string>>(() => new Set());
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [resizingField, setResizingField] = useState<{ field: string; startX: number; startWidth: number } | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [highlightedRecordId, setHighlightedRecordId] = useState<number | null>(null);
  // Bumped once per refresh() call, so a stale refresh whose listRecords
  // round trip just happens to take longer than a newer one's (triggered
  // by an overlapping action, e.g. duplicating two rows back to back)
  // can recognize itself as superseded and skip overwriting the newer,
  // still-correct records already on screen.
  const refreshRequestId = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
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
    const requestId = ++refreshRequestId.current;
    setLoading(true);
    try {
      const { records } = await listRecords(projectId, entity.name);
      if (refreshRequestId.current !== requestId) return;
      setRecords(records);
    } catch (err) {
      if (refreshRequestId.current !== requestId) return;
      setError((err as Error).message);
    } finally {
      if (refreshRequestId.current === requestId) setLoading(false);
    }
  }

  useEffect(() => {
    setForm(emptyForm(entity));
    setEditingId(null);
    setSearch("");
    setStatusFilter("");
    setSortKeys([]);
    setViewMode("table");
    setCalendarMonth(new Date());
    setSelectedIds(new Set());
    setImportMessage(null);
    setImportErrors([]);
    setShowImportErrors(false);
    setColumnsMenuOpen(false);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.name]);

  // Kept separate from the reset effect above (which only depends on
  // entity.name) since hidden columns are scoped per project+entity, not
  // just per entity.
  useEffect(() => {
    setHiddenFields(getHiddenFields(projectId, entity.name));
  }, [projectId, entity.name]);

  // Same reasoning as hiddenFields' own effect just above -- resized column
  // widths are scoped per project+entity too.
  useEffect(() => {
    setColumnWidths(getColumnWidths(projectId, entity.name));
  }, [projectId, entity.name]);

  /**
   * Drag-to-resize a column header. Only attaches real mousemove/mouseup
   * listeners while a drag is actually in progress (resizingField set),
   * removing them the instant it ends -- not a permanent global listener
   * doing nothing most of the time. The width is only persisted to
   * localStorage on mouseup (via setColumnWidth), not on every mousemove,
   * so a fast drag doesn't write to storage dozens of times per second.
   */
  useEffect(() => {
    if (!resizingField) return;
    function handleMove(e: MouseEvent) {
      const width = computeResizedWidth(resizingField!.startWidth, e.clientX - resizingField!.startX, dirFor(lang));
      setColumnWidths((prev) => ({ ...prev, [resizingField!.field]: width }));
    }
    function handleUp() {
      setColumnWidths((prev) => {
        const width = prev[resizingField!.field];
        if (width != null) setColumnWidth(projectId, entity.name, resizingField!.field, width);
        return prev;
      });
      setResizingField(null);
    }
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizingField]);

  function startResize(e: React.MouseEvent<HTMLSpanElement>, fieldName: string) {
    e.preventDefault();
    const th = e.currentTarget.parentElement as HTMLTableCellElement | null;
    const startWidth = columnWidths[fieldName] ?? th?.getBoundingClientRect().width ?? 150;
    setResizingField({ field: fieldName, startX: e.clientX, startWidth });
  }

  useEffect(() => {
    if (!recordToPrint) return;
    // Deferred a tick so the just-set record has actually rendered into
    // .print-record-sheet before the print dialog opens and captures it.
    const timer = setTimeout(() => window.print(), 0);
    return () => clearTimeout(timer);
  }, [recordToPrint]);

  useEffect(() => {
    function clearPrintedRecord() {
      setRecordToPrint(null);
    }
    window.addEventListener("afterprint", clearPrintedRecord);
    return () => window.removeEventListener("afterprint", clearPrintedRecord);
  }, []);

  /**
   * Applies an incoming highlightRecordId (see GlobalSearchPanel's own
   * per-row "jump to record" click) once this entity's records have
   * actually loaded -- switching to table view and clearing any leftover
   * search/status filter from a previous visit to this same tab, since
   * either could otherwise hide the very row this was supposed to reveal.
   * Reports back via onHighlightHandled so the parent clears its own copy
   * and a second click on the same record (after this one auto-fades)
   * can re-trigger it.
   */
  useEffect(() => {
    if (highlightRecordId == null || loading) return;
    setSearch("");
    setStatusFilter("");
    setViewMode("table");
    setHighlightedRecordId(highlightRecordId);
    onHighlightHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightRecordId, loading]);

  // Auto-fades the highlight a few seconds after it lands, so an old
  // "jump to record" doesn't stay visually marked forever if the user just
  // keeps working in this same tab.
  useEffect(() => {
    if (highlightedRecordId == null) return;
    const timer = setTimeout(() => setHighlightedRecordId(null), 4000);
    return () => clearTimeout(timer);
  }, [highlightedRecordId]);

  /**
   * A plain click always sorts by just this one column (replacing
   * whatever came before), toggling direction on a second click -- the
   * same single-column behavior this table always had. Shift-click adds
   * this column as a tiebreaker after whatever's already sorting the
   * table instead of replacing it, so a second sort key can narrow down
   * ties the first one left standing (e.g. sort by status, then by total
   * within each status) without losing the first key. Shift-clicking a
   * column that's already a key toggles that key's own direction in
   * place, rather than moving it to the end.
   */
  function toggleSort(fieldName: string, additive: boolean) {
    setSortKeys((prev) => {
      const existingIndex = prev.findIndex((k) => k.field === fieldName);
      if (!additive) {
        if (prev.length === 1 && existingIndex === 0) {
          return [{ field: fieldName, direction: prev[0].direction === "asc" ? "desc" : "asc" }];
        }
        return [{ field: fieldName, direction: "asc" }];
      }
      if (existingIndex === -1) {
        return [...prev, { field: fieldName, direction: "asc" }];
      }
      return prev.map((k, i) => (i === existingIndex ? { ...k, direction: k.direction === "asc" ? "desc" : "asc" } : k));
    });
  }

  // Which columns actually render in the table -- CSV export and the print
  // sheet intentionally ignore this and always include every field, since
  // those are whole-record actions, not "what's currently on screen".
  const visibleFields = useMemo(
    () => entity.fields.filter((f) => !hiddenFields.has(f.name)),
    [entity.fields, hiddenFields],
  );

  function handleToggleColumn(fieldName: string) {
    const visibleCount = entity.fields.length - hiddenFields.size;
    if (!hiddenFields.has(fieldName) && visibleCount <= 1) return; // keep at least one column visible
    setHiddenFields(toggleFieldVisibility(projectId, entity.name, fieldName));
  }

  const visibleRecords = useMemo(() => {
    const matched = records.filter((r) => matchesSearch(r, entity.fields, search));
    const filtered =
      boardField && statusFilter ? matched.filter((r) => String(r[boardField.name] ?? "") === statusFilter) : matched;
    return sortRecordsMulti(filtered, sortKeys);
  }, [records, entity.fields, search, statusFilter, boardField, sortKeys]);

  // Scrolls the just-highlighted row into view once it's actually in the
  // rendered table -- runs after visibleRecords updates (the same render
  // that picks up the filter-clearing above), not just after
  // highlightedRecordId changes, since the row doesn't exist in the DOM
  // until then.
  useEffect(() => {
    if (highlightedRecordId == null) return;
    const row = tableScrollRef.current?.querySelector(`tr[data-record-id="${highlightedRecordId}"]`);
    row?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [highlightedRecordId, visibleRecords]);

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

  /**
   * Clicking an empty calendar day was previously inert -- the only way to
   * add a record for a specific date was scrolling up to the general
   * create form and typing the date in by hand. Pre-fills that same form
   * with the clicked day, so calendar-heavy entities (appointments,
   * bookings) get the "click a day to add one" a real calendar app has.
   */
  function startCreateForDate(date: Date, dateField: Field) {
    setEditingId(null);
    setForm({ ...emptyForm(entity), [dateField.name]: formatDateForInput(date) });
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Fires the real DELETE request for a record the undo window has already
  // closed on (either the timer ran out, or a newer delete pre-empted it) --
  // it was already removed from view the moment Delete was confirmed, so
  // there's nothing left to roll the screen back to if this itself fails.
  function commitPendingDelete(pending: PendingDelete) {
    void deleteRecord(projectId, entity.name, pending.id).catch(() => {});
  }

  // Mirrors pendingDelete into a ref so the unmount-flush effect below (and
  // a second delete arriving while one is still pending) can read the
  // latest pending delete without depending on a stale render's closure.
  useEffect(() => {
    pendingDeleteRef.current = pendingDelete;
  }, [pendingDelete]);

  // Switching entity tabs remounts this component fresh (App.tsx keys
  // EntityPanel by entity.name), so leaving one open mid-undo-window would
  // otherwise silently never actually delete the record. Committing it for
  // real on unmount instead makes "navigate away" behave like the undo
  // window simply ran out early, rather than quietly reverting the delete.
  useEffect(() => {
    return () => {
      const pending = pendingDeleteRef.current;
      if (pending) {
        clearTimeout(pending.timeoutId);
        commitPendingDelete(pending);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Deleting a record used to call the real DELETE endpoint the instant the
   * confirm dialog closed -- irreversible the moment you clicked, with the
   * confirm dialog (round 73) as the only safety net. Removes it from view
   * immediately (so the table still feels instant), but delays the actual
   * API call behind a real UNDO_WINDOW_MS window, showing a toast with an
   * Undo button. Only one delete is ever pending at a time: starting a new
   * one commits any still-pending one for real first, rather than letting
   * two undo windows overlap.
   */
  async function handleDelete(id: number) {
    const index = records.findIndex((r) => (r.id as number) === id);
    if (index === -1) return;
    const record = records[index];
    const label = recordDisplayLabel(entity, record);
    if (!window.confirm(t("entity.confirmDelete", { label }))) return;

    if (pendingDeleteRef.current) {
      clearTimeout(pendingDeleteRef.current.timeoutId);
      commitPendingDelete(pendingDeleteRef.current);
    }

    setError(null);
    setRecords((prev) => prev.filter((r) => (r.id as number) !== id));
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

    const timeoutId = setTimeout(() => {
      setPendingDelete((current) => {
        if (current?.id !== id) return current;
        commitPendingDelete(current);
        return null;
      });
    }, UNDO_WINDOW_MS);

    setPendingDelete({ id, record, index, label, timeoutId });
  }

  function handleUndoDelete() {
    const pending = pendingDeleteRef.current;
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    setRecords((prev) => restoreRecordAt(prev, pending.record, pending.index));
    setPendingDelete(null);
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

  // Same Promise.allSettled resilience as handleBulkDelete below, and the
  // same per-record copy logic as the single-record handleDuplicate above
  // -- a quick way to create several similar entries at once (e.g.
  // several near-identical service listings) without repeating single
  // duplicates one at a time. No confirmation, for the same reason
  // handleDuplicate has none: duplicating creates rather than destroys.
  async function handleBulkDuplicate() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setError(null);
    const results = await Promise.allSettled(
      ids.map((id) => {
        const record = records.find((r) => (r.id as number) === id);
        const copy: Record<string, unknown> = {};
        if (record) for (const field of entity.fields) copy[field.name] = record[field.name];
        return createRecord(projectId, entity.name, copy);
      }),
    );
    const failedIds = ids.filter((_, i) => results[i].status === "rejected");
    setSelectedIds(new Set(failedIds));
    if (failedIds.length > 0) {
      const firstFailure = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
      setError(
        failedIds.length === ids.length
          ? (firstFailure.reason as Error).message
          : t("entity.bulk.duplicatePartialFailure", { failed: failedIds.length, total: ids.length }),
      );
    }
    await refresh();
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

  /**
   * The board view's own move-between-columns action already existed (the
   * card's own status <select>, still kept as the accessible/keyboard-
   * reachable way to move a card), but a real Kanban board is expected to
   * let you drag a card straight onto the column you want -- native HTML5
   * drag-and-drop (draggable + dragstart/dragover/drop), not a mouse-event
   * simulation like the column-resize handle (round 185) needed, since this
   * is exactly the browser's own built-in drag contract. Reuses the same
   * handleMove the dropdown already calls, so a drag and a dropdown change
   * both end up doing the identical real PATCH + refresh.
   */
  function handleCardDrop(e: React.DragEvent<HTMLDivElement>, fieldName: string, value: string) {
    e.preventDefault();
    setDragOverColumn(null);
    const id = Number(e.dataTransfer.getData("text/plain"));
    if (Number.isNaN(id)) return;
    const record = records.find((r) => (r.id as number) === id);
    // Dropping a card back onto the column it's already in is a real no-op
    // -- nothing actually changed, so there's nothing worth a PATCH request for.
    if (record && String(record[fieldName] ?? "") === value) return;
    void handleMove(id, fieldName, value);
  }

  return (
    <div className="entity-panel">
      <EntityLabelEditor entity={entity} projectId={projectId} onRenamed={onEntityRenamed} />
      {entity.description && <p className="muted">{entity.description}</p>}

      <form className="record-form" ref={formRef} onSubmit={handleSubmit}>
        {entity.fields.map((field) => (
          <label key={field.name} className="field-row">
            <FieldLabelEditor entityName={entity.name} field={field} projectId={projectId} onRenamed={onEntityRenamed} />
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

      {pendingDelete && (
        <p className="entity-undo-toast" role="status">
          {t("entity.delete.undoToast", { label: pendingDelete.label })}
          <button type="button" className="link-button" onClick={handleUndoDelete}>
            {t("entity.delete.undo")}
          </button>
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
            <span className="muted small entity-record-count">
              {formatEntityRecordCount(visibleRecords.length, records.length, t)}
            </span>
            {boardField && (
              <select
                className="entity-status-filter"
                aria-label={t("entity.filter.byField", { field: boardField.label ?? boardField.name })}
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">{t("entity.filter.allValues", { field: boardField.label ?? boardField.name })}</option>
                {(boardField.enumValues ?? []).map((v) => (
                  <option key={v} value={v}>
                    {boardField.enumLabels?.[v] ?? v}
                  </option>
                ))}
              </select>
            )}
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
            <div className="columns-menu-wrapper">
              <button
                type="button"
                className="secondary columns-menu-btn"
                onClick={() => setColumnsMenuOpen((v) => !v)}
                aria-expanded={columnsMenuOpen}
              >
                {t("entity.columns.button")}
              </button>
              {columnsMenuOpen && (
                <div className="columns-menu-panel">
                  {entity.fields.map((f) => (
                    <label key={f.name} className="columns-menu-item">
                      <input
                        type="checkbox"
                        checked={!hiddenFields.has(f.name)}
                        onChange={() => handleToggleColumn(f.name)}
                      />
                      {f.label ?? f.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
          {visibleRecords.length === 0 ? (
            <div className="empty-state">
              <p>{t("entity.noResults")}</p>
            </div>
          ) : viewMode === "board" && boardField ? (
            <div className="board-scroll">
              {groupByField(visibleRecords, boardField).map((column) => (
                <div
                  className={dragOverColumn === column.value ? "board-column board-column-drag-over" : "board-column"}
                  key={column.value}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverColumn(column.value);
                  }}
                  onDragLeave={() => setDragOverColumn((prev) => (prev === column.value ? null : prev))}
                  onDrop={(e) => handleCardDrop(e, boardField.name, column.value)}
                >
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
              onToday={() => setCalendarMonth(new Date())}
              onEdit={startEdit}
              onDayClick={(date) => startCreateForDate(date, dateField)}
            />
          ) : (
            <div className="table-scroll" ref={tableScrollRef}>
              {visibleFields.length > 0 && <p className="muted small sort-hint">{t("entity.sort.multiHint")}</p>}
              {selectedIds.size > 0 && (
                <div className="bulk-actions-bar">
                  <span>{t("entity.bulk.selectedCount", { count: selectedIds.size })}</span>
                  <button type="button" className="secondary" onClick={handleBulkDuplicate}>
                    {t("entity.bulk.duplicateSelected")}
                  </button>
                  <button type="button" className="danger" onClick={handleBulkDelete}>
                    {t("entity.bulk.deleteSelected")}
                  </button>
                </div>
              )}
              <table className={Object.keys(columnWidths).length > 0 ? "entity-table-resized" : undefined}>
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
                    {visibleFields.map((f) => {
                      const keyIndex = sortKeys.findIndex((k) => k.field === f.name);
                      const key = keyIndex === -1 ? null : sortKeys[keyIndex];
                      return (
                        <th
                          key={f.name}
                          aria-sort={keyIndex === 0 ? (key!.direction === "asc" ? "ascending" : "descending") : "none"}
                          className="resizable-col"
                          style={columnWidths[f.name] ? { width: columnWidths[f.name] } : undefined}
                        >
                          <button type="button" className="sort-header" onClick={(e) => toggleSort(f.name, e.shiftKey)}>
                            {f.label ?? f.name}
                            {key && (key.direction === "asc" ? " ▲" : " ▼")}
                            {key && sortKeys.length > 1 && <span className="sort-priority">{keyIndex + 1}</span>}
                          </button>
                          <span
                            className="column-resize-handle"
                            onMouseDown={(e) => startResize(e, f.name)}
                            aria-hidden="true"
                          />
                        </th>
                      );
                    })}
                    {(() => {
                      const keyIndex = sortKeys.findIndex((k) => k.field === "createdAt");
                      const key = keyIndex === -1 ? null : sortKeys[keyIndex];
                      return (
                        <th aria-sort={keyIndex === 0 ? (key!.direction === "asc" ? "ascending" : "descending") : "none"}>
                          <button type="button" className="sort-header" onClick={(e) => toggleSort("createdAt", e.shiftKey)}>
                            {t("entity.table.createdAt")}
                            {key && (key.direction === "asc" ? " ▲" : " ▼")}
                            {key && sortKeys.length > 1 && <span className="sort-priority">{keyIndex + 1}</span>}
                          </button>
                        </th>
                      );
                    })()}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visibleRecords.map((record) => (
                    <tr
                      key={record.id as number}
                      data-record-id={record.id as number}
                      className={record.id === highlightedRecordId ? "record-row-highlighted" : undefined}
                    >
                      <td className="select-col">
                        <input
                          type="checkbox"
                          aria-label={t("entity.bulk.selectRow")}
                          checked={selectedIds.has(record.id as number)}
                          onChange={() => toggleSelected(record.id as number)}
                        />
                      </td>
                      {visibleFields.map((f) => (
                        <td key={f.name} style={columnWidths[f.name] ? { width: columnWidths[f.name] } : undefined}>
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
                      <td className="muted small created-at-cell">
                        {formatRecordCreatedAt(record.createdAt as string | undefined, lang)}
                      </td>
                      <td className="row-actions">
                        <button type="button" onClick={() => startEdit(record)}>
                          {t("entity.edit")}
                        </button>
                        <button type="button" onClick={() => handleDuplicate(record.id as number)}>
                          {t("entity.duplicate")}
                        </button>
                        <button type="button" onClick={() => setRecordToPrint(record)}>
                          {t("entity.print")}
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
      <RecordPrintSheet
        entity={entity}
        record={recordToPrint}
        lang={lang}
        t={t}
        allEntities={allEntities}
        relatedRecords={relatedRecords}
      />
    </div>
  );
}
