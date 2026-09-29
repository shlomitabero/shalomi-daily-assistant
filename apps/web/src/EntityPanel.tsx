import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Entity, EntityRecord, Field, Project } from "@forge/shared";
import { createRecord, deleteRecord, listRecords, updateRecord } from "./api.js";
import { buildCalendarIcs, downloadCalendarIcs } from "./calendarIcs.js";
import { getHiddenFields, toggleFieldVisibility } from "./columnVisibility.js";
import { computeResizedWidth, getColumnWidths, setColumnWidth } from "./columnWidths.js";
import { applyColumnOrder, getColumnOrder, reorderColumns, setColumnOrder } from "./columnOrder.js";
import { getGroupByField, setGroupByField } from "./groupByPreference.js";
import { getViewMode as getViewModePreference, setViewMode as setViewModePreference } from "./viewModePreference.js";
import { getSortKeys as getSortKeysPreference, setSortKeys as setSortKeysPreference } from "./sortKeysPreference.js";
import { EntityLabelEditor } from "./EntityLabelEditor.js";
import { FieldLabelEditor } from "./FieldLabelEditor.js";
import {
  badgeTone,
  buildCalendarMonth,
  buildImportRecords,
  calendarChipLabelField,
  computeNextFocusedRowId,
  findBoardField,
  findDateField,
  formatDateForInput,
  formatDateValue,
  formatEntityRecordCount,
  formatNumberValue,
  formatRecordCreatedAt,
  groupByField,
  groupRecordsByField,
  isGroupableField,
  isInlineEditableField,
  isSameMonth,
  isTypingTarget,
  LOCALE,
  matchesSearch,
  parseCsv,
  recordDisplayLabel,
  relationDisplayLabel,
  recordsToCsv,
  restoreRecordAt,
  sortRecordsMulti,
  splitHighlightSegments,
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

/**
 * Renders a highlighted string via splitHighlightSegments -- the matched
 * part of a cell's own text wrapped in a real <mark>, so a search doesn't
 * just tell you a row matched but shows *where* in that row it matched.
 * A blank/no-match query is the overwhelmingly common case, so it takes
 * the cheap path (skip splitHighlightSegments's regex work entirely) and
 * renders the plain string.
 */
function Highlighted({ text, query }: { text: string; query: string | undefined }) {
  if (!query || !query.trim()) return <>{text}</>;
  return (
    <>
      {splitHighlightSegments(text, query).map((seg, i) =>
        seg.matched ? (
          <mark key={i} className="search-match">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/** Renders a table cell for a field's value -- a status badge for enums, a
 * checkmark/dash for booleans, a locale-formatted date or number, a native
 * hover tooltip carrying the untruncated value for longtext (a Notes or
 * Description field routinely runs longer than any reasonable column width,
 * and the only other way to read the rest was double-clicking into the real
 * edit textarea, which feels like committing to a change just to read one),
 * and plain text otherwise -- instead of one generic string for every field
 * type. */
function Cell({
  field,
  value,
  lang,
  t,
  relationLabel,
  highlightQuery,
  onJumpToRecord,
}: {
  field: Field;
  value: unknown;
  lang: Lang;
  t: (key: string) => string;
  relationLabel?: string;
  /** The active search box query, if any -- highlights where it matched
   * within this cell's own text/enum-label content (see Highlighted
   * above). Only meaningful for the two field types whose displayed text
   * is exactly what matchesSearch matches against; other types (date,
   * number, relation) format or resolve their raw stored value into
   * different displayed text, so highlighting there would point at text
   * the search didn't actually match. */
  highlightQuery?: string;
  /** When given, a relation cell renders as a clickable link that jumps
   * straight to the related record on its own entity's tab -- the same
   * jump-to-record plumbing Global Search, WhatsApp log, and Business
   * Twin already use, now reachable from the value itself instead of
   * only from those other panels. Omitted entirely in print output,
   * where a click target makes no sense. */
  onJumpToRecord?: (targetEntity: string, recordId: number) => void;
}) {
  if (value === null || value === undefined || value === "") {
    return <span className="muted">{t("entity.empty")}</span>;
  }
  if (field.type === "relation") {
    const label = relationLabel || `#${value}`;
    if (onJumpToRecord && field.relationTo) {
      return (
        <button type="button" className="link-button relation-jump-link" onClick={() => onJumpToRecord(field.relationTo!, Number(value))}>
          {label}
        </button>
      );
    }
    return <>{label}</>;
  }
  if (field.type === "boolean") {
    return value ? <span className="bool-yes">✓</span> : <span className="muted">–</span>;
  }
  if (field.type === "enum") {
    const label = field.enumLabels?.[String(value)] ?? String(value);
    return (
      <span className={`badge badge-${badgeTone(String(value))}`}>
        <Highlighted text={label} query={highlightQuery} />
      </span>
    );
  }
  if (field.type === "date") {
    return <>{formatDateValue(String(value), lang)}</>;
  }
  if (field.type === "number") {
    return <>{formatNumberValue(Number(value), lang)}</>;
  }
  if (field.type === "longtext") {
    return (
      <span className="longtext-cell" title={String(value)}>
        <Highlighted text={String(value)} query={highlightQuery} />
      </span>
    );
  }
  return <Highlighted text={String(value)} query={highlightQuery} />;
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

/**
 * The list-view sibling of RecordPrintSheet: prints every currently
 * VISIBLE record as one table (respecting the same search filter and
 * column visibility/order the on-screen table already applies), instead
 * of one record at a time. Same "always rendered, empty when not
 * requested" convention as RecordPrintSheet, for the same reason -- its
 * own `display: none` never has to fight window.print()'s mount/unmount
 * timing.
 */
function RecordListPrintSheet({
  entity,
  fields,
  records,
  show,
  lang,
  t,
  allEntities,
  relatedRecords,
}: {
  entity: Entity;
  fields: Field[];
  records: EntityRecord[];
  show: boolean;
  lang: Lang;
  t: (key: string, params?: Record<string, string | number>) => string;
  allEntities: Entity[];
  relatedRecords: RelatedRecordsByEntity;
}) {
  if (!show) return <div className="print-list-sheet" />;
  return (
    <div className="print-list-sheet">
      <h1>{entity.label ?? entity.name}</h1>
      <table>
        <thead>
          <tr>
            {fields.map((f) => (
              <th key={f.name}>{f.label ?? f.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id as number}>
              {fields.map((f) => (
                <td key={f.name}>
                  <Cell
                    field={f}
                    value={record[f.name]}
                    lang={lang}
                    t={t}
                    relationLabel={
                      f.type === "relation" ? relationDisplayLabel(f, record[f.name], allEntities, relatedRecords) : undefined
                    }
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="print-record-footer">
        {t("entity.printList.footer", { count: records.length, date: new Date().toLocaleString(LOCALE[lang]) })}
      </p>
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
  highlightQuery,
  onMove,
  onEdit,
  onDuplicate,
  onDelete,
  onJumpToRecord,
}: {
  entity: Entity;
  boardField: Field;
  record: EntityRecord;
  lang: Lang;
  t: (key: string) => string;
  allEntities: Entity[];
  relatedRecords: RelatedRecordsByEntity;
  highlightQuery?: string;
  onMove: (value: string) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onJumpToRecord?: (targetEntity: string, recordId: number) => void;
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
            highlightQuery={highlightQuery}
            onJumpToRecord={onJumpToRecord}
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
  onReschedule,
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
  onReschedule: (record: EntityRecord, date: Date) => void;
}) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const days = useMemo(
    () => buildCalendarMonth(records, dateField, year, monthIndex),
    [records, dateField, year, monthIndex],
  );
  const [dragOverDay, setDragOverDay] = useState<string | null>(null);
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
        {days.map((day, i) => {
          const dayKey = formatDateForInput(day.date);
          const isDragOver = day.inCurrentMonth && dragOverDay === dayKey;
          return (
          <div
            key={i}
            className={
              day.inCurrentMonth
                ? isDragOver
                  ? "calendar-day calendar-day-clickable calendar-day-drag-over"
                  : "calendar-day calendar-day-clickable"
                : "calendar-day calendar-day-outside"
            }
            onClick={day.inCurrentMonth ? () => onDayClick(day.date) : undefined}
            title={day.inCurrentMonth ? t("entity.calendar.addOnDay") : undefined}
            onDragOver={
              day.inCurrentMonth
                ? (e) => {
                    e.preventDefault();
                    setDragOverDay(dayKey);
                  }
                : undefined
            }
            onDragLeave={
              day.inCurrentMonth ? () => setDragOverDay((prev) => (prev === dayKey ? null : prev)) : undefined
            }
            onDrop={
              day.inCurrentMonth
                ? (e) => {
                    e.preventDefault();
                    setDragOverDay(null);
                    const id = Number(e.dataTransfer.getData("text/plain"));
                    if (Number.isNaN(id)) return;
                    const record = records.find((r) => (r.id as number) === id);
                    if (record) onReschedule(record, day.date);
                  }
                : undefined
            }
          >
            <span className="calendar-day-number">{day.date.getDate()}</span>
            <div className="calendar-day-records">
              {day.records.slice(0, 3).map((record) => (
                <button
                  type="button"
                  key={record.id as number}
                  className="calendar-record-chip"
                  draggable
                  onDragStart={(e) => {
                    // A drag that starts on the record chip must never also
                    // bubble into the day cell's own onClick (Escape/no-drop
                    // still fires a click on release in some browsers) --
                    // stopping propagation here keeps the two interactions
                    // (drag-to-reschedule vs. click-to-edit) from fighting.
                    e.stopPropagation();
                    e.dataTransfer.setData("text/plain", String(record.id));
                    e.dataTransfer.effectAllowed = "move";
                  }}
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
          );
        })}
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
  autoFocus,
  onBlur,
  onKeyDown,
}: {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
  relatedEntity?: Entity;
  relatedEntityRecords?: EntityRecord[];
  /** Only set by the entity table's inline cell editor (see EntityPanel's
   * editingCell state) -- the plain add/edit form below the table never
   * passes these, so a field there behaves exactly as before. */
  autoFocus?: boolean;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  const { t } = useTranslation();
  if (field.type === "relation" && relatedEntity && relatedEntityRecords) {
    return (
      <select
        value={value === "" || value === null || value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        autoFocus={autoFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
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
        autoFocus={autoFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
    );
  }
  if (field.type === "enum") {
    return (
      <select
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      >
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
    return (
      <textarea
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        autoFocus={autoFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
    );
  }
  if (field.type === "number" || field.type === "relation") {
    return (
      <input
        type="number"
        value={value === "" || value === null || value === undefined ? "" : Number(value)}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        placeholder={field.type === "relation" ? t("entity.relation.placeholder") : undefined}
        autoFocus={autoFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
    );
  }
  if (field.type === "date") {
    return (
      <input
        type="date"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
    );
  }
  return (
    <input
      type="text"
      value={String(value ?? "")}
      onChange={(e) => onChange(e.target.value)}
      autoFocus={autoFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    />
  );
}

export function EntityPanel({
  projectId,
  entity,
  allEntities,
  onEntityRenamed,
  highlightRecordId,
  onHighlightHandled,
  onJumpToRecord,
}: {
  projectId: string;
  entity: Entity;
  allEntities: Entity[];
  onEntityRenamed: (project: Project) => void;
  /** A record id to scroll to and highlight once loaded, e.g. after a global-search "jump to record" click. */
  highlightRecordId?: number | null;
  /** Called once the incoming highlightRecordId has actually been applied, so the caller can clear it and not re-trigger on the next render. */
  onHighlightHandled?: () => void;
  /** Called when a relation cell's value (in the table or a board card) is clicked, so the caller can switch to the target entity's own tab and highlight that record there -- the same "jump to record" mechanism Global Search, WhatsApp log, and Business Twin already trigger from their own panels. */
  onJumpToRecord?: (targetEntity: string, recordId: number) => void;
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
  const [groupFieldName, setGroupFieldName] = useState("");
  const [sortKeys, setSortKeys] = useState<SortKey[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkEditField, setBulkEditField] = useState("");
  const [bulkEditValue, setBulkEditValue] = useState<unknown>("");
  const [relatedRecords, setRelatedRecords] = useState<RelatedRecordsByEntity>({});
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [showImportErrors, setShowImportErrors] = useState(false);
  const [recordToPrint, setRecordToPrint] = useState<EntityRecord | null>(null);
  const [showPrintList, setShowPrintList] = useState(false);
  const [hiddenFields, setHiddenFields] = useState<Set<string>>(() => new Set());
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [resizingField, setResizingField] = useState<{ field: string; startX: number; startWidth: number } | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [columnOrder, setColumnOrderState] = useState<string[]>([]);
  const [draggedField, setDraggedField] = useState<string | null>(null);
  const [dragOverField, setDragOverField] = useState<string | null>(null);
  const [highlightedRecordId, setHighlightedRecordId] = useState<number | null>(null);
  const [focusedRowId, setFocusedRowId] = useState<number | null>(null);
  const [editingCell, setEditingCell] = useState<{ recordId: number; field: string } | null>(null);
  const [cellDraft, setCellDraft] = useState<unknown>(undefined);
  // Set right before an Escape-cancel clears editingCell, so the input's own
  // blur (which fires either immediately or once React unmounts it) knows to
  // skip committing a value the user just explicitly discarded, instead of
  // reading a still-live editingCell/cellDraft from a stale render closure.
  const suppressCellBlurCommitRef = useRef(false);
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
    setCalendarMonth(new Date());
    setSelectedIds(new Set());
    setImportMessage(null);
    setImportErrors([]);
    setShowImportErrors(false);
    setColumnsMenuOpen(false);
    setEditingCell(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.name]);

  // Kept separate from the reset effect above (which only depends on
  // entity.name) since hidden columns are scoped per project+entity, not
  // just per entity.
  useEffect(() => {
    setHiddenFields(getHiddenFields(projectId, entity.name));
  }, [projectId, entity.name]);

  // Same reasoning as hiddenFields' own effect just above -- a reordered
  // column layout is scoped per project+entity too.
  useEffect(() => {
    setColumnOrderState(getColumnOrder(projectId, entity.name));
  }, [projectId, entity.name]);

  // Same reasoning as hiddenFields' own effect just above -- resized column
  // widths are scoped per project+entity too.
  useEffect(() => {
    setColumnWidths(getColumnWidths(projectId, entity.name));
  }, [projectId, entity.name]);

  // Same reasoning as hiddenFields' own effect just above -- a chosen "Group
  // by" field is scoped per project+entity too. Previously groupFieldName
  // was reset to "" on every entity switch (see the combined reset effect
  // above) and never persisted at all, so picking a grouping didn't survive
  // even a reload of the same entity.
  useEffect(() => {
    setGroupFieldName(getGroupByField(projectId, entity.name));
  }, [projectId, entity.name]);

  // Same reasoning as groupFieldName's own effect just above -- the chosen
  // Table/Board/Calendar view is scoped per project+entity too. Falls back
  // to "table" if the persisted choice needs a board/date field this entity
  // no longer has (e.g. the field was removed), instead of rendering a view
  // toggle button that isn't even shown.
  useEffect(() => {
    const stored = getViewModePreference(projectId, entity.name);
    const stillValid =
      stored === "table" || (stored === "board" && boardField) || (stored === "calendar" && dateField);
    setViewMode(stillValid ? stored : "table");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, entity.name]);

  // Same reasoning as viewMode's own effect just above -- the chosen
  // multi-column sort is scoped per project+entity too (round 250).
  // Previously sortKeys was hard-reset to [] on every entity switch (see
  // the combined reset effect above) and never persisted at all, so a
  // deliberately-set sort didn't even survive clicking to another tab and
  // back. Drops any persisted key referencing a field this entity no
  // longer has (e.g. the field was removed), instead of sorting by
  // something that isn't even shown.
  useEffect(() => {
    const validFieldNames = new Set(entity.fields.map((f) => f.name));
    validFieldNames.add("createdAt");
    setSortKeys(getSortKeysPreference(projectId, entity.name).filter((k) => validFieldNames.has(k.field)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (!showPrintList) return;
    // Same deferred-tick reasoning as the single-record effect above, for
    // .print-list-sheet instead.
    const timer = setTimeout(() => window.print(), 0);
    return () => clearTimeout(timer);
  }, [showPrintList]);

  useEffect(() => {
    function clearPrinted() {
      setRecordToPrint(null);
      setShowPrintList(false);
    }
    window.addEventListener("afterprint", clearPrinted);
    return () => window.removeEventListener("afterprint", clearPrinted);
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
      let next: SortKey[];
      if (!additive) {
        next =
          prev.length === 1 && existingIndex === 0
            ? [{ field: fieldName, direction: prev[0].direction === "asc" ? "desc" : "asc" }]
            : [{ field: fieldName, direction: "asc" }];
      } else if (existingIndex === -1) {
        next = [...prev, { field: fieldName, direction: "asc" }];
      } else {
        next = prev.map((k, i) => (i === existingIndex ? { ...k, direction: k.direction === "asc" ? "desc" : "asc" } : k));
      }
      setSortKeysPreference(projectId, entity.name, next);
      return next;
    });
  }

  // The entity's own fields, reordered to match whatever column order the
  // user has actually dragged into place (falling back to the entity's
  // natural order for a field the persisted order doesn't mention).
  const orderedFields = useMemo(() => applyColumnOrder(entity.fields, columnOrder), [entity.fields, columnOrder]);

  // Which columns actually render in the table -- CSV export and the print
  // sheet intentionally ignore this and always include every field, since
  // those are whole-record actions, not "what's currently on screen".
  const visibleFields = useMemo(
    () => orderedFields.filter((f) => !hiddenFields.has(f.name)),
    [orderedFields, hiddenFields],
  );

  function handleToggleColumn(fieldName: string) {
    const visibleCount = entity.fields.length - hiddenFields.size;
    if (!hiddenFields.has(fieldName) && visibleCount <= 1) return; // keep at least one column visible
    setHiddenFields(toggleFieldVisibility(projectId, entity.name, fieldName));
  }

  // Dragging a column header to just before another one's -- reorders the
  // FULL field list (including any currently-hidden fields), not just the
  // visible subset, so a hidden field keeps its relative place once shown
  // again later.
  function handleReorderColumn(targetName: string) {
    setDragOverField(null);
    if (!draggedField || draggedField === targetName) return;
    const fullOrder = orderedFields.map((f) => f.name);
    setColumnOrderState(setColumnOrder(projectId, entity.name, reorderColumns(fullOrder, draggedField, targetName)));
    setDraggedField(null);
  }

  const visibleRecords = useMemo(() => {
    const matched = records.filter((r) => matchesSearch(r, entity.fields, search));
    const filtered =
      boardField && statusFilter ? matched.filter((r) => String(r[boardField.name] ?? "") === statusFilter) : matched;
    return sortRecordsMulti(filtered, sortKeys);
  }, [records, entity.fields, search, statusFilter, boardField, sortKeys]);

  /** Exactly the records the calendar grid's current month is showing -- the same computation handleExportIcs uses, kept separate so the export button can disable itself when the visible month is genuinely empty, not just when the whole entity has no records. */
  const icsMonthRecords = useMemo(() => {
    if (!dateField) return [];
    const days = buildCalendarMonth(visibleRecords, dateField, calendarMonth.getFullYear(), calendarMonth.getMonth());
    return days.filter((d) => d.inCurrentMonth).flatMap((d) => d.records);
  }, [visibleRecords, dateField, calendarMonth]);

  // Grouping the plain table by a small-value-space field (enum/boolean) --
  // distinct from the Kanban board view (which always groups by exactly one
  // auto-picked field, and always in its own separate view), this lets a
  // person cluster the ordinary table by ANY such field while staying in
  // table view, with search/sort/columns all still applying underneath.
  const groupableFields = useMemo(() => entity.fields.filter(isGroupableField), [entity.fields]);
  const groupField = groupableFields.find((f) => f.name === groupFieldName) ?? null;
  const recordGroups = useMemo(
    () => (groupField ? groupRecordsByField(visibleRecords, groupField, t) : null),
    [groupField, visibleRecords, t],
  );

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

  // Mirrors the highlighted-row scroll effect above, for the keyboard-
  // focused row instead of a jump-to target.
  useEffect(() => {
    if (focusedRowId == null) return;
    const row = tableScrollRef.current?.querySelector(`tr[data-record-id="${focusedRowId}"]`);
    row?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [focusedRowId, visibleRecords]);

  /**
   * j/k (and ArrowDown/ArrowUp) move a keyboard focus between table rows,
   * and Enter opens the focused row for editing -- the table view
   * previously had no way to move between records without reaching for
   * the mouse. Only active in table view (board/calendar have their own
   * navigation shapes), and isTypingTarget guards against hijacking
   * keystrokes meant for the search box, a filter dropdown, or the add/
   * edit form -- the same guard App.tsx's own Ctrl+K/Escape handler gets
   * for free by only running in the "preview" view, which doesn't apply
   * here since this panel *is* full of its own text inputs.
   */
  useEffect(() => {
    if (viewMode !== "table") return;
    function handleKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target as HTMLElement | null)) return;
      const visibleIds = visibleRecords.map((r) => r.id as number);
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedRowId((current) => computeNextFocusedRowId(visibleIds, current, "next"));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedRowId((current) => computeNextFocusedRowId(visibleIds, current, "prev"));
      } else if (e.key === "Enter" && focusedRowId != null) {
        const record = visibleRecords.find((r) => (r.id as number) === focusedRowId);
        if (record) {
          e.preventDefault();
          startEdit(record);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [viewMode, visibleRecords, focusedRowId]);

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

  /**
   * Kanban board's own sibling to startCreateForDate just above -- there was
   * no way to add a new record already set to one column's own value
   * without opening the general create form and picking that value by hand,
   * unlike the calendar view's own "click an empty day" convenience.
   */
  function startCreateForColumn(value: string, field: Field) {
    setEditingId(null);
    setForm({ ...emptyForm(entity), [field.name]: value });
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

  /**
   * Bulk delete/duplicate already existed, but changing a single shared
   * field's value across several selected records (e.g. marking 15
   * selected orders "Shipped", or moving 8 leads to "Closed") still meant
   * editing each row one at a time -- double-clicking a cell, or dragging
   * board cards one card at a time -- for what any real ops tool treats as
   * a single mass action. Same Promise.allSettled resilience as
   * handleBulkDelete/handleBulkDuplicate above: one record another tab
   * already deleted, or a validation failure on one record's current
   * value, must not hide the successful updates to the rest. Restricted to
   * isInlineEditableField fields (excludes relation) for the same reason
   * the inline cell editor itself is: a relation's "value" is another
   * record's id, not something a single shared value across N different
   * records makes sense for.
   */
  async function handleBulkUpdate() {
    const ids = [...selectedIds];
    if (ids.length === 0 || !bulkEditField) return;
    setError(null);
    const results = await Promise.allSettled(
      ids.map((id) => updateRecord(projectId, entity.name, id, { [bulkEditField]: bulkEditValue })),
    );
    const failedIds = ids.filter((_, i) => results[i].status === "rejected");
    setSelectedIds(new Set(failedIds));
    if (failedIds.length > 0) {
      const firstFailure = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
      setError(
        failedIds.length === ids.length
          ? (firstFailure.reason as Error).message
          : t("entity.bulk.updatePartialFailure", { failed: failedIds.length, total: ids.length }),
      );
    }
    await refresh();
  }

  /** A field's "empty" starting value depends on its type -- switching the
   * bulk-edit field picker from, say, an enum to a boolean must not leave
   * a stale string value FieldInput would render nonsensically. */
  function handleBulkEditFieldChange(fieldName: string) {
    setBulkEditField(fieldName);
    const field = entity.fields.find((f) => f.name === fieldName);
    setBulkEditValue(field?.type === "boolean" ? false : "");
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
   * The calendar view's own "take it with you" action -- CSV export dumps
   * the whole raw table, but a month of appointments/bookings is exactly
   * what a real business owner wants to drop straight into their phone's
   * real calendar app, which CSV can't do. Exports only the records the
   * calendar grid is currently showing (this month, respecting the active
   * search/filter via visibleRecords), not the whole entity.
   */
  function handleExportIcs() {
    if (!dateField) return;
    const labelField = calendarChipLabelField(entity, dateField);
    const ics = buildCalendarIcs(entity, dateField, labelField, icsMonthRecords, allEntities, relatedRecords);
    downloadCalendarIcs(ics, entity.name);
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

  /**
   * The calendar view's own drag-and-drop, the direct sibling of the board
   * view's handleCardDrop above -- dragging a record's chip onto a
   * different day reschedules it there (e.g. moving an appointment from
   * Tuesday to Thursday) without opening the edit form. Reuses the exact
   * same handleMove PATCH+refresh, just addressed by the date field's own
   * name and a freshly-formatted "YYYY-MM-DD" value instead of a board
   * enum value.
   */
  function handleCalendarDrop(record: EntityRecord, dateFieldName: string, date: Date) {
    const value = formatDateForInput(date);
    if (String(record[dateFieldName] ?? "") === value) return;
    void handleMove(record.id as number, dateFieldName, value);
  }

  /**
   * Double-clicking a table cell (any field except relation, see
   * isInlineEditableField) opens that one cell for editing right in place,
   * instead of requiring the full add/edit form below the table for a
   * single-value change -- the same real PATCH + refresh handleMove already
   * uses for a board-view drag, just addressed by field name instead of the
   * board field specifically.
   */
  function startInlineEdit(record: EntityRecord, field: Field) {
    if (!isInlineEditableField(field)) return;
    setEditingCell({ recordId: record.id as number, field: field.name });
    setCellDraft(record[field.name]);
  }

  async function commitInlineEdit() {
    if (!editingCell) return;
    const { recordId, field } = editingCell;
    const value = cellDraft;
    setEditingCell(null);
    try {
      await updateRecord(projectId, entity.name, recordId, { [field]: value });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Escape discards the in-progress edit instead of saving it. Sets the
  // suppress flag *before* clearing editingCell so the input's own blur --
  // which removing it from the DOM can still trigger -- finds the flag
  // already set and skips committing, rather than racing a stale closure's
  // still-non-null editingCell into saving the very value Escape just
  // discarded.
  function cancelInlineEdit() {
    suppressCellBlurCommitRef.current = true;
    setEditingCell(null);
  }

  function handleCellBlur() {
    if (suppressCellBlurCommitRef.current) {
      suppressCellBlurCommitRef.current = false;
      return;
    }
    void commitInlineEdit();
  }

  // Extracted so the same row markup renders identically whether the table
  // is flat or grouped (see recordGroups above) -- grouping only changes
  // what wraps the rows, never the rows themselves.
  function renderRecordRow(record: EntityRecord) {
    return (
      <tr
        key={record.id as number}
        data-record-id={record.id as number}
        className={
          [
            record.id === highlightedRecordId ? "record-row-highlighted" : null,
            record.id === focusedRowId ? "record-row-focused" : null,
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
      >
        <td className="select-col">
          <input
            type="checkbox"
            aria-label={t("entity.bulk.selectRow")}
            checked={selectedIds.has(record.id as number)}
            onChange={() => toggleSelected(record.id as number)}
          />
        </td>
        {visibleFields.map((f) => {
          const isEditingThisCell =
            editingCell != null && editingCell.recordId === (record.id as number) && editingCell.field === f.name;
          const editable = isInlineEditableField(f);
          return (
            <td
              key={f.name}
              style={columnWidths[f.name] ? { width: columnWidths[f.name] } : undefined}
              className={isEditingThisCell ? "cell-editing" : editable ? "cell-inline-editable" : undefined}
              onDoubleClick={editable && !isEditingThisCell ? () => startInlineEdit(record, f) : undefined}
              title={editable && !isEditingThisCell ? t("entity.inlineEdit.hint") : undefined}
            >
              {isEditingThisCell ? (
                <FieldInput
                  field={f}
                  value={cellDraft}
                  onChange={setCellDraft}
                  relatedEntity={f.relationTo ? allEntities.find((e) => e.name === f.relationTo) : undefined}
                  relatedEntityRecords={f.relationTo ? relatedRecords[f.relationTo] : undefined}
                  autoFocus
                  onBlur={handleCellBlur}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitInlineEdit();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelInlineEdit();
                    }
                  }}
                />
              ) : (
                <Cell
                  field={f}
                  value={record[f.name]}
                  lang={lang}
                  t={t}
                  relationLabel={
                    f.type === "relation" ? relationDisplayLabel(f, record[f.name], allEntities, relatedRecords) : undefined
                  }
                  highlightQuery={search}
                  onJumpToRecord={onJumpToRecord}
                />
              )}
            </td>
          );
        })}
        <td className="muted small created-at-cell">{formatRecordCreatedAt(record.createdAt as string | undefined, lang)}</td>
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
    );
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
            {viewMode === "table" && groupableFields.length > 0 && (
              <select
                className="entity-group-by"
                aria-label={t("entity.groupBy.label")}
                value={groupFieldName}
                onChange={(e) => setGroupFieldName(setGroupByField(projectId, entity.name, e.target.value))}
              >
                <option value="">{t("entity.groupBy.none")}</option>
                {groupableFields.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.label ?? f.name}
                  </option>
                ))}
              </select>
            )}
            {(boardField || dateField) && (
              <div className="view-toggle" role="group">
                <button
                  type="button"
                  className={viewMode === "table" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                  onClick={() => setViewMode(setViewModePreference(projectId, entity.name, "table"))}
                >
                  {t("entity.view.table")}
                </button>
                {boardField && (
                  <button
                    type="button"
                    className={viewMode === "board" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                    onClick={() => setViewMode(setViewModePreference(projectId, entity.name, "board"))}
                  >
                    {t("entity.view.board")}
                  </button>
                )}
                {dateField && (
                  <button
                    type="button"
                    className={viewMode === "calendar" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                    onClick={() => setViewMode(setViewModePreference(projectId, entity.name, "calendar"))}
                  >
                    {t("entity.view.calendar")}
                  </button>
                )}
              </div>
            )}
            {viewMode === "calendar" && dateField && (
              <button
                type="button"
                className="secondary ics-export-btn"
                onClick={handleExportIcs}
                disabled={icsMonthRecords.length === 0}
              >
                {t("entity.exportIcs")}
              </button>
            )}
            <button
              type="button"
              className="secondary csv-export-btn"
              onClick={handleExportCsv}
              disabled={visibleRecords.length === 0}
            >
              {t("entity.exportCsv")}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setShowPrintList(true)}
              disabled={visibleRecords.length === 0}
            >
              {t("entity.printList")}
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
                    <div className="board-column-header-info">
                      <span className={`badge badge-${badgeTone(column.value)}`}>{column.label}</span>
                      <span className="muted small">{column.records.length}</span>
                    </div>
                    <button
                      type="button"
                      className="board-add-card-btn"
                      title={t("entity.board.addCard", { value: column.label })}
                      aria-label={t("entity.board.addCard", { value: column.label })}
                      onClick={() => startCreateForColumn(column.value, boardField)}
                    >
                      +
                    </button>
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
                      highlightQuery={search}
                      onMove={(value) => handleMove(record.id as number, boardField.name, value)}
                      onEdit={() => startEdit(record)}
                      onDuplicate={() => handleDuplicate(record.id as number)}
                      onDelete={() => handleDelete(record.id as number)}
                      onJumpToRecord={onJumpToRecord}
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
              onReschedule={(record, date) => handleCalendarDrop(record, dateField.name, date)}
            />
          ) : (
            <div className="table-scroll" ref={tableScrollRef}>
              {visibleFields.length > 0 && <p className="muted small sort-hint">{t("entity.sort.multiHint")}</p>}
              {selectedIds.size > 0 && (
                <div className="bulk-actions-bar">
                  <span>{t("entity.bulk.selectedCount", { count: selectedIds.size })}</span>
                  <label className="bulk-edit-field-label">
                    {t("entity.bulk.setField")}
                    <select value={bulkEditField} onChange={(e) => handleBulkEditFieldChange(e.target.value)}>
                      <option value="">{t("entity.bulk.chooseField")}</option>
                      {entity.fields.filter(isInlineEditableField).map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.label ?? f.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {bulkEditField && (
                    <FieldInput
                      field={entity.fields.find((f) => f.name === bulkEditField)!}
                      value={bulkEditValue}
                      onChange={setBulkEditValue}
                    />
                  )}
                  {bulkEditField && (
                    <button type="button" className="secondary" onClick={handleBulkUpdate}>
                      {t("entity.bulk.apply", { count: selectedIds.size })}
                    </button>
                  )}
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
                          className={dragOverField === f.name ? "resizable-col resizable-col-drag-over" : "resizable-col"}
                          style={columnWidths[f.name] ? { width: columnWidths[f.name] } : undefined}
                          draggable
                          onDragStart={() => setDraggedField(f.name)}
                          onDragOver={(e) => {
                            e.preventDefault();
                            setDragOverField(f.name);
                          }}
                          onDragLeave={() => setDragOverField((prev) => (prev === f.name ? null : prev))}
                          onDrop={(e) => {
                            e.preventDefault();
                            handleReorderColumn(f.name);
                          }}
                        >
                          <button type="button" className="sort-header" onClick={(e) => toggleSort(f.name, e.shiftKey)}>
                            {f.label ?? f.name}
                            {key && (key.direction === "asc" ? " ▲" : " ▼")}
                            {key && sortKeys.length > 1 && <span className="sort-priority">{keyIndex + 1}</span>}
                          </button>
                          <span
                            className="column-resize-handle"
                            onMouseDown={(e) => startResize(e, f.name)}
                            draggable
                            onDragStart={(e) => e.preventDefault()}
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
                  {recordGroups
                    ? recordGroups.map((group) => (
                        <Fragment key={group.key}>
                          <tr className="entity-group-header-row">
                            <td colSpan={visibleFields.length + 3}>
                              {group.label} <span className="muted small">({group.records.length})</span>
                            </td>
                          </tr>
                          {group.records.map(renderRecordRow)}
                        </Fragment>
                      ))
                    : visibleRecords.map(renderRecordRow)}
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
      <RecordListPrintSheet
        entity={entity}
        fields={visibleFields}
        records={visibleRecords}
        show={showPrintList}
        lang={lang}
        t={t}
        allEntities={allEntities}
        relatedRecords={relatedRecords}
      />
    </div>
  );
}
