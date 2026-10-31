import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Entity, EntityRecord, Field, Project } from "@forge/shared";
import { createRecord, deleteRecord, deleteUploadedRecordFile, getCalendarFeedToken, listRecords, safeDownloadName, updateRecord, uploadRecordFile } from "./api.js";
import { buildCalendarIcs, downloadCalendarIcs } from "./calendarIcs.js";
import { getHiddenFields, replaceHiddenFields, toggleFieldVisibility } from "./columnVisibility.js";
import {
  clearColumnWidths,
  computeResizedWidth,
  getColumnWidths,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  setColumnWidth,
} from "./columnWidths.js";
import { applyColumnOrder, getColumnOrder, reorderColumns, setColumnOrder } from "./columnOrder.js";
import {
  addEntityRecentSearch,
  clearEntityRecentSearches,
  getEntityRecentSearches,
  removeEntityRecentSearch,
} from "./entityRecentSearches.js";
import { getGroupByField, getGroupByFieldType, setGroupByField, setGroupByFieldType } from "./groupByPreference.js";
import { getViewMode as getViewModePreference, setViewMode as setViewModePreference } from "./viewModePreference.js";
import { getSortKeys as getSortKeysPreference, setSortKeys as setSortKeysPreference } from "./sortKeysPreference.js";
import { getFieldFilters as getFieldFiltersPreference, setFieldFilters as setFieldFiltersPreference } from "./fieldFiltersPreference.js";
import { migrateCollapsedGroupsFieldCase, setCollapsedGroups as setCollapsedGroupsPreference } from "./collapsedGroupsPreference.js";
import { migrateCollapsedBoardColumnsFieldCase, setCollapsedBoardColumns as setCollapsedBoardColumnsPreference } from "./collapsedBoardColumnsPreference.js";
import { EntityLabelEditor } from "./EntityLabelEditor.js";
import { FieldLabelEditor } from "./FieldLabelEditor.js";
import { isAnyDialogOpen } from "./useDialogFocusTrap.js";
import { useBeforeUnloadWarning } from "./useBeforeUnloadWarning.js";
import {
  badgeTone,
  buildCalendarMonth,
  buildImportRecords,
  buildImportRecordsFromJson,
  calendarChipLabelField,
  calendarChipLabelValue,
  computeNextFocusedRowId,
  entityDisplayLabel,
  entityLabelOccurrences,
  findBoardField,
  findDateField,
  findEndDateField,
  findFilterableFields,
  findFilterableEnumFields,
  fieldDisplayLabel,
  fieldLabelOccurrences,
  findPhoneField,
  findRecordPhoneNumber,
  formatDateForInput,
  formatDateValue,
  formatEntityRecordCount,
  formatNumberValue,
  formatRecordCreatedAt,
  getDateUrgency,
  groupByField,
  groupRecordsByField,
  enterTargetsInteractiveElement,
  isDeadlineFieldName,
  isGroupableField,
  isInlineEditableField,
  isSameDay,
  isSameMonth,
  isImageMimeType,
  isTypingTarget,
  LOCALE,
  matchesSearch,
  parseCsv,
  parseFieldDate,
  parseFileFieldValue,
  recordDisplayLabel,
  relationDisplayLabel,
  recordsToCsv,
  recordsToJson,
  restoreRecordAt,
  scrollIntoViewRespectingMotion,
  selectedOrAllRecords,
  sortRecordsMulti,
  splitHighlightSegments,
  splitLinkSegments,
  sumNumericFields,
  uniqueEnumValues,
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

/** How many pixels an ArrowLeft/ArrowRight press widens or narrows a column via the resize handle's keyboard fallback. */
const RESIZE_KEYBOARD_STEP = 20;

interface PendingDeleteEntry {
  id: number;
  record: EntityRecord;
  index: number;
}

interface PendingDelete {
  entries: PendingDeleteEntry[];
  message: string;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * Round 980 switched a real "number" field's input from a native
 * `<input type="number">` to a plain text input (to let a leading "-" be
 * typed at all -- see that round's own comment on FieldInput below), which
 * also removed the one thing that used to make a non-numeric string
 * physically impossible to get into `form`/`cellDraft`/`bulkEditValue` in
 * the first place: the browser's own keystroke-level number-input
 * sanitization. Without a client-side check, ordinary text typed into a
 * "number" field (e.g. a typo like "1o0") now reaches the server as-is,
 * where `coerceValue` (packages/db/src/repository.ts) rejects it with a
 * real, field-specific message -- but that message never reaches the
 * user: `resolveErrorMessage` always overrides a VALIDATION_ERROR response
 * with the generic, field-agnostic "check the form" banner, the exact
 * failure shape this file's own `missingField` checks already exist to
 * avoid for a required-but-empty field. Mirrors that same pattern for a
 * present-but-non-numeric value instead of an empty one; emptiness itself
 * is deliberately left to the caller's own trim-based required check, not
 * reported as a numeric error here.
 */
function invalidNumberField(field: Field, value: unknown): boolean {
  if (field.type !== "number") return false;
  const trimmed = String(value ?? "").trim();
  if (trimmed === "") return false;
  return !Number.isFinite(Number(trimmed));
}

/**
 * Round 1167: the same bug class invalidNumberField above already fixed
 * for a non-numeric typed value, for a different root cause: a record
 * can carry a legacy enum value no longer in field.enumValues (e.g. after
 * a later /refine narrowed the field's own options -- see FieldInput's
 * own identical "legacy value" comment below). handleDuplicate/
 * handleBulkDuplicate copy a record's own stored values verbatim into a
 * fresh createRecord call with no form in between, so a stale value here
 * always reached coerceValue's own enum rejection (repository.ts) only to
 * be masked by resolveErrorMessage's fixed, field-agnostic VALIDATION_ERROR
 * text -- for an action with no form to "check" at all. Mirrors
 * coerceValue's own emptiness semantics (an empty/whitespace-only value is
 * never "stale", it's just unset) so an optional enum field left blank
 * never trips this.
 */
function staleEnumValue(field: Field, value: unknown): boolean {
  if (field.type !== "enum" || !field.enumValues) return false;
  const trimmed = String(value ?? "").trim();
  if (trimmed === "") return false;
  return !field.enumValues.includes(String(value));
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

/**
 * Renders a text/longtext value via splitLinkSegments -- a URL or email
 * address embedded in the value (e.g. a "Website" or "Email" field) becomes
 * a real, clickable link instead of inert text a person had to manually
 * select and copy. Each plain (non-link) segment still goes through
 * Highlighted, so search highlighting and linkification compose instead of
 * one silently disabling the other. A link's own matched text isn't
 * separately highlighted -- the link itself is already the visible
 * "found this" signal, and highlighting *inside* an <a> muddies its click
 * target with an unrelated <mark> background.
 */
function Linkified({ text, query }: { text: string; query: string | undefined }) {
  return (
    <>
      {splitLinkSegments(text).map((seg, i) =>
        seg.href ? (
          <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer" className="cell-link">
            {seg.text}
          </a>
        ) : (
          <Highlighted key={i} text={seg.text} query={query} />
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
    // Every other field type here renders its real value as text a screen
    // reader can announce (an enum's label, a formatted date/number, a
    // relation's resolved label) -- this glyph IS the cell's only content,
    // unlike the decorative icons elsewhere in this app (e.g. the pencil
    // next to CheckpointLabelEditor's own text) that correctly use
    // aria-hidden because real text already sits beside them. Without an
    // aria-label, a boolean column conveyed nothing at all to a non-visual
    // user. Reuses the same "Yes"/"No" strings the group-by dropdown and
    // column header already translate this value to.
    return value ? (
      <span className="bool-yes" aria-label={t("entity.groupBy.yes")}>✓</span>
    ) : (
      <span className="muted" aria-label={t("entity.groupBy.no")}>–</span>
    );
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
    const formatted = formatDateValue(String(value), lang);
    const urgency = isDeadlineFieldName(field.name) ? getDateUrgency(String(value)) : null;
    if (!urgency) return <>{formatted}</>;
    return (
      <span className={`date-${urgency === "overdue" ? "overdue" : "due-soon"}`} title={t(urgency === "overdue" ? "entity.dateOverdue" : "entity.dateDueSoon")}>
        {formatted}
      </span>
    );
  }
  if (field.type === "number") {
    return <>{formatNumberValue(Number(value), lang)}</>;
  }
  if (field.type === "longtext") {
    return (
      <span className="longtext-cell" title={String(value)}>
        <Linkified text={String(value)} query={highlightQuery} />
      </span>
    );
  }
  if (field.type === "file") {
    const fileValue = parseFileFieldValue(value);
    if (!fileValue) return <span className="muted">{t("entity.empty")}</span>;
    return (
      <a href={fileValue.url} target="_blank" rel="noopener noreferrer" className="file-cell-link" title={fileValue.name}>
        {isImageMimeType(fileValue.mimeType) ? (
          <img src={fileValue.url} alt={fileValue.name} className="file-cell-thumbnail" />
        ) : (
          // fileValue.name is exactly what matchesSearch's own "file"
          // branch matches against -- without this, a record that shows
          // up in a filtered table precisely because its attachment's
          // filename matched the search query gave no visual indication
          // of why, unlike every other field type whose displayed text is
          // also what matchesSearch matched (enum/longtext/the generic
          // fallback, all a few lines above).
          <span className="file-cell-name">
            <Highlighted text={fileValue.name} query={highlightQuery} />
          </span>
        )}
      </a>
    );
  }
  return <Linkified text={String(value)} query={highlightQuery} />;
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
  fields,
  record,
  lang,
  t,
  allEntities,
  relatedRecords,
}: {
  entity: Entity;
  fields: Field[];
  record: EntityRecord | null;
  lang: Lang;
  t: (key: string, params?: Record<string, string | number>) => string;
  allEntities: Entity[];
  relatedRecords: RelatedRecordsByEntity;
}) {
  if (!record) return <div className="print-record-sheet" />;
  const labelOccurrences = fieldLabelOccurrences(fields);
  return (
    <div className="print-record-sheet">
      <h1>{entityDisplayLabel(entity, entityLabelOccurrences(allEntities))}</h1>
      <dl>
        {fields.map((f) => (
          <div key={f.name} className="print-field">
            <dt>{fieldDisplayLabel(f, labelOccurrences)}</dt>
            <dd>
              <Cell
                field={f}
                value={record[f.name]}
                lang={lang}
                t={t}
                relationLabel={
                  f.type === "relation" ? relationDisplayLabel(f, record[f.name], allEntities, relatedRecords, lang) : undefined
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
  groups,
  show,
  lang,
  t,
  allEntities,
  relatedRecords,
}: {
  entity: Entity;
  fields: Field[];
  records: EntityRecord[];
  // Round 885: mirrors the on-screen table's own group-header/per-group-
  // subtotal rendering (Table view's recordGroups/groupNumericTotals, or
  // Board view's own columns/boardColumnNumericTotals) -- null for an
  // ungrouped view or when printing an explicit row selection, where there
  // is no obvious group boundary for an arbitrary hand-picked set of rows
  // to mirror. Previously grouping a table by Status specifically to
  // compare "Paid" vs "Pending" vs "Cancelled" totals -- exactly what
  // grouping exists for -- lost all of that structure the moment it was
  // printed: one continuous table with zero group headings or subtotals,
  // only round 884's own flat grand total at the very bottom.
  groups: { label: string; records: EntityRecord[] }[] | null;
  show: boolean;
  lang: Lang;
  t: (key: string, params?: Record<string, string | number>) => string;
  allEntities: Entity[];
  relatedRecords: RelatedRecordsByEntity;
}) {
  if (!show) return <div className="print-list-sheet" />;
  const labelOccurrences = fieldLabelOccurrences(fields);
  // Mirrors the on-screen table's own numericFieldTotals/<tfoot> (round
  // 297, collapse-aware since round 491) -- recomputed directly from
  // `records`/`fields` rather than threading the on-screen total down as
  // a prop, since `records` here can be just a selection
  // (selectedOrAllRecords at the call site), which the on-screen total
  // (always over the full effectivelyVisibleRecords) would get wrong.
  // Previously the printed list showed every record's own number column
  // but never the one number a person printing a list of amounts/prices
  // is very plausibly printing it FOR -- the total.
  const hasNumericField = fields.some((f) => f.type === "number");
  const totals = hasNumericField ? sumNumericFields(records, fields) : {};
  function renderRow(record: EntityRecord) {
    return (
      <tr key={record.id as number}>
        {fields.map((f) => (
          <td key={f.name}>
            <Cell
              field={f}
              value={record[f.name]}
              lang={lang}
              t={t}
              relationLabel={f.type === "relation" ? relationDisplayLabel(f, record[f.name], allEntities, relatedRecords, lang) : undefined}
            />
          </td>
        ))}
      </tr>
    );
  }
  return (
    <div className="print-list-sheet">
      <h1>{entityDisplayLabel(entity, entityLabelOccurrences(allEntities))}</h1>
      <table>
        <thead>
          <tr>
            {fields.map((f) => (
              <th key={f.name}>{fieldDisplayLabel(f, labelOccurrences)}</th>
            ))}
          </tr>
        </thead>
        {groups ? (
          groups.map((group) => {
            const groupTotals = hasNumericField ? sumNumericFields(group.records, fields) : {};
            return (
              <tbody key={group.label} className="print-list-group">
                <tr className="print-list-group-header-row">
                  <td colSpan={fields.length}>
                    {group.label} <span className="muted small">({group.records.length})</span>
                  </td>
                </tr>
                {group.records.map(renderRow)}
                {hasNumericField && (
                  <tr className="print-list-group-totals-row">
                    {fields.map((f) => (
                      <td key={f.name}>
                        {f.type === "number" && (
                          <>
                            {t("entity.table.total")}: {formatNumberValue(groupTotals[f.name] ?? 0, lang)}
                          </>
                        )}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            );
          })
        ) : (
          <tbody>{records.map(renderRow)}</tbody>
        )}
        {hasNumericField && (
          <tfoot>
            <tr className="print-list-totals-row">
              {fields.map((f) => (
                <td key={f.name}>
                  {f.type === "number" && (
                    <>
                      {t("entity.table.total")}: {formatNumberValue(totals[f.name] ?? 0, lang)}
                    </>
                  )}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
      <p className="print-record-footer">
        {t("entity.printList.footer", { count: records.length, date: new Date().toLocaleString(LOCALE[lang]) })}
      </p>
    </div>
  );
}

function BoardCard({
  orderedFields,
  boardField,
  record,
  lang,
  t,
  allEntities,
  relatedRecords,
  highlightQuery,
  hasMoveError,
  onMove,
  onEdit,
  onDuplicate,
  onDelete,
  onPrint,
  phoneField,
  onSendWhatsApp,
  onJumpToRecord,
  onDragEnd,
  readOnly = false,
  bulkActionBusy = false,
}: {
  orderedFields: Field[];
  boardField: Field;
  record: EntityRecord;
  lang: Lang;
  t: (key: string) => string;
  allEntities: Entity[];
  relatedRecords: RelatedRecordsByEntity;
  highlightQuery?: string;
  hasMoveError?: boolean;
  onMove: (value: string) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onPrint: () => void;
  phoneField?: Field | null;
  onSendWhatsApp?: (phoneNumber: string) => void;
  onJumpToRecord?: (targetEntity: string, recordId: number) => void;
  /** Round 1232: native HTML5 drag-and-drop only fires `dragleave` on a
   * column the pointer actually moves off of -- cancelling a drag with
   * Escape (or dropping outside any valid target) fires `dragend` on the
   * source instead, with the pointer never having left the column still
   * highlighted underneath it. Without this, board-column-drag-over's
   * accent border/background stuck permanently, surviving even a
   * Table/Calendar-and-back view switch (the state lives in the parent's
   * own useState, untouched by viewMode). */
  onDragEnd?: () => void;
  readOnly?: boolean;
  /** Round 1118: mirrors readOnly's own gating, but only for the affordances
   * that actually write to this record (drag-to-move, Duplicate, Delete) --
   * a bulk update/duplicate/delete batch still in flight must block each of
   * those, since any would otherwise race a real write against the same
   * record. Edit/Print are untouched: opening the form or printing doesn't
   * itself write anything. */
  bulkActionBusy?: boolean;
}) {
  // orderedFields (not the entity's raw declared order) -- mirrors round
  // 615's fix for Export CSV/Copy/per-record Print/Print list, so a board
  // card's field order follows the user's drag-reordered columns the same
  // way the on-screen table and every other whole-record render path do.
  const otherFields = orderedFields.filter((f) => f.name !== boardField.name);
  // A record can land in the board's "(other)" column (see groupByField) when
  // its stored value is a legacy one no longer in boardField.enumValues --
  // migrate.ts only ever adds columns on refine, it never rewrites existing
  // row data. Without this, the <select> below would have no <option>
  // matching the controlled value, so the browser silently blanks it
  // (selectedIndex -1) instead of showing the record's real stage.
  const currentBoardValue = String(record[boardField.name] ?? "");
  const knownBoardValues = uniqueEnumValues(boardField.enumValues);
  const boardOptionValues = currentBoardValue && !knownBoardValues.includes(currentBoardValue) ? [currentBoardValue, ...knownBoardValues] : knownBoardValues;
  // The exact same "(other)" column also catches a record whose board
  // field is simply null/unset -- an optional board field left blank at
  // creation, or any pre-existing row after a refine added this field as
  // a brand-new column (migrate.ts's additive-only ALTER TABLE always
  // leaves existing rows NULL, regardless of the field's required flag
  // going forward). currentBoardValue is then "" too, but the ternary
  // above only ever adds a non-empty stale value to the option list --
  // it never adds "" itself, so the <select> still has no matching
  // <option> and still blanks out. Mirrors FieldInput's own enum branch,
  // which never hits this because it always renders a disabled "" option
  // unconditionally; this one only needs it for the empty case, since a
  // genuinely stale non-empty value is already shown as its own option.
  const hasEmptyBoardOption = currentBoardValue === "";
  const labelOccurrences = fieldLabelOccurrences(otherFields);
  return (
    <div
      className={hasMoveError ? "board-card board-card-move-error" : "board-card"}
      data-record-id={record.id as number}
      draggable={!readOnly && !bulkActionBusy}
      onDragStart={(e) => {
        if (readOnly || bulkActionBusy) return;
        e.dataTransfer.setData("text/plain", String(record.id));
      }}
      onDragEnd={onDragEnd}
    >
      {otherFields.map((f) => (
        <div key={f.name} className="board-card-field">
          <span className="muted small">{fieldDisplayLabel(f, labelOccurrences)}</span>
          <Cell
            field={f}
            value={record[f.name]}
            lang={lang}
            t={t}
            relationLabel={
              f.type === "relation" ? relationDisplayLabel(f, record[f.name], allEntities, relatedRecords, lang) : undefined
            }
            highlightQuery={highlightQuery}
            onJumpToRecord={onJumpToRecord}
          />
        </div>
      ))}
      <select
        className="board-card-move"
        value={currentBoardValue}
        onChange={(e) => onMove(e.target.value)}
        disabled={readOnly || bulkActionBusy}
      >
        {hasEmptyBoardOption && (
          <option value="" disabled>
            {t("entity.select")}
          </option>
        )}
        {boardOptionValues.map((v) => (
          <option key={v} value={v}>
            {boardField.enumLabels?.[v] ?? v}
          </option>
        ))}
      </select>
      <div className="row-actions">
        {!readOnly && (
          <button type="button" onClick={onEdit}>
            {t("entity.edit")}
          </button>
        )}
        {!readOnly && (
          <button type="button" disabled={bulkActionBusy} onClick={onDuplicate}>
            {t("entity.duplicate")}
          </button>
        )}
        {!readOnly && phoneField && onSendWhatsApp && findRecordPhoneNumber(orderedFields, record) && (
          <button type="button" onClick={() => onSendWhatsApp(findRecordPhoneNumber(orderedFields, record) as string)}>
            {t("entity.sendWhatsApp")}
          </button>
        )}
        <button type="button" onClick={onPrint}>
          {t("entity.print")}
        </button>
        {!readOnly && (
          <button type="button" className="danger" disabled={bulkActionBusy} onClick={onDelete}>
            {t("entity.delete")}
          </button>
        )}
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
  endDateField,
  records,
  month,
  lang,
  t,
  onPrevMonth,
  onNextMonth,
  onToday,
  onJumpToMonth,
  onEdit,
  onPrint,
  onDuplicate,
  onDelete,
  orderedFields,
  phoneField,
  onSendWhatsApp,
  onDayClick,
  onReschedule,
  moveErrorId,
  readOnly = false,
  bulkActionBusy = false,
}: {
  entity: Entity;
  dateField: Field;
  endDateField?: Field | null;
  records: EntityRecord[];
  month: Date;
  lang: Lang;
  t: (key: string, params?: Record<string, string | number>) => string;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
  onJumpToMonth: (month: Date) => void;
  onEdit: (record: EntityRecord) => void;
  /** Round 1272: mirrors BoardCard's own onPrint convention -- Table view's
   * row Print button and BoardCard both always render a Print action,
   * unconditionally even for a read-only viewer (opening the print sheet
   * doesn't write anything), but CalendarView never had an equivalent, so
   * a user viewing an entity in calendar view had no in-view way to print
   * one specific record -- they had to switch to Table view first. */
  onPrint: (record: EntityRecord) => void;
  /** Round 1284: mirrors BoardCard's own onDuplicate/onDelete convention --
   * Table view's row and BoardCard both already offer Duplicate and Delete
   * next to Edit/Print, but CalendarView's record chip only ever got Edit
   * (click) and Print (round 1272 above), leaving Duplicate/Delete as the
   * one remaining way a user viewing calendar view had to switch to Table
   * or Board view to duplicate or delete a specific record. */
  onDuplicate: (record: EntityRecord) => void;
  onDelete: (record: EntityRecord) => void;
  /** Round 1285: mirrors BoardCard's own orderedFields/phoneField/
   * onSendWhatsApp convention -- Table view's row and BoardCard both
   * already offer a Send WhatsApp action (gated on the entity actually
   * having a phone field, a real caller-supplied handler, and this
   * specific record actually having a usable phone number), but
   * CalendarView never got it, leaving Send WhatsApp as the one remaining
   * action a user viewing calendar view still had to switch to Table or
   * Board view for. orderedFields (not just entity.fields) matches
   * BoardCard's own choice, the same column-order the rest of this
   * component already treats as the entity's own current field order. */
  orderedFields: Field[];
  phoneField?: Field | null;
  onSendWhatsApp?: (phoneNumber: string) => void;
  onDayClick: (date: Date) => void;
  onReschedule: (record: EntityRecord, date: Date, originDay?: string) => void;
  moveErrorId?: number | null;
  /** Mirrors BoardCard's own readOnly convention for the identical hazard: the caller already no-ops onEdit/onDayClick/onReschedule for a read-only viewer, but every affordance in here (day-cell click/keyboard/drag-drop, chip drag/click) stayed fully "live" regardless -- a viewer saw a clickable/draggable calendar that silently did nothing. */
  readOnly?: boolean;
  /** Round 1118: mirrors BoardCard's own identical addition -- a bulk batch
   * still in flight must block the chip's own drag-to-reschedule, since
   * dropping it fires the exact same real write a bulk batch's own PATCHes
   * could still be racing. */
  bulkActionBusy?: boolean;
}) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const days = useMemo(
    () => buildCalendarMonth(records, dateField, year, monthIndex, endDateField),
    [records, dateField, endDateField, year, monthIndex],
  );
  const [dragOverDay, setDragOverDay] = useState<string | null>(null);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  // Reaching a date more than a couple of months away (a rental due in 11
  // months, a historical record from 2 years back) previously meant
  // clicking the prev/next chevron that many times -- the month label
  // itself was static, inert text with no way to jump directly to an
  // arbitrary month/year. onJumpToMonth already accepts any Date (the
  // same setCalendarMonth the chevrons and "Today" already call), so this
  // is purely a UI affordance: the label becomes a button that reveals a
  // native month input, and picking a value jumps straight there.
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const monthLabel = month.toLocaleDateString(LOCALE[lang], { month: "long", year: "numeric" });
  const monthInputValue = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
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
        {showMonthPicker ? (
          <input
            type="month"
            className="calendar-month-input"
            value={monthInputValue}
            autoFocus
            onChange={(e) => {
              const [y, m] = e.target.value.split("-").map(Number);
              if (!y || !m) return;
              onJumpToMonth(new Date(y, m - 1, 1));
              setShowMonthPicker(false);
            }}
            onBlur={() => setShowMonthPicker(false)}
          />
        ) : (
          <button type="button" className="calendar-month-label" onClick={() => setShowMonthPicker(true)} aria-label={t("entity.calendar.jumpToMonth")}>
            {monthLabel}
          </button>
        )}
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
          // A read-only viewer gets none of this day cell's write
          // affordances (add-record click, drag-to-reschedule drop target)
          // -- mirrors BoardCard's own readOnly convention: hide/omit the
          // affordance itself, not just no-op the callback underneath it
          // (round 695's own fix for this exact hazard elsewhere in this
          // same file).
          const dayInteractive = day.inCurrentMonth && !readOnly;
          // The drop target is intentionally its OWN flag, not folded into
          // dayInteractive: round 1200 confirmed day.date is always a real,
          // correctly-dated Date for every one of the 42 cells (including
          // the leading/trailing days of adjacent months rendered for a
          // full grid), and handleCalendarDrop/handleMoveFields already
          // operate on that real Date with no month-boundary assumption of
          // their own. Gating the drop target on inCurrentMonth too, as
          // before, meant a ranged record's end could never be dragged
          // across a month boundary even onto a cell already visibly
          // showing the right date -- the single most common case for
          // dragging a multi-night stay. Click-to-add-a-record and
          // keyboard activation stay gated on dayInteractive: an add on a
          // cell that isn't "centered" in the displayed month is a
          // separate, lower-priority affordance question this round
          // doesn't touch.
          const dayDropTarget = !readOnly;
          const isDragOver = dayDropTarget && dragOverDay === dayKey;
          const isToday = day.inCurrentMonth && isSameDay(day.date, new Date());
          const dayClasses = ["calendar-day"];
          if (dayInteractive) {
            dayClasses.push("calendar-day-clickable");
          } else if (!day.inCurrentMonth) {
            dayClasses.push("calendar-day-outside");
          }
          if (isDragOver) dayClasses.push("calendar-day-drag-over");
          if (isToday) dayClasses.push("calendar-day-today");
          return (
          <div
            key={i}
            className={dayClasses.join(" ")}
            onClick={dayInteractive ? () => onDayClick(day.date) : undefined}
            title={dayInteractive ? t("entity.calendar.addOnDay") : undefined}
            onDragOver={
              dayDropTarget
                ? (e) => {
                    e.preventDefault();
                    setDragOverDay(dayKey);
                  }
                : undefined
            }
            onDragLeave={
              dayDropTarget ? () => setDragOverDay((prev) => (prev === dayKey ? null : prev)) : undefined
            }
            onDrop={
              dayDropTarget
                ? (e) => {
                    e.preventDefault();
                    setDragOverDay(null);
                    const [idPart, originDay] = e.dataTransfer.getData("text/plain").split("|");
                    const id = Number(idPart);
                    if (Number.isNaN(id)) return;
                    const record = records.find((r) => (r.id as number) === id);
                    if (record) onReschedule(record, day.date, originDay);
                  }
                : undefined
            }
          >
            <span className="calendar-day-number">{day.date.getDate()}</span>
            {dayInteractive && (
              // Round 1315: a real, separately-focusable <button> for the
              // "add a record on this day" action, replacing the day
              // cell's own role="button"/tabIndex/onKeyDown above. That
              // div directly wraps .calendar-day-records below, which can
              // hold several real <button> elements of its own (the chip,
              // print, duplicate, delete, send-WhatsApp actions) -- an
              // interactive element nested inside another element's own
              // accessible-button role is exactly the "nested interactive
              // controls" shape WCAG 4.1.2 and axe-core's own
              // nested-interactive rule flag: a screen reader focusing the
              // (former) role="button" div announced only its own
              // aria-label as one atomic control, and reliably exposing
              // the real buttons living inside that same accessible
              // subtree is not guaranteed. The div above keeps its plain
              // onClick for mouse users; this button gives keyboard/AT
              // users a non-nested path to the identical action.
              <button
                type="button"
                className="calendar-day-add"
                title={t("entity.calendar.addOnDay")}
                aria-label={t("entity.calendar.addOnDay")}
                onClick={(e) => {
                  // Mirrors every record-action button's own stopPropagation
                  // in this same cell -- without it, this click would also
                  // bubble into the day div's own onClick right above.
                  e.stopPropagation();
                  onDayClick(day.date);
                }}
              >
                +
              </button>
            )}
            <div className="calendar-day-records">
              {(expandedDays.has(dayKey) ? day.records : day.records.slice(0, 3)).map((record) => (
                <div className="calendar-record-row" key={record.id as number}>
                  <button
                    type="button"
                    className={
                      record.id === moveErrorId
                        ? "calendar-record-chip calendar-record-chip-move-error"
                        : "calendar-record-chip"
                    }
                    draggable={!readOnly && !bulkActionBusy}
                    disabled={readOnly}
                    onDragStart={(e) => {
                      if (readOnly || bulkActionBusy) return;
                      // A drag that starts on the record chip must never also
                      // bubble into the day cell's own onClick (Escape/no-drop
                      // still fires a click on release in some browsers) --
                      // stopping propagation here keeps the two interactions
                      // (drag-to-reschedule vs. click-to-edit) from fighting.
                      e.stopPropagation();
                      // A ranged record (e.g. Rental's startDate/endDate) renders this
                      // same chip identically on every day it spans (see
                      // buildCalendarMonth) -- carrying this specific chip instance's
                      // own dayKey lets handleCalendarDrop shift the range by the
                      // days actually dragged, instead of always anchoring the
                      // record's start field to the drop target regardless of which
                      // day of the span was grabbed.
                      e.dataTransfer.setData("text/plain", `${record.id}|${dayKey}`);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDragOverDay(null)}
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
                    {calendarChipLabelValue(labelField, record, lang)}
                  </button>
                  {!readOnly && (
                    // Round 1384: a live Playwright session found that the chip's
                    // drag-to-reschedule above is the ONLY way to move a record to a
                    // different day -- and native HTML5 drag-and-drop (draggable/
                    // onDragStart, same mechanism this whole file's other drag
                    // interactions use) never fires from touch input on any phone or
                    // tablet, with no polyfill anywhere in this codebase. Unlike the
                    // Kanban board's own drag, which already ships a working <select>
                    // fallback for changing a record's status without dragging, the
                    // calendar chip had no touch-usable way to reschedule at all short
                    // of opening the full edit form and retyping both dates by hand.
                    // These two buttons call the exact same onReschedule the chip's
                    // own drag already uses, just shifted by one calendar day from
                    // this chip's own displayed day (dayKey) -- handleCalendarDrop's
                    // existing delta-shift logic (see its own doc comment) already
                    // moves a ranged record's whole span by the days actually
                    // "dragged," so passing dayKey as both the record's current
                    // anchor and the origin reuses that same tested math verbatim,
                    // with no new date arithmetic duplicated here.
                    <>
                      <button
                        type="button"
                        className="calendar-record-move-earlier"
                        title={t("entity.calendar.moveEarlier")}
                        aria-label={t("entity.calendar.moveEarlier")}
                        disabled={bulkActionBusy}
                        onClick={(e) => {
                          e.stopPropagation();
                          const target = new Date(day.date);
                          target.setDate(target.getDate() - 1);
                          onReschedule(record, target, dayKey);
                        }}
                      >
                        ⏪
                      </button>
                      <button
                        type="button"
                        className="calendar-record-move-later"
                        title={t("entity.calendar.moveLater")}
                        aria-label={t("entity.calendar.moveLater")}
                        disabled={bulkActionBusy}
                        onClick={(e) => {
                          e.stopPropagation();
                          const target = new Date(day.date);
                          target.setDate(target.getDate() + 1);
                          onReschedule(record, target, dayKey);
                        }}
                      >
                        ⏩
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="calendar-record-print"
                    title={t("entity.print")}
                    aria-label={t("entity.print")}
                    onClick={(e) => {
                      // Mirrors the chip's own onClick above -- without
                      // stopping propagation, this would also bubble into
                      // the day cell's onDayClick (blank create-record form)
                      // and the chip's own onClick sits right next to it.
                      e.stopPropagation();
                      onPrint(record);
                    }}
                  >
                    🖨️
                  </button>
                  {!readOnly && (
                    <button
                      type="button"
                      className="calendar-record-duplicate"
                      title={t("entity.duplicate")}
                      aria-label={t("entity.duplicate")}
                      disabled={bulkActionBusy}
                      onClick={(e) => {
                        // Mirrors the print button's own stopPropagation
                        // just above -- same day-cell-onDayClick hazard.
                        e.stopPropagation();
                        onDuplicate(record);
                      }}
                    >
                      📋
                    </button>
                  )}
                  {!readOnly && (
                    <button
                      type="button"
                      className="calendar-record-delete danger"
                      title={t("entity.delete")}
                      aria-label={t("entity.delete")}
                      disabled={bulkActionBusy}
                      onClick={(e) => {
                        // Mirrors the print button's own stopPropagation
                        // just above -- same day-cell-onDayClick hazard.
                        e.stopPropagation();
                        onDelete(record);
                      }}
                    >
                      🗑️
                    </button>
                  )}
                  {!readOnly && phoneField && onSendWhatsApp && findRecordPhoneNumber(orderedFields, record) && (
                    <button
                      type="button"
                      className="calendar-record-whatsapp"
                      title={t("entity.sendWhatsApp")}
                      aria-label={t("entity.sendWhatsApp")}
                      onClick={(e) => {
                        // Mirrors the print button's own stopPropagation
                        // just above -- same day-cell-onDayClick hazard.
                        e.stopPropagation();
                        onSendWhatsApp(findRecordPhoneNumber(orderedFields, record) as string);
                      }}
                    >
                      💬
                    </button>
                  )}
                </div>
              ))}
              {day.records.length > 3 && (
                <button
                  type="button"
                  className="calendar-record-more"
                  onClick={(e) => {
                    // Without stopping propagation this would also trigger
                    // the day cell's own onDayClick and pop open a blank
                    // create-record form instead of revealing the hidden
                    // records this button names.
                    e.stopPropagation();
                    setExpandedDays((prev) => {
                      const next = new Set(prev);
                      if (next.has(dayKey)) next.delete(dayKey);
                      else next.add(dayKey);
                      return next;
                    });
                  }}
                >
                  {expandedDays.has(dayKey)
                    ? t("entity.calendar.showLess")
                    : t("entity.calendar.more", { count: day.records.length - 3 })}
                </button>
              )}
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Mirrors the real server-side cap (apps/api/src/routes/projects.ts's own
 * `multer({ limits: { fileSize: 10 * 1024 * 1024 } })`) so an oversized
 * file can be rejected the instant it's picked, before any network request
 * at all -- every other field type here gets this kind of pre-submission
 * validation (required, a number's own native constraint, round 299's own
 * fix for it), but "file" was the one type that always skipped straight to
 * a real upload POST and only learned the file was too large from the
 * server's own rejection after the full multipart body had already been
 * sent.
 */
const MAX_FILE_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;

function FieldInput({
  field,
  value,
  onChange,
  relatedEntity,
  relatedEntityRecords,
  autoFocus,
  onBlur,
  onKeyDown,
  projectId,
  entityName,
  editingId,
  originalValue,
  excludeRecordIds,
  formInstanceKeyRef,
}: {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
  relatedEntity?: Entity;
  relatedEntityRecords?: EntityRecord[];
  /**
   * Round 1037: the record id(s) a self-referencing relation field
   * (field.relationTo === this entity's own name -- e.g. Employee.managerId
   * -> Employee) must never be allowed to point at, because the caller
   * already knows those are exactly the record(s) this edit is about.
   * Without this, nothing anywhere in the stack (this picker,
   * coerceValue/updateRecord, the SQL FOREIGN KEY itself) stopped a record
   * from being set as its own manager/parent -- not a crash (confirmed: no
   * recursive tree-walking feature exists to infinite-loop on it, and a
   * self-referencing row deletes cleanly), just silently nonsensical stored
   * data with no warning anywhere. A record that already has itself as its
   * own value (legacy data, or a direct API write) still shows and keeps
   * that value -- this only blocks *choosing* it going forward, the same
   * "never blank a controlled select for a value that's already there"
   * convention `hasCurrentRelationOption` just below already follows.
   */
  excludeRecordIds?: number[];
  /** Only set by the entity table's inline cell editor (see EntityPanel's
   * editingCell state) -- the plain add/edit form below the table never
   * passes these, so a field there behaves exactly as before. */
  autoFocus?: boolean;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  /** Only needed by the "file" branch below, to reach the upload endpoint
   * -- every other FieldInput call site (inline cell edit, bulk edit)
   * excludes "file" of its own accord (isInlineEditableField for the
   * former, bulkEditableFields' own narrower filter for the latter -- see
   * round 779), so only the plain add/edit form ever actually needs to
   * pass these. */
  projectId?: string;
  entityName?: string;
  /** Round 1002: null while the plain add/edit form is in "create" mode
   * (see EntityPanel's own editingId state), a real record id once it's
   * editing an existing record. The "file" branch below only deletes a
   * just-superseded upload from disk when this is null -- a non-null
   * editingId means `value`'s own previous file is the record's real
   * persisted value (startEdit seeds the form with `{ ...record }`), which
   * deleteReplacedFileFields (round 685) already owns cleaning up once the
   * edit is actually saved; deleting it here, before the user has even
   * submitted the edit, would destroy the still-live record's own file the
   * moment they just replace the picker's selection, with no save and no
   * way back.
   *
   * Round 1123: that guard alone only covers the FIRST replacement in an
   * edit session. Pick replacement1 (not deleted, correctly, per above),
   * then without saving pick replacement2 -- at that second onChange,
   * `value` (about to be superseded) is replacement1's own descriptor,
   * not the record's real persisted file, but the SAME `editingId !==
   * null` check still blocked deleting it too. `form[field.name]` moves
   * on to replacement2 and replacement1 falls out of it entirely --
   * `discardAbandonedFileUploads`/server-side `deleteReplacedFileFields`
   * only ever compare the FINAL form value against the original, so a
   * superseded intermediate upload like this is never referenced by
   * anything again and leaks on disk permanently. `originalValue` (the
   * record's real persisted value for this field, from
   * `editingOriginalRef.current`) lets the branch below tell the two
   * cases apart: `value === originalValue` means `currentFile` IS the
   * untouched persisted file (must survive, as above); `value !==
   * originalValue` means `currentFile` is itself an already-staged,
   * never-persisted upload from this same session, safe to delete the
   * instant it's superseded, exactly like create-form mode. */
  editingId?: number | null;
  originalValue?: unknown;
  /**
   * Round 1193: the "file" branch below's own upload has a real `await`
   * that can easily outlive the specific edit/create session that
   * started it -- the plain add/edit form remounts this component (via
   * EntityPanel's own formInstanceKey bump) the instant the user moves to
   * a different record or starts a new one, WITHOUT cancelling that
   * still-running promise. Unlike a full component unmount (which React
   * itself could in principle guard against), this is a plain async
   * closure that keeps running regardless, and its own `onChange` prop
   * closes only over `setForm`/`field.name` -- neither of which changes
   * between records for the same entity -- so when it resolves, it
   * silently merges this field's just-uploaded file descriptor into
   * WHATEVER form happens to be showing by then, exactly like
   * handleSubmit's own `formInstanceAtSubmitTime` guard (EntityPanel's
   * main component) exists to prevent for the submit path. Optional,
   * since only the plain add/edit form call site actually faces this
   * risk -- the inline-cell-edit and bulk-edit call sites both already
   * exclude "file" fields entirely (see the `projectId`/`entityName` doc
   * comment above), so neither one ever needs this.
   */
  formInstanceKeyRef?: { current: number };
}) {
  const { t, lang } = useTranslation();
  const [fileUploadError, setFileUploadError] = useState<string | null>(null);
  // A relation field with more than a handful of related records (e.g. a
  // CRM's Deal.customer pointing at 150 Customer rows) had no way to
  // narrow the plain <select> below -- a browser's own type-ahead inside
  // an open <select> only jumps to an option whose label *starts with*
  // what's typed, can't match a substring, and is especially unreliable
  // for this app's Hebrew-labeled records. Filters client-side, by
  // recordDisplayLabel (the exact text each <option> already shows), so
  // it narrows the same real options rather than hiding mismatched ones.
  const [relationFilter, setRelationFilter] = useState("");
  if (field.type === "relation" && relatedEntity) {
    // relatedEntityRecords is only populated once EntityPanel's own
    // loadRelated effect resolves its real network fetch -- a useEffect
    // never runs synchronously on the first render, so the add/edit form
    // (rendered unconditionally, with no loading gate of its own) would
    // otherwise fall through to the generic number-input branch below on
    // every single mount, letting a fast user submit an arbitrary,
    // unvalidated foreign-key id before the real options ever existed.
    // A disabled, clearly-labeled placeholder here closes that window.
    if (!relatedEntityRecords) {
      return (
        <select disabled aria-busy="true">
          <option value="">{t("entity.relation.loading")}</option>
        </select>
      );
    }
    // loadRelated's own fetch deliberately swallows ANY failure (network
    // blip, auth race) into an empty array, not undefined -- so a single
    // transient fetch error leaves relatedEntityRecords genuinely empty
    // rather than still-loading. Without this fallback, a record whose
    // relation field already holds a real id would have no matching
    // <option> and the browser would silently blank the controlled select,
    // the same "stale value has no <option>" bug class the enum branch
    // below already guards against (round 508).
    const currentRelationId = value === "" || value === null || value === undefined ? null : Number(value);
    // Round 1037: a record that's already set as its own relation value
    // (legacy data, or a direct API write) stays selectable and visible --
    // this only blocks *picking* a now-excluded id going forward, mirroring
    // hasCurrentRelationOption's own "never blank a controlled select for a
    // value that's already there" rule just below.
    const excludedIds = excludeRecordIds?.length ? new Set(excludeRecordIds) : null;
    const selectableRecords =
      excludedIds && excludedIds.size > 0
        ? relatedEntityRecords.filter((r) => !excludedIds.has(Number(r.id)) || Number(r.id) === currentRelationId)
        : relatedEntityRecords;
    const hasCurrentRelationOption = currentRelationId === null || selectableRecords.some((r) => Number(r.id) === currentRelationId);
    const trimmedFilter = relationFilter.trim().toLowerCase();
    // The current value's own option (including the "#id" fallback above)
    // must always stay visible regardless of the filter text -- otherwise
    // typing a filter that doesn't match the already-selected record would
    // blank the controlled <select> the instant its matching option
    // disappears, the same "stale value has no <option>" hazard this
    // branch's own hasCurrentRelationOption fallback already guards
    // against for a different cause.
    const filteredRecords =
      trimmedFilter === ""
        ? selectableRecords
        : selectableRecords.filter(
            (r) => Number(r.id) === currentRelationId || recordDisplayLabel(relatedEntity, r, lang).toLowerCase().includes(trimmedFilter),
          );
    return (
      <div className="relation-field-input">
        {relatedEntityRecords.length > 5 && (
          <input
            type="text"
            className="relation-filter-input"
            value={relationFilter}
            onChange={(e) => setRelationFilter(e.target.value)}
            placeholder={t("entity.relation.filterPlaceholder")}
            aria-label={t("entity.relation.filterPlaceholder")}
          />
        )}
        <select
          required={field.required}
          value={value === "" || value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          autoFocus={autoFocus}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
        >
          <option value="">{t("entity.select")}</option>
          {!hasCurrentRelationOption && <option value={currentRelationId as number}>{`#${currentRelationId}`}</option>}
          {filteredRecords.map((r) => (
            <option key={r.id as number} value={r.id as number}>
              {recordDisplayLabel(relatedEntity, r, lang)}
            </option>
          ))}
        </select>
      </div>
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
    // A record can carry a legacy value no longer in field.enumValues (e.g.
    // after an AI refine renamed/restructured the field's options --
    // migrate.ts only ever adds columns, it never rewrites existing row
    // data). Without an <option> for it, the controlled value below matches
    // nothing and the browser silently blanks the select instead of showing
    // the record's real stored value (same root cause BoardCard's own move
    // select has, see its own comment).
    const currentEnumValue = String(value ?? "");
    const knownEnumValues = uniqueEnumValues(field.enumValues);
    const enumOptionValues = currentEnumValue && !knownEnumValues.includes(currentEnumValue) ? [currentEnumValue, ...knownEnumValues] : knownEnumValues;
    return (
      <select
        required={field.required}
        value={currentEnumValue}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      >
        {/* Round 981: this placeholder used to be unconditionally disabled,
            unlike the relation branch's own identical "no value" placeholder
            just above (never disabled). Once a non-required enum field had
            any real value chosen, there was no way to pick this option again
            and clear it back to empty -- every other optional field type
            (text, number, date, relation, file) already lets a user reach
            that state. A required field still can't be left here: the same
            missingField/commitInlineEdit/handleBulkUpdate checks that
            already block an empty relation selection block this too. */}
        <option value="">{t("entity.select")}</option>
        {enumOptionValues.map((v) => (
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
        required={field.required}
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
    // Round 980: a real "number" business field -- price, amount, rating,
    // a balance delta -- can legitimately be negative, but typing one into
    // an empty <input type="number"> never worked: the HTML spec's own
    // number-input value-sanitization algorithm requires at least one
    // digit before it reports anything through .value, so a lone "-" (the
    // first character of any negative number typed from empty) made the
    // NATIVE input itself report e.target.value as "" -- confirmed
    // directly in jsdom and matching real Chrome/Firefox, independent of
    // this component's own (now-removed) eager Number(value) coercion.
    // There was no way to type a negative number starting from empty. A
    // "relation" field's raw value is always a non-negative integer
    // foreign-key id with no such need, so it keeps the native number
    // input (and its default step of 1) unchanged; only a real "number"
    // field switches to a plain text input with a numeric mobile keyboard
    // hint, which never applies that sanitization and so never eats a
    // leading "-" (or, for the same reason, a leading decimal point).
    const isPlainNumberField = field.type === "number";
    return (
      <input
        type={isPlainNumberField ? "text" : "number"}
        inputMode={isPlainNumberField ? "decimal" : undefined}
        required={field.required}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
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
        required={field.required}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
    );
  }
  if (field.type === "file") {
    const currentFile = parseFileFieldValue(value);
    // Round 1123: see this component's own `originalValue` doc comment
    // above -- a create-form upload (editingId === null) was always safe
    // to delete on replace/remove, and now so is an edit-form upload that
    // ISN'T the record's real persisted value (value !== originalValue):
    // it's itself an already-staged, never-persisted upload from this
    // same session, not the live record's own file.
    const currentFileIsDisposable = editingId === null || value !== originalValue;
    return (
      <div className="file-field-input">
        {currentFile && (
          <span className="file-field-current">
            <a href={currentFile.url} target="_blank" rel="noopener noreferrer">
              {currentFile.name}
            </a>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                // Round 1002/1123: see this component's own originalValue
                // doc comment -- only a disposable upload (create-form,
                // or an edit-form upload that already isn't the record's
                // real persisted value) is safe to delete from disk the
                // instant it's removed.
                if (currentFileIsDisposable && projectId && entityName) {
                  deleteUploadedRecordFile(projectId, entityName, field.name, currentFile.url).catch(() => {});
                }
                onChange("");
              }}
            >
              {t("entity.file.remove")}
            </button>
          </span>
        )}
        <input
          type="file"
          required={field.required && !currentFile}
          aria-label={t("entity.file.choose")}
          autoFocus={autoFocus}
          onBlur={onBlur}
          onChange={async (e) => {
            const chosen = e.target.files?.[0];
            e.target.value = "";
            if (!chosen || !projectId || !entityName) return;
            setFileUploadError(null);
            if (chosen.size > MAX_FILE_UPLOAD_SIZE_BYTES) {
              setFileUploadError(t("entity.file.tooLarge"));
              return;
            }
            // Round 1193: snapshot of the edit/create session this pick
            // belongs to, captured before the real await below -- see this
            // component's own formInstanceKeyRef doc comment above.
            const pickedAtInstance = formInstanceKeyRef?.current;
            try {
              const uploaded = await uploadRecordFile(projectId, entityName, field.name, chosen);
              if (formInstanceKeyRef && formInstanceKeyRef.current !== pickedAtInstance) {
                // The user has already moved on to a different record or a
                // fresh create -- the FieldInput instance that started
                // this upload no longer exists, and this same `onChange`
                // closure would otherwise merge straight into whatever
                // form happens to be showing now (it closes only over
                // `setForm`/`field.name`, neither of which changes between
                // records for the same entity). Clean up this file
                // directly instead -- nothing else will ever reference it.
                void deleteUploadedRecordFile(projectId, entityName, field.name, uploaded.url).catch(() => {});
                return;
              }
              // Round 1002/1123: see this component's own originalValue
              // doc comment -- the file this upload just replaced is only
              // safe to delete from disk when it wasn't a persisted value
              // to begin with (create-form mode, or an edit-form upload
              // that's itself already a staged, never-persisted
              // replacement from this same session).
              if (currentFileIsDisposable && currentFile) {
                deleteUploadedRecordFile(projectId, entityName, field.name, currentFile.url).catch(() => {});
              }
              onChange(JSON.stringify(uploaded));
            } catch (err) {
              setFileUploadError(err instanceof Error ? err.message : String(err));
            }
          }}
        />
        {fileUploadError ? <p role="alert">{fileUploadError}</p> : <p className="muted small">{t("entity.file.maxSize")}</p>}
      </div>
    );
  }
  return (
    <input
      type="text"
      required={field.required}
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
  userId,
  onEntityRenamed,
  highlightRecordId,
  onHighlightHandled,
  createPrefill,
  onCreatePrefillHandled,
  createDateFilter,
  onCreateDateFilterHandled,
  onJumpToRecord,
  onSendWhatsApp,
  onRecordCountChange,
  readOnly = false,
}: {
  projectId: string;
  entity: Entity;
  allEntities: Entity[];
  userId: string;
  onEntityRenamed: (project: Project) => void;
  /** True for a "viewer" collaborator -- the server already rejects every write here with 403 VIEWER_READ_ONLY; this just keeps a viewer from clicking a control that can only ever fail. */
  readOnly?: boolean;
  /** A record id to scroll to and highlight once loaded, e.g. after a global-search "jump to record" click. */
  highlightRecordId?: number | null;
  /** Called once the incoming highlightRecordId has actually been applied, so the caller can clear it and not re-trigger on the next render. */
  onHighlightHandled?: () => void;
  /** A single field+value to pre-fill the create form with once this entity's tab is open, e.g. from WhatsAppPanel's own "create new record from this message" button -- mirrors startCreateForColumn's own shape, just driven from outside rather than a click inside this panel. */
  createPrefill?: { fieldName: string; value: string } | null;
  /** Called once the incoming createPrefill has actually been applied, so the caller can clear it and not re-trigger on the next render -- the same convention onHighlightHandled above already uses for highlightRecordId. */
  onCreatePrefillHandled?: () => void;
  /** A single field + raw filter value to apply as this entity's own toolbar filter once its tab is open, e.g. from Business Twin's own overdue/dueSoon stat tiles or an enum/boolean distribution bar -- mirrors createPrefill's own shape. Round 1343: value widened from the literal "overdue"/"dueSoon" to a plain string since this effect was already fully generic (see its own body below) and distribution bars now reuse it with a field's raw breakdown value. */
  createDateFilter?: { fieldName: string; value: string } | null;
  /** Called once the incoming createDateFilter has actually been applied, so the caller can clear it and not re-trigger on the next render -- the same convention onCreatePrefillHandled above uses for createPrefill. */
  onCreateDateFilterHandled?: () => void;
  /** Called when a relation cell's value (in the table or a board card) is clicked, so the caller can switch to the target entity's own tab and highlight that record there -- the same "jump to record" mechanism Global Search, WhatsApp log, and Business Twin already trigger from their own panels. */
  onJumpToRecord?: (targetEntity: string, recordId: number) => void;
  /** Called with a record's raw phone-field value when the row's "Send WhatsApp" action is clicked, so the caller can open the WhatsApp panel with that number prefilled -- the reverse direction of onJumpToRecord, which already exists for an inbound WhatsApp message resolving to a record. */
  onSendWhatsApp?: (phoneNumber: string) => void;
  /** Called whenever this entity's own record count changes (initial load, create, delete, bulk-delete, duplicate, import, undo...), so the caller can keep an entity-tab record-count badge in sync without threading a callback through every individual mutation handler -- `records` is already the one state array every mutation funnels through. */
  onRecordCountChange?: (entityName: string, count: number) => void;
}) {
  const { t, lang } = useTranslation();
  const [records, setRecords] = useState<EntityRecord[]>([]);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const pendingDeleteRef = useRef<PendingDelete | null>(null);
  const [form, setForm] = useState<Record<string, unknown>>(() => emptyForm(entity));
  // Round 1036: mirrors `form` for the unmount-cleanup effect below --
  // that effect's own cleanup closure only ever sees whatever `form` was
  // at the moment the effect last ran (near-empty deps, so effectively
  // once per mount), never a later value a real edit set after that. Same
  // pattern as WhatsAppPanel.tsx's own round-1005 `testAttachmentRef`. Not
  // named `formRef` -- that name is already taken below by the actual
  // <form> DOM element ref.
  const formValueRef = useRef(form);
  formValueRef.current = form;
  // The record startEdit snapshotted `form` from, kept separately from
  // `form` itself (which the user's own keystrokes mutate field-by-field)
  // so handleSubmit can tell which fields the user actually touched. See
  // handleSubmit's own comment for why this matters.
  const editingOriginalRef = useRef<EntityRecord | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  // Forces a fresh FieldInput instance (via its own key below) every time
  // the form's real target changes -- a different record to edit, a new
  // blank create, or a successful submit -- so a file field's own
  // fileUploadError and a relation field's own relationFilter (both
  // FieldInput-local state, deliberately not lifted into this component)
  // can never survive into an unrelated record/field. editingId alone
  // can't do this: it stays null across two consecutive "create new"
  // sessions (including right after a successful create), so a stale
  // error from one new-record attempt would otherwise still be showing
  // under the very next one.
  const [formInstanceKey, setFormInstanceKey] = useState(0);
  // Mirrors formInstanceKey's own value, but synchronously, so a slow
  // handleSubmit awaiting updateRecord/createRecord can tell -- once that
  // await finally resolves -- whether the form has since moved on to a
  // different editing session (a different record's startEdit, a fresh
  // startCreateNew/startCreateForDate/startCreateForColumn, or the
  // in-form Delete button's own reset) before unconditionally resetting
  // it back to blank. formInstanceKey itself can't answer this: it's a
  // React state value, frozen in handleSubmit's own closure at whatever
  // it was when that specific submit began, the same reason
  // refreshRequestId below needs its own ref rather than reading
  // formInstanceKey's state directly.
  const formInstanceKeyRef = useRef(0);
  function bumpFormInstanceKey() {
    formInstanceKeyRef.current += 1;
    setFormInstanceKey(formInstanceKeyRef.current);
  }
  // Round 1333: the record-form's own create/edit draft is this app's
  // highest-traffic typed input of all, yet unlike the 6 dialogs
  // useBeforeUnloadWarning.ts already covers (round 1331), it had no
  // warning before a tab close/refresh/navigation silently discarded it --
  // left open by that round specifically because this form has no existing
  // named "is there a real draft" boolean to reuse (it's always mounted,
  // not behind an open/closed toggle). Reuses handleSubmit's own
  // `changedOnly` diff logic (same file, same editingOriginalRef) for edit
  // mode, and emptyForm(entity) -- the exact baseline startCreateNew/the
  // success path already reset to -- for create mode, rather than
  // inventing a third comparison.
  const formIsDirty = editingId != null
    ? entity.fields.some((f) => form[f.name] !== editingOriginalRef.current?.[f.name])
    : entity.fields.some((f) => form[f.name] !== emptyForm(entity)[f.name]);
  useBeforeUnloadWarning(formIsDirty);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [recentSearches, setRecentSearches] = useState<string[]>(() => getEntityRecentSearches(projectId, entity.name, userId));
  const [fieldFilters, setFieldFilters] = useState<Record<string, string>>({});
  const [groupFieldName, setGroupFieldName] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [collapsedBoardColumns, setCollapsedBoardColumns] = useState<Set<string>>(new Set());
  const [sortKeys, setSortKeys] = useState<SortKey[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkEditField, setBulkEditField] = useState("");
  const [bulkEditValue, setBulkEditValue] = useState<unknown>("");
  // handleBulkDelete clears selectedIds synchronously, before any await, so
  // the bulk-actions-bar (gated on selectedIds.size > 0) vanishes on the
  // very next render and a second click can't land. handleBulkDuplicate and
  // handleBulkUpdate below have no such synchronous step -- selectedIds is
  // only touched after their own Promise.allSettled resolves -- so without
  // this flag, double-clicking "Duplicate Selected" while the first batch
  // was still in flight started a second, fully independent batch of
  // createRecord calls for the same ids, duplicating every selected record
  // twice instead of once (round 544).
  const [bulkActionBusy, setBulkActionBusy] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  // Round 1006: the calendar view's "Subscribe" button's own status,
  // mirroring copyStatus's exact idle/copied/failed shape just above.
  const [subscribeStatus, setSubscribeStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [relatedRecords, setRelatedRecords] = useState<RelatedRecordsByEntity>({});
  const [importBusy, setImportBusy] = useState(false);
  // Round 1363: the one write path in this whole writesInFlight family that
  // never had ANY busy flag of its own -- handleSubmit's createRecord/
  // updateRecord await had nothing tracking it while in flight, so its own
  // Save/Add button stayed enabled for the whole round trip. A fast double
  // click fired handleSubmit twice before the first network response came
  // back (writesInFlight's bulk/import guard, added round 1264, does
  // nothing here since neither a bulk batch nor an import is running) --
  // two independent POSTs, two duplicate records, and a record_created
  // automation (WhatsApp/email/webhook) firing twice for one click.
  const [submitBusy, setSubmitBusy] = useState(false);
  // Round 1260: bulkActionBusy and importBusy were two fully independent
  // flags guarding the exact same hazard -- a batch of concurrent writes
  // (Promise.allSettled) still in flight racing some OTHER write to one of
  // the same records. Rounds 1117/1118 cross-gated every bulk/single action
  // against bulkActionBusy, but CSV/JSON import (round 1241, added after
  // those rounds) was never wired into that network: an import's PATCH to
  // an existing row (id column round-tripped) could land after a delete the
  // user fired mid-import, resurrecting a record the optimistic UI already
  // removed, and the reverse (bulk delete racing an import's POST of a new
  // record) was just as possible. This single combined flag is read
  // everywhere bulkActionBusy used to guard/disable, so the two batches are
  // now mutually exclusive with everything else that writes. Round 1363
  // folded submitBusy in alongside them for the same reason.
  const writesInFlight = bulkActionBusy || importBusy || submitBusy;
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [showImportErrors, setShowImportErrors] = useState(false);
  // Round 1241: advisory possible-duplicate warnings from buildImportRecords/
  // buildImportRecordsFromJson -- kept separate from importErrors (never
  // blocks a row, so it's not a "problem" in that sense), mirroring the
  // same toggle-to-reveal UI those already use.
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [showImportWarnings, setShowImportWarnings] = useState(false);
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
  // Which record's last inline-edit/drag-move PATCH failed -- handleMove and
  // commitInlineEdit both used to only ever show a generic error banner far
  // from the actual row/card/chip (near the top of the panel), with zero
  // in-place indication of which specific record the failure was even
  // about. Cleared on a timer below, same pattern as highlightedRecordId.
  const [moveErrorId, setMoveErrorId] = useState<number | null>(null);
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
  const endDateField = useMemo(() => (dateField ? findEndDateField(entity.fields, dateField) : null), [entity.fields, dateField]);
  // Only used as a cheap "does this entity even have a phone-like field at
  // all" gate below -- which actual field holds a given RECORD's real
  // number is looked up per-record via findRecordPhoneNumber instead (a
  // record can have its own phone-like field blank while a sibling
  // phone-like field on that same record holds a real number).
  const phoneField = useMemo(() => findPhoneField(entity.fields), [entity.fields]);
  const relationTargets = useMemo(() => {
    const names = entity.fields
      .filter((f) => f.type === "relation" && f.relationTo)
      .map((f) => f.relationTo!);
    // Round 1162: case-insensitive, mirroring migrate.ts's own round-1159
    // fix -- without it, a relation field whose relationTo differed from
    // its target entity's current name only by letter case was excluded
    // from this list entirely, so its related records were never even
    // fetched (see findEntity's own round-1162 doc comment in
    // routes/projects.ts for why the fetch itself would 404 without that
    // server-side fix too).
    return [...new Set(names)].filter((name) => allEntities.some((e) => e.name.toLowerCase() === name.toLowerCase()));
  }, [entity.fields, allEntities]);

  useEffect(() => {
    let cancelled = false;
    // A self-referencing relation target (entity.name itself, e.g.
    // Category.parentCategoryId -> Category) is deliberately excluded from
    // this effect's own fetch -- refresh() below already owns keeping
    // relatedRecords[entity.name] in sync (round 438), merging a
    // newly-created record in immediately. Fetching it here too made this
    // effect a SECOND writer of that same slot: if this effect's own
    // mount-time fetch happened to resolve after refresh() had already
    // merged a freshly-created record in, this effect's stale,
    // pre-creation snapshot would wholesale-replace relatedRecords,
    // silently undoing round 438's fix the moment a user created a
    // same-entity record quickly enough (round 540).
    // Round 1237: these two used to compare each raw relationTo string
    // against entity.name with exact-case equality -- relationTargets
    // itself is only ever filtered case-insensitively against allEntities
    // above (round 1162), never normalized to the target's own canonical
    // casing. A self-referencing field whose relationTo differs from its
    // own entity's current name only by letter case (the same ordinary-
    // refine drift documented at this exact useMemo's own round-1162
    // comment) was wrongly treated as pointing to a DIFFERENT entity --
    // see refresh()'s own matching fix below for why that's reachable in
    // practice, not just theoretical.
    const selfReferencingTargets = relationTargets.filter((name) => name.toLowerCase() === entity.name.toLowerCase());
    const otherTargets = relationTargets.filter((name) => name.toLowerCase() !== entity.name.toLowerCase());
    async function loadRelated() {
      if (otherTargets.length === 0) {
        if (!cancelled) {
          // Preserve by each self-referencing target's own RAW relationTo
          // string, not entity.name -- the picker below reads
          // relatedRecords[f.relationTo] verbatim, so when that string's
          // casing differs from entity.name, preserving under entity.name
          // instead would both miss the real data under its own key AND
          // write a second, never-read key alongside it.
          setRelatedRecords((prev) => {
            const preserved: typeof prev = {};
            for (const name of selfReferencingTargets) preserved[name] = prev[name];
            return preserved;
          });
        }
        return;
      }
      const entries = await Promise.all(
        otherTargets.map(async (name) => {
          try {
            const { records: related } = await listRecords(projectId, name);
            return [name, related] as const;
          } catch {
            return [name, []] as const;
          }
        }),
      );
      if (!cancelled) {
        setRelatedRecords((prev) => {
          const preserved: typeof prev = {};
          for (const name of selfReferencingTargets) preserved[name] = prev[name];
          return { ...Object.fromEntries(entries), ...preserved };
        });
      }
    }
    void loadRelated();
    return () => {
      cancelled = true;
    };
  }, [projectId, relationTargets, entity.name]);

  /**
   * Reports this entity's own record count back to the caller whenever
   * `records` changes -- every mutation (create/delete/bulk-delete/
   * duplicate/import/undo) already funnels through `setRecords`, so this
   * one effect covers all of them without a separate call site per
   * mutation. Same "report back via an optional callback, deliberately
   * left out of the deps array since it may be a fresh inline arrow
   * function on every parent render" idiom as onHighlightHandled's own
   * effect further down.
   */
  useEffect(() => {
    onRecordCountChange?.(entity.name, records.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.name, records.length]);

  // Moved above the refresh/reset effect below (round 1387) so that effect
  // can depend on it too -- see that effect's own comment. Still read by
  // the hiddenFields/sortKeys effects further down this file, same as
  // before.
  const fieldNamesKey = useMemo(() => entity.fields.map((f) => f.name).join(","), [entity.fields]);

  /**
   * A record mid-undo-window (handleDelete/handleBulkDelete's own
   * pendingDeleteRef) still genuinely exists server-side -- its real
   * DELETE is deliberately deferred, see commitPendingDelete's own comment
   * -- so `listRecords` still returns it. Without this filter, refresh()
   * (called by seven unrelated handlers below: create/edit, duplicate,
   * bulk-duplicate, bulk-update, CSV import, board-move, inline-edit) would
   * silently resurrect a row the user just deleted and is still looking at
   * an "Undo" toast for, the moment any of those unrelated actions runs
   * during that same window -- then the deferred DELETE fires for real
   * once the window closes, leaving a ghost row in view that no longer
   * exists on the server. Worse, clicking Undo afterwards would re-splice
   * the same record in via restoreRecordAt (which has no de-duplication of
   * its own), producing two rows for one id. Excluding pending-delete ids
   * here keeps every refresh() consistent with what the user actually sees
   * (already-"deleted" rows stay gone) regardless of which handler
   * triggered it.
   */
  async function refresh() {
    const requestId = ++refreshRequestId.current;
    setLoading(true);
    setLoadError(null);
    try {
      const { records } = await listRecords(projectId, entity.name);
      if (refreshRequestId.current !== requestId) return;
      const pendingIds = new Set(pendingDeleteRef.current?.entries.map((e) => e.id) ?? []);
      const visible = pendingIds.size === 0 ? records : records.filter((r) => !pendingIds.has(r.id as number));
      setRecords(visible);
      // A self-referencing relation field (e.g. Category.parentCategoryId ->
      // Category, Employee.managerId -> Employee -- schema-legal, see
      // FieldSchema's own relation refine) makes this entity its own
      // relation target. relatedRecords[<that field's own relationTo
      // string>] is otherwise only ever populated once, by the loadRelated
      // effect above, and never kept in sync with a record this very
      // refresh() just created/edited -- silently hiding a newly-created
      // record from every relation picker (and display label) pointing
      // back at this same entity until a full remount. A relation to a
      // *different* entity doesn't need this: the only way to create a
      // record there is switching to its own tab, which remounts this
      // component and refetches everything fresh.
      // Round 1237: this used to key the write by entity.name and guard it
      // with an exact-case `.includes(entity.name)` -- but the picker
      // below reads relatedRecords[f.relationTo] verbatim (its own raw
      // string, never normalized), and relationTargets holds exactly that
      // raw string too. When a self-referencing field's relationTo
      // differed from entity.name only by letter case, the guard never
      // fired at all, so this merge silently never ran -- and even if it
      // had, writing under entity.name would have updated a key the
      // picker never reads. Using each matching raw relationTargets
      // string (there can legitimately be more than one, if two fields on
      // this entity self-reference with different relationTo casing)
      // fixes both at once.
      const selfReferencingTargets = relationTargets.filter((name) => name.toLowerCase() === entity.name.toLowerCase());
      if (selfReferencingTargets.length > 0) {
        setRelatedRecords((prev) => {
          const updates: typeof prev = {};
          for (const name of selfReferencingTargets) updates[name] = visible;
          return { ...prev, ...updates };
        });
      }
    } catch (err) {
      if (refreshRequestId.current !== requestId) return;
      setLoadError((err as Error).message);
    } finally {
      if (refreshRequestId.current === requestId) setLoading(false);
    }
  }

  // Round 1387: a Time Machine restore or a Refine can change which fields
  // exist on the CURRENTLY ACTIVE entity without changing its name (e.g.
  // restoring a checkpoint that brings a dropped field back) -- App.tsx
  // keys this panel's own React element by entity.name alone (see its own
  // `key={entity.name}`), so React re-renders the SAME mounted instance
  // with a new `entity` object rather than remounting it. This effect used
  // to depend on [entity.name] only, so it never re-ran refresh() for that
  // case, leaving `records` holding whatever rowToRecord (repository.ts)
  // returned BEFORE the field existed again -- which never had that
  // field's own key at all, since rowToRecord only emits keys for fields
  // present in the CURRENT spec at fetch time. The already-rendered table
  // then showed every row's restored column as blank, even though the
  // real column data was never touched server-side (a plain tab switch,
  // which does remount, immediately showed the real values again) --
  // directly undercutting Time Machine's own "nothing here deletes
  // existing data" promise right after a successful restore.
  //
  // Only a field NAME that genuinely wasn't present before now (added by a
  // refine, or a dropped field reappearing via restore) needs this -- a
  // field being REMOVED never does: the already-fetched `records` simply
  // keep one extra, now-ignored key, which is harmless (this is the same
  // "removal alone needs no correction" reasoning columnWidths/sortKeys'
  // own fieldNamesKey-keyed effects below already rely on, just applied to
  // a refetch instead of a persisted-preference filter). Without this
  // narrower check, EVERY field-list change -- including a pure removal --
  // would re-run refresh() and its own `loading` flip, which replaces the
  // whole table with a loading state for a moment (see the `loading ? ...`
  // branch below) for no reason: nothing was ever stale in the
  // removal-only case. seenFieldNamesRef starts at `null` so the very
  // first render (mount) always treats every field as "new" and refreshes,
  // matching this effect's original always-fetch-on-mount behavior.
  const seenFieldNamesRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const currentFieldNames = entity.fields.map((f) => f.name);
    const hasNewField = seenFieldNamesRef.current === null || currentFieldNames.some((name) => !seenFieldNamesRef.current!.has(name));
    seenFieldNamesRef.current = new Set(currentFieldNames);
    if (!hasNewField) return;

    setForm(emptyForm(entity));
    setEditingId(null);
    setSearch("");
    setCalendarMonth(new Date());
    setSelectedIds(new Set());
    setImportMessage(null);
    setImportErrors([]);
    setShowImportErrors(false);
    setColumnsMenuOpen(false);
    setEditingCell(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.name, fieldNamesKey]);

  // Same reasoning as hiddenFields' own effect just above -- this entity's
  // recent search history is scoped per project+entity too.
  useEffect(() => {
    setRecentSearches(getEntityRecentSearches(projectId, entity.name, userId));
  }, [projectId, entity.name]);

  // Same reasoning as hiddenFields' own effect just above -- a reordered
  // column layout is scoped per project+entity too.
  useEffect(() => {
    setColumnOrderState(getColumnOrder(projectId, entity.name, userId));
  }, [projectId, entity.name, userId]);

  // Same reasoning as hiddenFields' own effect just above -- a chosen "Group
  // by" field is scoped per project+entity too. Previously groupFieldName
  // was reset to "" on every entity switch (see the combined reset effect
  // above) and never persisted at all, so picking a grouping didn't survive
  // even a reload of the same entity.
  // Round 838: validates the just-loaded choice against the field type that
  // was on record the moment it was last chosen (see getGroupByFieldType's
  // own doc comment) -- the identical "field TYPE changes while its NAME
  // survives" hazard round 780 already fixed, just reached via unmounting
  // this entity's own tab (switching away) rather than staying mounted
  // through a live refine. Round 780's own in-memory ref has nothing to
  // compare against on a brand-new mount, so a refine that retypes the
  // grouped field while its tab was NOT the active one left the persisted
  // selection grouping real records under a fabricated split the instant
  // the tab reopened. A loaded field with no recorded type yet (a choice
  // persisted before this round shipped) is trusted as-is, same as before.
  // Round 985: also tolerates a pure case-only field rename reached the
  // same way (tab closed during the refine, then reopened) -- an exact
  // name match can't tell that apart from the field being removed outright,
  // so without this a mere letter-casing normalization (e.g. "status" ->
  // "Status") silently cleared the user's own "Group by" choice instead of
  // just carrying it forward under its new spelling.
  useEffect(() => {
    const loaded = getGroupByField(projectId, entity.name, userId);
    if (loaded) {
      const exactField = entity.fields.find((f) => f.name === loaded);
      const renamedField = exactField ? undefined : entity.fields.find((f) => f.name.toLowerCase() === loaded.toLowerCase());
      const currentType = exactField?.type ?? renamedField?.type;
      const recordedType = getGroupByFieldType(projectId, entity.name, userId);
      if (!currentType || (recordedType && recordedType !== currentType)) {
        setGroupFieldName(setGroupByField(projectId, entity.name, userId, ""));
        setGroupByFieldType(projectId, entity.name, userId, "");
        return;
      }
      if (renamedField) {
        setGroupFieldName(setGroupByField(projectId, entity.name, userId, renamedField.name));
        return;
      }
    }
    setGroupFieldName(loaded);
  }, [projectId, entity.name, userId]);

  // Same reasoning as groupFieldName's own effect just above -- which
  // groups are collapsed is scoped per project+entity+groupFieldName
  // (also re-running whenever groupFieldName itself changes): groupRecordsByField's
  // own group keys are field-independent (every boolean field's two groups
  // are keyed by the literal strings "true"/"false"), so without
  // groupFieldName in the key, switching "Group by" from one boolean field
  // to another carried over the first field's collapsed set onto the
  // second, silently hiding rows the person never chose to hide there.
  //
  // A collapsed group's own key is the field's raw stored value (an enum
  // value, or "true"/"false" for boolean) -- but unlike groupFieldName's
  // own type-staleness guard above, nothing here re-validated that value
  // against the field's CURRENT enumValues. A refine renaming or removing
  // an enum value (e.g. "Closed" -> "Done") doesn't touch existing
  // records' own stored "Closed" strings (migrations are additive-only),
  // so those records' own group moved from a key named "Closed" to the
  // synthetic "(other)" bucket (otherGroupKey) -- a DIFFERENT key the
  // stale "Closed" entry in collapsedGroups never matches. The group the
  // user had deliberately collapsed silently reappeared fully expanded,
  // with no action by the user and no way to re-collapse the dead key
  // back (a value that no longer exists can't be clicked in the UI).
  // Boolean fields have a fixed, never-stale value space ("true"/"false"
  // always), so only the enum case needs filtering.
  const groupFieldEnumValuesKey = useMemo(() => {
    const field = entity.fields.find((f) => f.name === groupFieldName);
    return field?.type === "enum" ? (field.enumValues ?? []).join(",") : "";
  }, [entity.fields, groupFieldName]);
  // Round 1008: migrateCollapsedGroupsFieldCase (not a plain getCollapsedGroups)
  // -- groupFieldName's own case-only-rename remap (its effect above) updates
  // this state to the new spelling, which then re-fires THIS effect looking
  // up a key nothing was ever written under, silently re-expanding a group
  // the user had deliberately collapsed under the field's old casing. See
  // that function's own doc comment for the full mechanism.
  useEffect(() => {
    const loaded = migrateCollapsedGroupsFieldCase(projectId, entity.name, groupFieldName, userId);
    const field = entity.fields.find((f) => f.name === groupFieldName);
    if (field?.type !== "enum") {
      setCollapsedGroups(new Set(loaded));
      return;
    }
    const validValues = new Set(field.enumValues ?? []);
    const filtered = loaded.filter((v) => validValues.has(v));
    if (filtered.length !== loaded.length) setCollapsedGroupsPreference(projectId, entity.name, groupFieldName, userId, filtered);
    setCollapsedGroups(new Set(filtered));
  }, [projectId, entity.name, groupFieldName, userId, groupFieldEnumValuesKey]);

  /** Toggles one group's collapsed state and persists the full updated set, mirroring handleFieldFilterChange's write-through-to-storage pattern. */
  function toggleGroupCollapsed(groupKey: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      setCollapsedGroupsPreference(projectId, entity.name, groupFieldName, userId, [...next]);
      return next;
    });
  }

  // Same reasoning as collapsedGroups' own effect just above -- which
  // board columns are collapsed is scoped per project+entity+boardField
  // too (also re-running whenever boardField itself changes), in its own
  // separate store (board columns and table groups can be keyed by
  // different fields, so sharing storage would conflate the two).
  // boardField isn't a user choice like groupFieldName -- findBoardField
  // recomputes it from entity.fields on every render -- but editing the
  // entity's fields (add/remove/reorder/rename to or from "status"/
  // "stage") can still silently swap which field it resolves to, and
  // without this in the key the newly-chosen field would inherit
  // whichever columns were collapsed under the field that used to hold
  // that role.
  const boardFieldName = boardField?.name ?? "";
  // Same reasoning as collapsedGroups' own enum-staleness guard just
  // above -- findBoardField only ever resolves to an enum field, so a
  // refine renaming/removing one of its enumValues leaves a collapsed
  // column's own key (the old enum value) matching nothing once those
  // records move to the board's own "(other)" column instead, silently
  // re-expanding a column the user had deliberately collapsed.
  const boardFieldEnumValuesKey = useMemo(() => (boardField?.enumValues ?? []).join(","), [boardField]);
  // Round 1008: migrateCollapsedBoardColumnsFieldCase (not a plain
  // getCollapsedBoardColumns) -- boardFieldName is recomputed fresh from
  // entity.fields every render, so a live refine that renames the
  // board-driving field's letters only resolves to a new string the
  // instant the refine completes, and a plain exact-match lookup would
  // silently re-expand a column the user had deliberately collapsed. See
  // that function's own doc comment for the full mechanism.
  useEffect(() => {
    const loaded = migrateCollapsedBoardColumnsFieldCase(projectId, entity.name, boardFieldName, userId);
    if (!boardField) {
      setCollapsedBoardColumns(new Set(loaded));
      return;
    }
    const validValues = new Set(boardField.enumValues ?? []);
    const filtered = loaded.filter((v) => validValues.has(v));
    if (filtered.length !== loaded.length) setCollapsedBoardColumnsPreference(projectId, entity.name, boardFieldName, userId, filtered);
    setCollapsedBoardColumns(new Set(filtered));
  }, [projectId, entity.name, boardFieldName, userId, boardFieldEnumValuesKey]);

  /** Mirrors toggleGroupCollapsed above, for board columns instead of table groups. */
  function toggleBoardColumnCollapsed(columnValue: string) {
    setCollapsedBoardColumns((prev) => {
      const next = new Set(prev);
      if (next.has(columnValue)) next.delete(columnValue);
      else next.add(columnValue);
      setCollapsedBoardColumnsPreference(projectId, entity.name, boardFieldName, userId, [...next]);
      return next;
    });
  }

  // Same reasoning as groupFieldName's own effect just above -- the chosen
  // Table/Board/Calendar view is scoped per project+entity too. Falls back
  // to "table" if the persisted choice needs a board/date field this entity
  // no longer has (e.g. the field was removed), instead of rendering a view
  // toggle button that isn't even shown. Keyed on boardFieldName/dateFieldName
  // (not just projectId/entity.name), same as collapsedBoardColumns' own
  // effect above: EntityPanel doesn't remount when a Refine mutates the
  // currently-active entity's own fields in place (App.tsx keys it by
  // entity.name alone), so without this a Board/Calendar view surviving a
  // refine that removed its own board/date field left viewMode stuck on
  // the now-invalid mode -- the table rendered correctly, but the
  // group-by select stayed hidden (its own gate checks viewMode ===
  // "table") and no view-toggle button showed as active.
  const dateFieldName = dateField?.name ?? "";
  useEffect(() => {
    const stored = getViewModePreference(projectId, entity.name, userId);
    const stillValid = stored === "table" || (stored === "board" && boardFieldName) || (stored === "calendar" && dateFieldName);
    setViewMode(stillValid ? stored : "table");
  }, [projectId, entity.name, boardFieldName, dateFieldName]);

  /**
   * Multi-row selection (the checkboxes, "x", and select-all) is only ever
   * settable from Table view -- Board/Calendar have no selection checkbox
   * anywhere on BoardCard or the calendar day cells. But selectedIds itself
   * is view-mode-agnostic state, and the toolbar's Copy/Export-CSV/
   * Print-list buttons read it unconditionally in every view (their labels
   * literally switch to "Export 3 selected" etc. regardless of viewMode).
   * Without this, selecting rows in Table and then switching to Board or
   * Calendar left that stale selection invisible (no highlight on any
   * BoardCard) and, worse, unreachable -- the table-only bulk-actions-bar
   * (including its own "Clear selection" button) and the table-only
   * Escape-clears-selection shortcut both live inside viewMode==="table"
   * guards, so there was no way back to an empty selection short of
   * switching back to Table first. Clearing it the moment the user leaves
   * Table view keeps the toolbar's own already-unconditional buttons
   * honest, and is safe precisely because nothing outside Table view can
   * ever populate selectedIds in the first place.
   */
  useEffect(() => {
    if (viewMode !== "table") setSelectedIds(new Set());
  }, [viewMode]);

  // Same reasoning as viewMode's own effect just above -- the chosen
  // multi-column sort is scoped per project+entity too (round 250).
  // Previously sortKeys was hard-reset to [] on every entity switch (see
  // the combined reset effect above) and never persisted at all, so a
  // deliberately-set sort didn't even survive clicking to another tab and
  // back. Drops any persisted key referencing a field this entity no
  // longer has (e.g. the field was removed) -- keyed on fieldNamesKey (not
  // just projectId/entity.name), same as viewMode's own effect above:
  // EntityPanel doesn't remount when a Refine mutates the currently-active
  // entity's own fields in place, so without this a dead key left over
  // from a field a refine then removed stayed in sortKeys forever even
  // though it no longer affects row order -- the Clear-sort button stayed
  // visible with nothing to clear, and a surviving second sort key kept
  // its stale array index, misnumbering its own priority badge and
  // reporting the wrong column via aria-sort.
  // (fieldNamesKey itself is now defined earlier in this component, above
  // the refresh/reset effect -- see round 1387's comment there.)
  // Only read by the fieldFilters effect just below, not this one --
  // sorting by a retyped field's own raw value is harmless (visually odd
  // at worst), unlike a filter whose stored value's shape can stop
  // matching its field's current type entirely. See that effect's own
  // doc comment for why.
  const fieldTypesKey = useMemo(() => entity.fields.map((f) => `${f.name}:${f.type}`).join(","), [entity.fields]);
  // Only read by the fieldFilters effect just below (round 882) -- an enum
  // field widened/narrowed past findFilterableEnumFields's own 2-8 range
  // never changes its own type (still "enum"), so fieldTypesKey alone
  // wouldn't notice that transition at all.
  const fieldEnumCountsKey = useMemo(
    () => entity.fields.map((f) => `${f.name}:${f.type === "enum" ? (f.enumValues?.length ?? 0) : ""}`).join(","),
    [entity.fields],
  );
  useEffect(() => {
    const validFieldNames = new Set(fieldNamesKey ? fieldNamesKey.split(",") : []);
    validFieldNames.add("createdAt");
    const byLowerName = new Map(entity.fields.map((f) => [f.name.toLowerCase(), f.name]));
    setSortKeys(
      getSortKeysPreference(projectId, entity.name, userId)
        .map((k) => (validFieldNames.has(k.field) ? k : { ...k, field: byLowerName.get(k.field.toLowerCase()) ?? k.field }))
        .filter((k) => validFieldNames.has(k.field)),
    );
  }, [projectId, entity.name, userId, fieldNamesKey]);

  // Round 985: hiddenFields had no revalidation effect of its own at all
  // before this round -- unlike every sibling preference module's own
  // fieldNamesKey-keyed effect (sortKeys' own just above, columnWidths' and
  // fieldFilters' own just below), it only ever loaded once per
  // project/entity switch (see the combined reset effect above, keyed on
  // entity.name alone), so EntityPanel staying mounted through a live
  // refine never re-synced it at all. Also remaps (rather than just drops)
  // a stale entry that still matches a current field CASE-INSENSITIVELY --
  // the same "a pure letter-casing rename looks identical to a totally
  // different field under an exact Set lookup" hazard applyColumnOrder's
  // own doc comment above now also describes -- so a column the user
  // explicitly hid before a live refine's case-only rename (e.g. "email"
  // -> "Email") stays hidden under its new spelling instead of silently
  // reappearing the instant that refine completes, with nothing in the UI
  // explaining why.
  useEffect(() => {
    const currentNames = new Set(entity.fields.map((f) => f.name));
    const byLowerName = new Map(entity.fields.map((f) => [f.name.toLowerCase(), f.name]));
    const remapped = new Set<string>();
    for (const name of getHiddenFields(projectId, entity.name, userId)) {
      if (currentNames.has(name)) {
        remapped.add(name);
        continue;
      }
      const current = byLowerName.get(name.toLowerCase());
      if (current) remapped.add(current);
    }
    setHiddenFields(replaceHiddenFields(projectId, entity.name, userId, remapped));
  }, [projectId, entity.name, fieldNamesKey]);

  // Round 897: the identical "drop a persisted key referencing a field this
  // entity no longer has" gap sortKeys' own effect just above already
  // closes, missed for columnWidths -- unlike every sibling preference
  // module (columnOrder, columnVisibility, fieldFiltersPreference,
  // groupByPreference, sortKeysPreference, viewModePreference,
  // collapsedGroupsPreference, collapsedBoardColumnsPreference), this one
  // was never keyed on fieldNamesKey at all, only projectId/entity.name --
  // so a resized column's width survived a live refine that removed that
  // exact field, with nothing left in the UI that it could possibly still
  // be sizing. Object.keys(columnWidths).length > 0 (below) still read
  // true purely from the dead key, wrongly locking the whole table into
  // entity-table-resized's fixed-layout/ellipsis mode and leaving the
  // "Reset column widths" button visible for a resize that no longer
  // affects anything rendered.
  useEffect(() => {
    const validFieldNames = new Set(fieldNamesKey ? fieldNamesKey.split(",") : []);
    const byLowerName = new Map(entity.fields.map((f) => [f.name.toLowerCase(), f.name]));
    const remapped: Record<string, number> = {};
    for (const [field, width] of Object.entries(getColumnWidths(projectId, entity.name, userId))) {
      const current = validFieldNames.has(field) ? field : byLowerName.get(field.toLowerCase());
      if (current) remapped[current] = width;
    }
    setColumnWidths(remapped);
  }, [projectId, entity.name, userId, fieldNamesKey]);

  // Same reasoning as sortKeys' own effect just above -- the chosen per-field
  // enum filters are scoped per project+entity too. Previously fieldFilters
  // was hard-reset to {} on every entity switch (see the combined reset
  // effect above) and never persisted at all, so a deliberately-set filter
  // didn't even survive clicking to another tab and back, unlike this
  // entity's sort order, grouping, hidden columns, and column widths, every
  // one of which already survives the same switch. Drops any persisted
  // filter referencing a field this entity no longer has, for the same
  // live-refine reason sortKeys' own effect above now also keys on
  // fieldNamesKey: without it, a filter set on a field a refine then
  // removed left visibleRecords's own `r[fieldName] === value` check
  // comparing against `undefined` forever, silently hiding every record
  // with no visible indication why.
  //
  // Round 751: also re-validates whenever a field's TYPE changes while
  // its name survives (e.g. an enum -> boolean refine) -- fieldNamesKey
  // alone wouldn't even notice that happened (same names, so its own
  // dependency array wouldn't change), so fieldTypesKey below is an extra
  // trigger carrying each field's type too. Once re-run, a stored value
  // whose SHAPE no longer matches the field's current type (checked
  // directly, not by comparing to any "previous type" -- nothing persists
  // that) is dropped the same way a value for a now-missing field already
  // was: a boolean <select> only ever has two real options ("true"/
  // "false"), so a stale value like "Shipped" left over from when this
  // field was an enum renders with nothing selected and no visible sign a
  // filter is even active, while visibleRecords' own check above still
  // silently hides every record. Mirrors validateAutomationFieldValue's
  // own per-type shape checks (apps/api/src/routes/projects.ts). An enum
  // field needs no such check: any stored string is a plausible (if
  // stale) enum value, and that staleness is exactly what the toolbar
  // <select>'s own synthetic-option guard below already surfaces visibly,
  // with a working Clear button -- unlike the boolean/relation cases,
  // where nothing would otherwise explain an empty table.
  //
  // Round 882: those two shape checks alone still missed a field that
  // drops out of filterableFields's own qualifying set a different way --
  // an enum field refined to have 9+ (or fewer than 2) enumValues (still
  // type "enum", so fieldTypesKey doesn't even change -- fieldEnumCountsKey
  // above exists for exactly this), or a field retyped to number/text/
  // longtext/date (fieldTypesKey changes, but the type is neither
  // "boolean" nor "relation", so neither existing check fires). Either way
  // the toolbar's own filterableFields dropdown for that field disappears
  // entirely (findFilterableEnumFields's enum-count gate, or the type no
  // longer qualifying at all) -- with no synthetic-option guard left to
  // surface the staleness, since the field's own <select> isn't rendered
  // at all anymore. visibleRecords' filter predicate keeps applying the
  // stale value regardless, silently hiding every record, and if this was
  // the entity's only filterable field, filterableFields is now empty, so
  // the "Clear filters" button (gated on filterableFields.length > 0)
  // never renders either -- no UI control left anywhere to reveal or
  // clear it.
  //
  // Deliberately NOT reusing filterableFields/findFilterableFields
  // directly here: that function also requires relatedRecords to already
  // confirm a relation field's target records have loaded, which this
  // effect has no business waiting on -- relatedRecords starts out {} on
  // every fresh mount and populates asynchronously after this effect's
  // own first run, so gating on it here would transiently (and, since
  // this effect doesn't depend on relatedRecords, PERMANENTLY within this
  // mount) drop a perfectly valid, already-persisted relation filter
  // before its data ever had a chance to load. A relation field only
  // needs to be STRUCTURALLY resolvable (its relationTo names a real,
  // still-existing entity) to stay filterable here; whether its records
  // have been fetched yet is the toolbar dropdown's own, separate concern.
  const filterableEnumNames = useMemo(() => new Set(findFilterableEnumFields(entity.fields).map((f) => f.name)), [entity.fields]);
  useEffect(() => {
    const fieldsByName = new Map(entity.fields.map((f) => [f.name, f]));
    const fieldsByLowerName = new Map(entity.fields.map((f) => [f.name.toLowerCase(), f]));
    const persisted = getFieldFiltersPreference(projectId, entity.name, userId);
    const next: Record<string, string> = {};
    for (const [field, value] of Object.entries(persisted)) {
      // Round 985: falls back to a case-insensitive match when the exact
      // name misses -- a live refine that merely renames a field's letter
      // casing (e.g. "status" -> "Status") previously looked identical to
      // that field being removed outright to this exact Map lookup, so an
      // active filter on it silently vanished, unhiding whatever it had
      // been hiding, with nothing in the UI explaining why.
      const f = fieldsByName.get(field) ?? fieldsByLowerName.get(field.toLowerCase());
      if (!f) continue;
      const stillFilterable =
        f.type === "boolean" ||
        (f.type === "enum" && filterableEnumNames.has(f.name)) ||
        // Round 1178: case-insensitive, same reason as this effect's own
        // fieldsByLowerName fallback just above -- a relation field whose
        // relationTo differs from its target entity's name only by letter
        // case must stay filterable too.
        (f.type === "relation" && !!f.relationTo && allEntities.some((e) => e.name.toLowerCase() === f.relationTo!.toLowerCase()));
      if (!stillFilterable) continue;
      if (f.type === "boolean" && value !== "true" && value !== "false") continue;
      if (f.type === "relation" && (!Number.isInteger(Number(value)) || String(Number(value)) !== value || Number(value) < 0)) continue;
      next[f.name] = value;
    }
    setFieldFilters(next);
  }, [projectId, entity.name, fieldNamesKey, fieldTypesKey, fieldEnumCountsKey, filterableEnumNames, allEntities]);

  /**
   * Round 780: groupFieldName's own load effect above only re-validates on
   * a project/entity SWITCH -- it never re-runs while staying mounted on
   * the SAME entity through a live refine, so a field whose TYPE changes
   * while its NAME survives (e.g. an enum "status" refined into a
   * boolean) keeps grouping by it unchanged. groupRecordsByField's
   * boolean/relation branches have no "legacy value" guard the way the
   * enum branch's own "(other)" bucket already does: a pre-existing
   * record's stale old-type value (a leftover enum string like "Shipped")
   * coerces through Boolean(...) to true, so every record except a
   * genuinely-empty one gets silently mislabeled under a confident "Yes"
   * group, with real per-group subtotals computed over that fabricated
   * split -- the exact "silently wrong results presented as correct"
   * hazard round 751 fixed for fieldFilters, not the merely-cosmetic one
   * it declined to fix for sortKeys. Unlike fieldFilters' own stored
   * VALUE (whose shape can be checked directly against the current
   * type), groupFieldName is just a field NAME with no shape to check --
   * so a ref remembers the type of whichever field it currently names,
   * captured the moment it's chosen (by the user, or reloaded from
   * storage above), and the selection is cleared via the same round-462
   * clearing path the moment that type changes out from under it. Also
   * closes the "stale value has no <option>" blank-select hazard for the
   * case a type change moves the field OUT of being groupable entirely.
   */
  const groupedFieldTypeRef = useRef<string | null>(null);
  useEffect(() => {
    const type = groupFieldName ? entity.fields.find((f) => f.name === groupFieldName)?.type ?? null : null;
    groupedFieldTypeRef.current = type;
    // Mirrors the ref above into persisted storage (round 838) -- this
    // effect already fires on every single change of groupFieldName,
    // regardless of which of this file's several call sites caused it
    // (a user's own pick, the load effect above, or either clearing
    // path below), so it's the one place that keeps getGroupByFieldType
    // in sync with getGroupByField without touching every call site.
    setGroupByFieldType(projectId, entity.name, userId, type ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupFieldName]);
  useEffect(() => {
    if (!groupFieldName) return;
    const exactField = entity.fields.find((f) => f.name === groupFieldName);
    // Round 985: a live refine that merely renames the grouped field's
    // letter casing (e.g. "status" -> "Status") makes the exact-match
    // lookup above miss just like a genuine removal would, so without this
    // fallback it fell straight into the clearing path below for a field
    // that, semantically, never actually changed. Resolved only when the
    // exact lookup itself already missed, so a real ambiguity (two fields
    // differing only by case, however unlikely) still prefers the exact
    // match it already has.
    const renamedField = exactField ? undefined : entity.fields.find((f) => f.name.toLowerCase() === groupFieldName.toLowerCase());
    const currentType = exactField?.type ?? renamedField?.type;
    // Round 892: deliberately NOT `currentType &&` -- that guard only ever
    // fires when the field RETYPES while its name survives. A refine that
    // REMOVES the grouped field outright leaves currentType undefined, so
    // that guard silently no-ops: groupFieldName stays pointed at a name
    // entity.fields no longer has at all, the exact "stale value has no
    // <option>" blank-select hazard this effect's own doc comment above
    // claims to close, just for a removal instead of a retype. Comparing
    // against undefined directly (currentType !== groupedFieldTypeRef.current)
    // catches both shapes with the same clearing path.
    if (groupedFieldTypeRef.current && currentType !== groupedFieldTypeRef.current) {
      setGroupFieldName(setGroupByField(projectId, entity.name, userId, ""));
      return;
    }
    if (renamedField) {
      setGroupFieldName(setGroupByField(projectId, entity.name, userId, renamedField.name));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldTypesKey]);

  /**
   * Round 781: the identical "field TYPE changes while its NAME survives
   * a live refine" bug class round 780 just fixed for groupFieldName,
   * applied to its sibling bulkEditField/bulkEditValue.
   * handleBulkEditFieldChange's own doc comment already states the exact
   * hazard this guards against ("a stale string value FieldInput would
   * render nonsensically") -- but that reset only ever fires when the
   * USER re-picks the field from the dropdown, never when the SAME field
   * retypes underneath it while it stays selected. FieldInput's boolean
   * branch (`checked={Boolean(value)}`) coerces any non-empty leftover
   * string (e.g. a stale enum value like "Shipped" left over from before
   * the retype) to a pre-checked checkbox -- actively misleading, not
   * just cosmetically stale, since it shows "on" with no action from the
   * user. Left as-is, the server's own coerceValue strictly rejects
   * anything but true/false/1/0 for a boolean field, so clicking Apply
   * fails every single selected record's PATCH with a confusing
   * validation error after the UI looked ready to go. Reuses
   * handleBulkEditFieldChange itself (same field name, so bulkEditField
   * is unaffected) to recompute the type-appropriate empty value, the
   * exact reset a user re-picking this same field from the dropdown
   * would already get. If the new type is "file" -- excluded from
   * bulkEditableFields entirely, below -- the field name itself is
   * cleared instead, the same "stale value has no <option>" blank-select
   * hazard round 780 also closed for groupFieldName.
   */
  const bulkEditFieldTypeRef = useRef<string | null>(null);
  useEffect(() => {
    bulkEditFieldTypeRef.current = bulkEditField ? entity.fields.find((f) => f.name === bulkEditField)?.type ?? null : null;
  }, [bulkEditField]);
  useEffect(() => {
    if (!bulkEditField) return;
    const currentType = entity.fields.find((f) => f.name === bulkEditField)?.type;
    // Round 892: deliberately NOT `currentType &&` -- see groupFieldName's
    // own effect above for why. A refine that REMOVES bulkEditField
    // outright, not just retypes it, left this guard silently no-oping
    // (currentType undefined, so the guard was false), so bulkEditField
    // stayed pointed at a name entity.fields no longer has, leaving the
    // bulk-edit field <select> with a stale value matching no <option>.
    // A removal can't be handled by handleBulkEditFieldChange the way a
    // retype is (it would just set bulkEditField back to the same
    // now-nonexistent name) -- clear outright instead, the same "stale
    // value has no <option>" path the "file" branch below already uses.
    if (bulkEditFieldTypeRef.current && currentType !== bulkEditFieldTypeRef.current) {
      if (!currentType || currentType === "file") {
        setBulkEditField("");
        setBulkEditValue("");
      } else {
        handleBulkEditFieldChange(bulkEditField);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldTypesKey]);

  /**
   * Round 800: the identical "field TYPE changes while its NAME survives a
   * live refine" bug class rounds 780/781 already fixed for groupFieldName
   * and bulkEditField/bulkEditValue, missed for this third sibling that
   * goes through the exact same FieldInput type-branch dispatch --
   * editingCell/cellDraft, the in-progress inline table-cell editor.
   * Unlike those two (a reselect/recompute to the new type's own sensible
   * empty value), there's no equivalent "still useful" draft here once the
   * field underneath it has changed shape -- an in-progress edit of what
   * is now a different field is just cancelled outright, via the same
   * cancelInlineEdit() an explicit Escape already uses, so the stale
   * cellDraft is never fed into whichever control FieldInput now renders
   * for the field's new type. Concretely: editing an enum field left
   * cellDraft holding a stored value like "High"; if a refine then
   * retypes that same field to boolean before the cell is blurred,
   * FieldInput's boolean branch would otherwise render `checked={Boolean(
   * "High")}` -- true, a pre-checked checkbox the user never touched --
   * and blurring normally would PATCH the unchanged string value against
   * the now-boolean field, rejected server-side as a confusing error on a
   * row the user believes they never edited.
   */
  const editingCellFieldTypeRef = useRef<string | null>(null);
  useEffect(() => {
    editingCellFieldTypeRef.current = editingCell ? entity.fields.find((f) => f.name === editingCell.field)?.type ?? null : null;
  }, [editingCell]);
  useEffect(() => {
    if (!editingCell) return;
    const currentType = entity.fields.find((f) => f.name === editingCell.field)?.type;
    // Round 892: deliberately NOT `currentType &&` -- see groupFieldName's
    // own effect above for why. A refine that REMOVES the field currently
    // being inline-edited, not just retypes it, left this guard silently
    // no-oping, so an in-progress edit of a now-nonexistent field was
    // never cancelled -- blurring it would try to PATCH a field name the
    // server no longer recognizes on this entity at all.
    if (editingCellFieldTypeRef.current && currentType !== editingCellFieldTypeRef.current) {
      cancelInlineEdit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldTypesKey]);

  /**
   * Round 805: the fourth sibling of the same "field TYPE changes while its
   * NAME survives a live refine" bug class rounds 780/781/800 already
   * fixed for groupFieldName, bulkEditField/bulkEditValue, and
   * editingCell/cellDraft -- the main add/edit record form's own `form`
   * state. Unlike those three (each a single selected field name), `form`
   * holds one value per EVERY field at once, so a retyped field is tracked
   * by its own per-field type snapshot (formFieldTypesRef) instead of a
   * single ref, and only THAT field's own value is reset to its new type's
   * empty default -- emptyForm's own per-field logic -- leaving every other
   * field the user already filled in untouched. The baseline snapshot is
   * captured on entity.name (the same dependency the full form reset above
   * already uses), so an entity switch's own full reset is never second-
   * guessed by this effect as a stale diff. Without this, FieldInput's
   * boolean branch (`checked={Boolean(value)}`) coerces a stale leftover
   * enum/text value (e.g. "High") into a pre-checked checkbox the user
   * never touched: submitting a NEW record sends `form` whole (unlike
   * editing, which already diffs against editingOriginalRef -- round 644),
   * so the server's own coerceValue rejects the entire create over one
   * field the user never meant to set; submitting an EDIT is worse -- if
   * the user unchecks the bogus box, that now genuinely differs from the
   * original snapshot and silently gets PATCHed as a real, unintended
   * change.
   */
  const formFieldTypesRef = useRef<Record<string, string>>({});
  useEffect(() => {
    formFieldTypesRef.current = Object.fromEntries(entity.fields.map((f) => [f.name, f.type]));
  }, [entity.name]);
  useEffect(() => {
    const prevTypes = formFieldTypesRef.current;
    const retypedFields = entity.fields.filter((f) => prevTypes[f.name] && prevTypes[f.name] !== f.type);
    if (retypedFields.length > 0) {
      setForm((prev) => {
        const next = { ...prev };
        for (const f of retypedFields) next[f.name] = f.type === "boolean" ? false : "";
        return next;
      });
    }
    // Round 898: merged onto the previous snapshot, not replaced outright
    // -- a field's own prior type must survive even while the field is
    // temporarily absent (removed by one live refine), so a LATER, separate
    // refine that re-adds a same-named field under a genuinely different
    // type is still correctly detected as a retype on ITS OWN run of this
    // effect, instead of looking brand new with no prior type to compare
    // against (prevTypes[f.name] undefined, silently skipping the reset
    // above and leaking the field's stale pre-removal value straight
    // through to FieldInput's new, differently-typed branch).
    formFieldTypesRef.current = { ...prevTypes, ...Object.fromEntries(entity.fields.map((f) => [f.name, f.type])) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldTypesKey]);

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
        if (width != null) setColumnWidth(projectId, entity.name, userId, resizingField!.field, width);
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
    // This is the app's only mousedown-based drag (every other drag
    // interaction uses native HTML5 draggable/onDragStart, which the
    // browser itself already gates to the left button) -- without this
    // guard, a right-click-drag or middle-click-drag on the handle
    // resizes the column exactly like a left-click-drag, since the width
    // math below only reads e.clientX, never which button is held.
    if (e.button !== 0) return;
    e.preventDefault();
    const th = e.currentTarget.parentElement as HTMLTableCellElement | null;
    const startWidth = columnWidths[fieldName] ?? th?.getBoundingClientRect().width ?? 150;
    setResizingField({ field: fieldName, startX: e.clientX, startWidth });
  }

  /**
   * Keyboard fallback for the resize handle above -- mirrors the
   * column-move buttons' own keyboard-first design (round 185) rather than
   * leaving resize mouse-drag-only. ArrowRight/ArrowLeft nudge the width by
   * a fixed step instead of a pointer delta, through the same
   * computeResizedWidth/setColumnWidth the drag path already uses, so the
   * same clamping and RTL-aware direction flip apply either way.
   */
  function handleResizeKeyDown(e: React.KeyboardEvent<HTMLSpanElement>, fieldName: string) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const th = e.currentTarget.parentElement as HTMLTableCellElement | null;
    const delta = e.key === "ArrowRight" ? RESIZE_KEYBOARD_STEP : -RESIZE_KEYBOARD_STEP;
    // Derives startWidth from the updater's own `prev`, not the outer
    // `columnWidths` closure -- two ArrowLeft/ArrowRight presses handled
    // in the same React batch would otherwise both read the same
    // pre-update width and the second press would be silently lost.
    setColumnWidths((prev) => {
      const startWidth = prev[fieldName] ?? th?.getBoundingClientRect().width ?? 150;
      const width = computeResizedWidth(startWidth, delta, dirFor(lang));
      setColumnWidth(projectId, entity.name, userId, fieldName, width);
      return { ...prev, [fieldName]: width };
    });
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
   *
   * The filter/view-mode clears below go through the same persisting
   * setters the manual Clear-filters button and view-mode buttons use
   * (round 461 fix) -- a bare setFieldFilters({})/setViewMode("table")
   * only cleared the in-memory state, leaving the stale value still in
   * fieldFiltersPreference.ts/viewModePreference.ts's storage. Since
   * switching entity tabs remounts EntityPanel (key={entity.name} in
   * App.tsx), the mount-time effects above reload that stale persisted
   * value the moment the user switches away and back, silently re-hiding
   * the very record this effect just revealed.
   *
   * Clearing groupFieldName (round 462 fix) is the same "what else could
   * hide this row" reasoning applied to a third, independently-persisted
   * piece of state the round 461 fix didn't account for: table view's own
   * "Group by" + per-group collapse state (collapsedGroupsPreference.ts)
   * hides a row exactly as effectively as a field filter does -- a
   * collapsed group's records aren't rendered into the DOM at all, so the
   * scroll-into-view effect below finds no matching row and silently
   * no-ops, with no error and no visible result for the very click that
   * was supposed to reveal this record.
   */
  useEffect(() => {
    if (highlightRecordId == null || loading) return;
    setSearch("");
    setFieldFilters(() => {
      setFieldFiltersPreference(projectId, entity.name, userId, {});
      return {};
    });
    setViewMode(setViewModePreference(projectId, entity.name, userId, "table"));
    setGroupFieldName(setGroupByField(projectId, entity.name, userId, ""));
    setHighlightedRecordId(highlightRecordId);
    onHighlightHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightRecordId, loading]);

  /**
   * Round 921: applies an incoming createPrefill (e.g. WhatsAppPanel's own
   * "create new record from this message" button, carrying the message's
   * phone number) once this entity's own tab is actually open and loaded --
   * mirrors the highlightRecordId effect just above, and reuses
   * startCreateForColumn's own body (defined further below in this same
   * component) rather than duplicating it, since opening the create form
   * pre-filled with one field's value is exactly what that function already
   * does for the Kanban board's "add to this column" click.
   */
  useEffect(() => {
    if (!createPrefill || loading) return;
    const field = entity.fields.find((f) => f.name === createPrefill.fieldName);
    if (field) startCreateForColumn(createPrefill.value, field);
    onCreatePrefillHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createPrefill, loading]);

  /**
   * Round 1337: applies an incoming createDateFilter (Business Twin's own
   * overdue/dueSoon stat tiles, carrying the exact field+state the tile's
   * own count was describing) once this entity's own tab is actually open
   * and loaded -- mirrors the createPrefill effect just above, and reuses
   * the toolbar's own filter <select> onChange body (setFieldFilters +
   * setFieldFiltersPreference) rather than duplicating it, since applying
   * one field's filter value is exactly what that control already does.
   * Without this, clicking a stat tile landed on the entity's full,
   * unfiltered table instead of the filtered one the tile's own count was
   * actually about.
   */
  useEffect(() => {
    if (!createDateFilter || loading) return;
    const field = entity.fields.find((f) => f.name === createDateFilter.fieldName);
    if (field) {
      setFieldFilters((prev) => {
        const next = { ...prev, [field.name]: createDateFilter.value };
        setFieldFiltersPreference(projectId, entity.name, userId, next);
        return next;
      });
    }
    onCreateDateFilterHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createDateFilter, loading]);

  // Auto-fades the highlight a few seconds after it lands, so an old
  // "jump to record" doesn't stay visually marked forever if the user just
  // keeps working in this same tab.
  useEffect(() => {
    if (highlightedRecordId == null) return;
    const timer = setTimeout(() => setHighlightedRecordId(null), 4000);
    return () => clearTimeout(timer);
  }, [highlightedRecordId]);

  // Same auto-fade pattern as highlightedRecordId above, for the per-record
  // move/edit error marker instead of a jump-to highlight.
  useEffect(() => {
    if (moveErrorId == null) return;
    const timer = setTimeout(() => setMoveErrorId(null), 5000);
    return () => clearTimeout(timer);
  }, [moveErrorId]);

  /**
   * Persists the current search box value to this project+entity's recent
   * list once the user signals they're "done" by pressing Enter -- there's
   * no submit button on a live filter-as-you-type box, so Enter is the same
   * commit signal App.tsx's own handleProjectSearchKeyDown (round 316) uses
   * for the home screen's search box. Escape clears the live search value
   * (reusing the same setSearch("") the round-355 "Clear search" button
   * already calls) -- the table's own window-level Escape handler
   * (round 356, clears the multi-row selection) never reaches this input
   * at all, since it bails out via isTypingTarget the moment this field
   * has focus, so without this, Escape here was a dead key, unlike every
   * other free-text input in this panel (the inline cell editor and the
   * add/edit form both already discard on Escape).
   */
  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && search.trim()) {
      setRecentSearches(addEntityRecentSearch(projectId, entity.name, userId, search));
    } else if (e.key === "Escape" && search.length > 0) {
      e.preventDefault();
      setSearch("");
    }
  }
  function handleRecentSearchClick(query: string) {
    setSearch(query);
  }
  function handleRemoveRecentSearch(query: string) {
    setRecentSearches(removeEntityRecentSearch(projectId, entity.name, userId, query));
  }
  function handleClearRecentSearches() {
    clearEntityRecentSearches(projectId, entity.name, userId);
    setRecentSearches([]);
  }

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
      setSortKeysPreference(projectId, entity.name, userId, next);
      return next;
    });
  }

  // The entity's own fields, reordered to match whatever column order the
  // user has actually dragged into place (falling back to the entity's
  // natural order for a field the persisted order doesn't mention).
  const orderedFields = useMemo(() => applyColumnOrder(entity.fields, columnOrder), [entity.fields, columnOrder]);
  const orderedFieldLabelOccurrences = useMemo(() => fieldLabelOccurrences(orderedFields), [orderedFields]);
  const entityFieldLabelOccurrences = useMemo(() => fieldLabelOccurrences(entity.fields), [entity.fields]);
  // The bulk-edit field picker is a whole-record action like the table's
  // own column list, so it follows the same drag-reordered column order
  // (orderedFields) rather than the entity's raw declared order -- moved
  // here (it used to sit right after boardField/filterableFields above,
  // textually before orderedFields existed) since it now reads from it.
  //
  // Round 779: this used to reuse isInlineEditableField verbatim, which
  // also excludes "relation" -- correct for THAT predicate's own reason
  // (a single table cell has no room for a related-entity picker), but
  // that reason doesn't apply here: the bulk-edit toolbar below already
  // renders a full-width FieldInput (now with relatedEntity/
  // relatedEntityRecords wired in, the same way the add/edit form's own
  // call does), the exact component that already gives relation fields a
  // complete picker with filtering. Bulk-reassigning the SAME target
  // record across many selected rows (e.g. moving a batch of orders to a
  // different customer, or leads to a different rep) is exactly as
  // sensible as this feature's existing bulk-set of an enum/boolean/date
  // value -- findFilterableFields already treats relation the same way
  // for the filter dropdowns, a few lines below. "file" stays excluded:
  // its real editing UI needs projectId/entityName to reach the upload
  // endpoint, which this toolbar still has no reason to thread through.
  const bulkEditableFields = useMemo(() => orderedFields.filter((f) => f.type !== "file"), [orderedFields]);
  const bulkEditableFieldLabelOccurrences = useMemo(() => fieldLabelOccurrences(bulkEditableFields), [bulkEditableFields]);
  const bulkEditFieldDef = useMemo(() => entity.fields.find((f) => f.name === bulkEditField), [entity.fields, bulkEditField]);
  // The per-field filter dropdowns are a whole-record-set view like the
  // bulk-edit field picker just above -- they follow the same
  // drag-reordered column order (orderedFields), not the entity's raw
  // declared order. Moved here (it used to sit right after boardField
  // above, textually before orderedFields existed) for the same reason
  // bulkEditableFields was.
  const filterableFields = useMemo(() => findFilterableFields(orderedFields, allEntities, relatedRecords), [orderedFields, allEntities, relatedRecords]);
  const filterableFieldLabelOccurrences = useMemo(() => fieldLabelOccurrences(filterableFields), [filterableFields]);

  // Which columns actually render in the table -- CSV export and both print
  // sheets (per-record RecordPrintSheet and the list's RecordListPrintSheet)
  // intentionally ignore this and always include every field, since those
  // are whole-record actions, not "what's currently on screen".
  const visibleFields = useMemo(
    () => orderedFields.filter((f) => !hiddenFields.has(f.name)),
    [orderedFields, hiddenFields],
  );
  const visibleFieldLabelOccurrences = useMemo(() => fieldLabelOccurrences(visibleFields), [visibleFields]);

  function handleToggleColumn(fieldName: string) {
    // hiddenFields.size alone over-counts once it holds a name from a field
    // that no longer exists on this entity (e.g. after a refine renamed or
    // removed a field while this same entity tab stayed open without a
    // remount) -- count only the hidden names that still name a real field.
    const hiddenCount = entity.fields.filter((f) => hiddenFields.has(f.name)).length;
    const visibleCount = entity.fields.length - hiddenCount;
    if (!hiddenFields.has(fieldName) && visibleCount <= 1) return; // keep at least one column visible
    setHiddenFields(toggleFieldVisibility(projectId, entity.name, userId, fieldName));
  }

  // Dragging a column header to just before another one's -- reorders the
  // FULL field list (including any currently-hidden fields), not just the
  // visible subset, so a hidden field keeps its relative place once shown
  // again later.
  function handleReorderColumn(targetName: string) {
    setDragOverField(null);
    if (!draggedField || draggedField === targetName) return;
    const fullOrder = orderedFields.map((f) => f.name);
    setColumnOrderState(setColumnOrder(projectId, entity.name, userId, reorderColumns(fullOrder, draggedField, targetName)));
    setDraggedField(null);
  }

  /**
   * Keyboard-operable fallback for the drag-and-drop column reorder above --
   * before this, dragging a column header (onDragStart/onDrop, native HTML5
   * drag-and-drop) was the ONLY way to reorder columns, same gap the Kanban
   * board's own card drag had before round 186 gave it a <select> fallback.
   * Moving a field earlier/later swaps it with its visible neighbor by
   * reusing reorderColumns the same way a drag would -- "move earlier" asks
   * to move this field to just before its visible predecessor; "move later"
   * asks to move the visible successor to just before this field, which is
   * the same operation expressed the other way around (reorderColumns only
   * has a "move X before Y" primitive, not "move X after Y").
   */
  function handleMoveColumn(fieldName: string, direction: "earlier" | "later") {
    const visibleIndex = visibleFields.findIndex((f) => f.name === fieldName);
    if (visibleIndex === -1) return;
    const neighborIndex = direction === "earlier" ? visibleIndex - 1 : visibleIndex + 1;
    if (neighborIndex < 0 || neighborIndex >= visibleFields.length) return;
    const neighborName = visibleFields[neighborIndex].name;
    const fullOrder = orderedFields.map((f) => f.name);
    const next =
      direction === "earlier" ? reorderColumns(fullOrder, fieldName, neighborName) : reorderColumns(fullOrder, neighborName, fieldName);
    setColumnOrderState(setColumnOrder(projectId, entity.name, userId, next));
  }

  const visibleRecords = useMemo(() => {
    const matched = records.filter((r) => matchesSearch(r, entity.fields, search, allEntities, relatedRecords, lang));
    const filtered = matched.filter((r) =>
      Object.entries(fieldFilters).every(([fieldName, value]) => {
        if (!value) return true;
        // Round 1134: a boolean field's stored value can now be a real
        // `null` (repository.ts's rowToRecord no longer coerces an
        // unanswered boolean to `false`) -- the generic `String(r[fieldName]
        // ?? "") === value` below would turn that into "", which never
        // matches either of this field's own two filter options ("true"/
        // "false"), silently hiding a never-set record from BOTH the "Yes"
        // and the "No" filter. groupRecordsByField's own boolean branch
        // (entityFormatting.ts) deliberately exposes only two groups, never
        // a third "unanswered" bucket -- this filter, offering the exact
        // same two options, must keep sorting an unanswered record into
        // "No" to match that same convention, so coerces through Boolean()
        // first, exactly like that function's own falsy branch does.
        const field = entity.fields.find((f) => f.name === fieldName);
        if (field?.type === "boolean") return String(Boolean(r[fieldName])) === value;
        // Round 1323: a deadline-named date field's filter offers
        // "overdue"/"dueSoon", the same two states getDateUrgency already
        // classifies the table cell's own red/amber styling by -- so this
        // must match against that classification, not the raw stored
        // "YYYY-MM-DD" string, which is what the generic fallback below
        // would otherwise compare "overdue"/"dueSoon" against.
        if (field?.type === "date" && isDeadlineFieldName(field.name)) {
          return getDateUrgency(String(r[fieldName] ?? "")) === value;
        }
        return String(r[fieldName] ?? "") === value;
      }),
    );
    return sortRecordsMulti(filtered, sortKeys, entity.fields, allEntities, relatedRecords);
  }, [records, entity.fields, search, fieldFilters, sortKeys, allEntities, relatedRecords, lang]);

  // Whether the totals row under the table is relevant at all -- only
  // rendered when at least one visible field is numeric.
  const hasNumericVisibleField = useMemo(() => visibleFields.some((f) => f.type === "number"), [visibleFields]);

  /**
   * Exactly the records the calendar grid's current month is showing -- the
   * same computation handleExportIcs uses, kept separate so the export
   * button can disable itself when the visible month is genuinely empty,
   * not just when the whole entity has no records.
   *
   * buildCalendarMonth deliberately puts the SAME record into every day
   * cell a ranged record (endField) spans, so a multi-night Rental shows up
   * on each night's chip in the on-screen grid. Flattening that per-day
   * grouping straight into the export list would hand buildCalendarIcs the
   * same record once per day it occupies, producing N duplicate VEVENTs for
   * one booking -- deduping by id here keeps one entry per record while
   * still restricting to the records actually visible this month.
   */
  const icsMonthRecords = useMemo(() => {
    if (!dateField) return [];
    const days = buildCalendarMonth(visibleRecords, dateField, calendarMonth.getFullYear(), calendarMonth.getMonth(), endDateField);
    const flat = days.filter((d) => d.inCurrentMonth).flatMap((d) => d.records);
    return Array.from(new Map(flat.map((r) => [r.id, r])).values());
  }, [visibleRecords, dateField, endDateField, calendarMonth]);

  // Grouping the plain table by a small-value-space field (enum/boolean) --
  // distinct from the Kanban board view (which always groups by exactly one
  // auto-picked field, and always in its own separate view), this lets a
  // person cluster the ordinary table by ANY such field while staying in
  // table view, with search/sort/columns all still applying underneath.
  // Same orderedFields rationale as filterableFields above -- the "Group
  // by" dropdown's own option list is a whole-record-set view too.
  const groupableFields = useMemo(
    () => orderedFields.filter((f) => isGroupableField(f, allEntities, relatedRecords)),
    [orderedFields, allEntities, relatedRecords],
  );
  const groupableFieldLabelOccurrences = useMemo(() => fieldLabelOccurrences(groupableFields), [groupableFields]);
  const groupField = groupableFields.find((f) => f.name === groupFieldName) ?? null;
  const recordGroups = useMemo(
    () => (groupField ? groupRecordsByField(visibleRecords, groupField, t, allEntities, relatedRecords, lang) : null),
    [groupField, visibleRecords, t, allEntities, relatedRecords, lang],
  );

  // The records actually rendered in the table body right now -- unlike
  // visibleRecords, this excludes a collapsed group's records (the table
  // body itself skips them entirely; see "!collapsed && group.records.map"
  // below). "Select all" and its own checked/indeterminate state used to
  // read visibleRecords directly, so selecting all silently selected
  // records hidden inside a collapsed group too -- invisibly inflating the
  // bulk-actions bar's count and letting bulk delete/duplicate/edit (and
  // CSV-export-selected/print-selected, which both just read selectedIds)
  // act on records the user never saw.
  //
  // Gated on viewMode === "table": grouping/collapsing is only ever set
  // from Table view (the Group-by select itself only renders there), but
  // groupFieldName/collapsedGroups are view-mode-agnostic state that
  // survives switching to Board/Calendar. Calendar view really does render
  // every record from visibleRecords with no "collapsed" concept of its
  // own -- but Board view does have one: collapsedBoardColumns, toggled
  // per-column via the board-column-toggle chevron, hides that column's
  // cards from the screen the exact same way a collapsed Table group hides
  // its rows ("!collapsed && column.records.map" below). Without its own
  // branch here, collapsing a Board column visually hid its cards while
  // the toolbar's view-mode-agnostic Copy/Export-CSV/Print-list buttons
  // (which read effectivelyVisibleRecords unconditionally in every view)
  // kept exporting them anyway. groupByField is called without its
  // optional translator here since only column membership (value/records)
  // is needed, never the "(other)" bucket's display label.
  const effectivelyVisibleRecords = useMemo(() => {
    if (viewMode === "table" && recordGroups) {
      return recordGroups.flatMap((group) => (collapsedGroups.has(group.key) ? [] : group.records));
    }
    if (viewMode === "board" && boardField) {
      return groupByField(visibleRecords, boardField).flatMap((column) =>
        collapsedBoardColumns.has(column.value) ? [] : column.records,
      );
    }
    return visibleRecords;
  }, [viewMode, recordGroups, collapsedGroups, boardField, collapsedBoardColumns, visibleRecords]);

  // Totals row under the table -- sums each visible number-type column over
  // effectivelyVisibleRecords (not visibleRecords), so a collapsed group's
  // records drop out of the grand total just like they drop out of the
  // table body and their own per-group subtotal row; otherwise the footer
  // silently kept counting records the user could no longer see on screen.
  const numericFieldTotals = useMemo(
    () => (hasNumericVisibleField ? sumNumericFields(effectivelyVisibleRecords, visibleFields) : {}),
    [hasNumericVisibleField, effectivelyVisibleRecords, visibleFields],
  );

  // Per-group numeric subtotals -- without this, grouping a table by e.g.
  // Order Status still only ever showed one grand total under the whole
  // table (numericFieldTotals above), defeating the point of grouping a
  // numeric entity: a person groups Orders by Status specifically to
  // compare revenue across "Paid" vs "Pending" vs "Cancelled", and had to
  // manually re-add each group's rows by eye. Keyed by group.key so it's
  // computed once per group rather than re-summed on every render.
  const groupNumericTotals = useMemo(() => {
    if (!hasNumericVisibleField || !recordGroups) return null;
    const totals: Record<string, Record<string, number>> = {};
    for (const group of recordGroups) {
      totals[group.key] = sumNumericFields(group.records, visibleFields);
    }
    return totals;
  }, [hasNumericVisibleField, recordGroups, visibleFields]);

  // Same reasoning as groupNumericTotals above, for Board view: groupByField
  // groups records by exactly the same kind of field (enum/boolean) Table
  // view's own "Group by" does, so a person tracking e.g. deal value by
  // pipeline stage on a Kanban board gets the identical "compare totals
  // across columns" value Table view's grouping already provides, instead
  // of only each column's bare card count.
  const boardColumnNumericTotals = useMemo(() => {
    if (!hasNumericVisibleField || viewMode !== "board" || !boardField) return null;
    const totals: Record<string, Record<string, number>> = {};
    for (const column of groupByField(visibleRecords, boardField, t)) {
      totals[column.value] = sumNumericFields(column.records, visibleFields);
    }
    return totals;
  }, [hasNumericVisibleField, viewMode, boardField, visibleRecords, t, visibleFields]);

  // Round 885: the same grouping structure recordGroups/groupByField above
  // already give the on-screen table/board -- threaded into
  // RecordListPrintSheet so "Print list" mirrors it instead of flattening
  // every group into one continuous table with no heading or subtotal.
  // Collapsed groups/columns are excluded, the same "a collapsed group
  // drops out" rule effectivelyVisibleRecords above already applies to the
  // grand total. Deliberately null while an explicit row selection is
  // active (selectedIds.size > 0): a hand-picked, possibly cross-group
  // selection has no group boundary of its own to mirror, so it falls back
  // to the flat, ungrouped rendering (and round 884's own flat grand
  // total) exactly as before this round.
  const printGroups = useMemo(() => {
    if (selectedIds.size > 0) return null;
    if (viewMode === "table" && recordGroups) {
      return recordGroups.filter((g) => !collapsedGroups.has(g.key)).map((g) => ({ label: g.label, records: g.records }));
    }
    if (viewMode === "board" && boardField) {
      return groupByField(visibleRecords, boardField, t)
        .filter((c) => !collapsedBoardColumns.has(c.value))
        .map((c) => ({ label: c.label, records: c.records }));
    }
    return null;
  }, [selectedIds, viewMode, recordGroups, collapsedGroups, boardField, visibleRecords, t, collapsedBoardColumns]);

  // Scrolls the just-highlighted row into view once it's actually in the
  // rendered table -- runs after visibleRecords updates (the same render
  // that picks up the filter-clearing above), not just after
  // highlightedRecordId changes, since the row doesn't exist in the DOM
  // until then.
  useEffect(() => {
    if (highlightedRecordId == null) return;
    const row = tableScrollRef.current?.querySelector(`tr[data-record-id="${highlightedRecordId}"]`);
    scrollIntoViewRespectingMotion(row, { behavior: "smooth", block: "center" });
  }, [highlightedRecordId, visibleRecords]);

  // Mirrors the highlighted-row scroll effect above, for the keyboard-
  // focused row instead of a jump-to target.
  useEffect(() => {
    if (focusedRowId == null) return;
    const row = tableScrollRef.current?.querySelector(`tr[data-record-id="${focusedRowId}"]`);
    scrollIntoViewRespectingMotion(row, { behavior: "smooth", block: "nearest" });
  }, [focusedRowId, visibleRecords]);

  /**
   * j/k (and ArrowDown/ArrowUp) move a keyboard focus between table rows,
   * Enter opens the focused row for editing, "x" toggles that row's own
   * selection checkbox, Delete/Backspace deletes it (reusing
   * handleDelete's own confirm dialog and undo-toast, exactly like its
   * mouse-driven Delete button), "d" duplicates it (reusing
   * handleDuplicate verbatim, exactly like its own mouse-driven Duplicate
   * button -- no confirmation needed since duplicating only creates data,
   * never destroys it), and Escape clears the whole multi-row selection
   * (reusing the same setSelectedIds(new Set()) the round-354
   * "Clear selection" button already calls) -- previously a keyboard-only
   * user who built a selection with "x" had no way to back out of it
   * without reaching for the mouse, or without committing a
   * destructive/mutating bulk action. Only active in table view
   * (board/calendar have their own navigation shapes), and isTypingTarget
   * guards against hijacking keystrokes meant for the search box, a
   * filter dropdown, or the add/edit form -- the same guard App.tsx's own
   * Ctrl+K/Escape handler gets for free by only running in the "preview"
   * view, which doesn't apply here since this panel *is* full of its own
   * text inputs.
   *
   * isAnyDialogOpen() guards the other gap isTypingTarget alone can't
   * catch (round 365): this panel never unmounts while an overlay dialog
   * (History, WhatsApp, Business Twin, ...) sits on top of it, and focus
   * on open often lands on something that isn't a text input at all --
   * ShortcutsPanel's own Close button, for instance, since that panel has
   * no text input to autoFocus into. Without this, pressing j/k/x/d while
   * reading the shortcuts cheat-sheet silently mutated or deleted a
   * background row the person wasn't even looking at.
   *
   * The e.ctrlKey/metaKey/altKey check guards a third gap neither of those
   * catches (round 653): e.key is the same bare letter whether or not a
   * modifier is held, so without it Ctrl/Cmd+D (the browser's own
   * bookmark-this-page shortcut) silently duplicated the focused row
   * instead -- with no confirm dialog, since duplicating is designed to
   * skip one -- and Ctrl/Cmd+K, Ctrl+J, Cmd+Backspace, and Ctrl/Cmd+Enter
   * each hijacked a different browser/OS shortcut the same way. App.tsx's
   * own Ctrl+K handler already checks this; this effect never had.
   *
   * enterTargetsInteractiveElement guards a fourth gap (round 654), unique
   * to Enter: j/k's own setFocusedRowId never calls .focus() on anything,
   * so the row it highlights is only ever a visual state, never the real
   * DOM focus -- e.target on this window-level listener can be sitting on
   * a completely unrelated button (the form's own Save button, another
   * row's Delete/Duplicate button, a toolbar button) the user tabbed to,
   * while an earlier j/k press still has some row visually focused.
   * Without this check, Enter on the Save button there got hijacked into
   * opening the visually-focused row for editing instead of submitting
   * the form -- silently discarding whatever unsaved edit or new-record
   * draft was about to be submitted, with no confirmation, since the
   * handler never looked past e.key before. The e.defaultPrevented check
   * covers the one case the closest() walk inside it can't: a React
   * onKeyDown on a non-native role="button" element (EntityLabelEditor's
   * own rename trigger) that already handled this exact Enter itself.
   * Mirrors the identical hazard round 350 fixed for the calendar day
   * cell's own onKeyDown (`e.target !== e.currentTarget`) -- that fix
   * could compare targets directly since it's a per-element React
   * handler; this one is a single window-level listener, so it has to ask
   * "is the target itself (or an ancestor) a native activation target"
   * instead of "is it this exact element".
   */
  useEffect(() => {
    if (viewMode !== "table") return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target as HTMLElement | null) || isAnyDialogOpen()) return;
      // Grouping/collapse-aware, unlike a flat visibleRecords.map(): a
      // collapsed group's records are skipped from the <tbody> entirely
      // (see the table body render below), so navigating or acting on them
      // by a stale index would silently focus/edit/delete/duplicate a row
      // the user can't even see.
      const visibleIds = (
        recordGroups ? recordGroups.flatMap((group) => (collapsedGroups.has(group.key) ? [] : group.records)) : visibleRecords
      ).map((r) => r.id as number);
      const isFocusedRowVisible = focusedRowId != null && visibleIds.includes(focusedRowId);
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedRowId((current) => computeNextFocusedRowId(visibleIds, current, "next"));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedRowId((current) => computeNextFocusedRowId(visibleIds, current, "prev"));
      } else if (!readOnly && e.key === "Enter" && isFocusedRowVisible && !e.defaultPrevented && !enterTargetsInteractiveElement(e.target)) {
        const record = visibleRecords.find((r) => (r.id as number) === focusedRowId);
        if (record) {
          e.preventDefault();
          startEdit(record);
        }
      } else if (!readOnly && e.key === "x" && isFocusedRowVisible) {
        e.preventDefault();
        toggleSelected(focusedRowId as number);
      } else if (!readOnly && (e.key === "Delete" || e.key === "Backspace") && isFocusedRowVisible) {
        e.preventDefault();
        void handleDelete(focusedRowId as number);
      } else if (!readOnly && e.key === "d" && isFocusedRowVisible) {
        e.preventDefault();
        void handleDuplicate(focusedRowId as number);
      } else if (e.key === "Escape" && selectedIds.size > 0) {
        e.preventDefault();
        setSelectedIds(new Set());
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [viewMode, visibleRecords, focusedRowId, selectedIds, recordGroups, collapsedGroups, readOnly]);

  /**
   * Ctrl/Cmd+Z triggers the delete-undo toast's own "Undo" action --
   * "Delete"/"Backspace" above is a real keyboard shortcut (round 311-ish),
   * but undoing that exact delete had none, a small but real inconsistency
   * in an otherwise keyboard-first flow: a keyboard-only user who deleted a
   * row with the bound key still had to reach for the mouse to click the
   * toast's "Undo" link. Not scoped to table view (unlike the j/k/x/d
   * effect above) since the undo window (UNDO_WINDOW_MS) can still be open
   * after switching to board/calendar view. e.shiftKey is excluded since
   * Ctrl/Cmd+Shift+Z is the common OS/app convention for Redo, which this
   * app has no equivalent action for -- claiming that chord too would just
   * silently eat a gesture aimed at a (nonexistent) redo. handleUndoDelete
   * itself already no-ops via pendingDeleteRef when nothing is pending, so
   * this only ever prevents the key's default behavior when there's
   * actually something to undo.
   */
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z" || e.shiftKey) return;
      if (readOnly || isTypingTarget(e.target as HTMLElement | null) || isAnyDialogOpen()) return;
      if (!pendingDeleteRef.current) return;
      e.preventDefault();
      handleUndoDelete();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [readOnly]);

  /**
   * "n" jumps straight to a blank add-record form, abandoning whatever
   * edit was in progress -- unlike j/k/Enter above, this isn't scoped to
   * table view: the form itself renders above the table/board/calendar
   * switch and stays reachable from any of them, so the shortcut has to
   * stay active in all three too. isTypingTarget keeps it from hijacking
   * a keystroke meant for the search box, a filter dropdown, or a field
   * already being typed into; isAnyDialogOpen() keeps it from firing (and
   * yanking focus out of an open overlay dialog into this hidden form,
   * discarding an in-progress edit) while, say, ShortcutsPanel is open
   * and focus sits on its own Close button rather than a text input
   * (round 365 -- see the j/k/x/d effect just above for the full story).
   * The modifier check guards Ctrl/Alt+N in whatever browser/OS delivers
   * it to the page, the same round-653 gap as that effect's own.
   */
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (readOnly || e.key !== "n" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target as HTMLElement | null) || isAnyDialogOpen()) return;
      e.preventDefault();
      startCreateNew();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [entity, readOnly]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Round 1264: see handleDelete's own identical guard -- the form's own
    // Save button was the one single-record write path in this whole
    // writesInFlight family (rounds 1117/1118/1260) that was never gated
    // against a bulk batch or an import still in flight. Its sibling
    // Duplicate/Delete buttons, in this exact same <form>, already guard
    // against it.
    if (writesInFlight) return;
    setError(null);
    // Checked client-side (with noValidate on the <form>) rather than
    // relying on the browser's own native required-field validation: that
    // native tooltip is rendered by the OS/browser in its own locale, not
    // through t() -- the one piece of user-facing text in this entire,
    // fully-Hebrew-translated form that would otherwise show up in English
    // regardless of the app's own language setting.
    //
    // Round 939: a whitespace-only string (" ") passed `!== ""` here, so
    // this friendly, field-specific message never fired for it -- it fell
    // through to the real submit, which the server's own coerceValue
    // (packages/db/src/repository.ts) already treats as empty via its own
    // trim-aware isEmpty check, rejecting it with the generic
    // VALIDATION_ERROR message instead ("check the form", no field
    // named) -- a real step down from this check's own specific "X is
    // required" text, for an input that's blank in every way that
    // matters. String(...) first so a non-string required value (a
    // number/boolean) is never coerced into looking empty by trim()
    // alone -- e.g. a required number field genuinely holding 0 stays
    // "0", never "".
    const missingField = entity.fields.find((f) => f.required && String(form[f.name] ?? "").trim() === "");
    if (missingField) {
      setError(t("entity.form.requiredField", { field: missingField.label ?? missingField.name }));
      return;
    }
    // Round 984: mirrors missingField just above for the "present but not
    // actually numeric" case, the exact same generic-banner regression
    // round 980 reopened for "number" fields -- see invalidNumberField's
    // own doc comment.
    const invalidField = entity.fields.find((f) => invalidNumberField(f, form[f.name]));
    if (invalidField) {
      setError(t("entity.form.invalidNumber", { field: invalidField.label ?? invalidField.name }));
      return;
    }
    // Nothing disables startEdit/startCreateNew/the in-form Delete button
    // while this submit's own await is still pending -- a slow save for
    // record A resolving after the user has already clicked Edit on a
    // different record B must not yank the form back to blank under B's
    // in-progress edit. Captured before the await (this closure's own
    // `editingId`/`form` stay correctly bound to A throughout, so A still
    // gets the right PATCH/POST either way); only the UNCONDITIONAL
    // success-path reset below is skipped once the form has moved on.
    const formInstanceAtSubmitTime = formInstanceKeyRef.current;
    setSubmitBusy(true);
    try {
      if (editingId != null) {
        // Round 644: `form` holds a value for EVERY field, including every
        // one the user never touched -- startEdit below just snapshots the
        // whole record into it. Sending `form` as-is (as this used to do)
        // PATCHes every field back verbatim, reviving whatever stale value
        // was on screen when the dialog opened. If another tab, a Kanban
        // drag, or an automation legitimately changed an untouched field on
        // this same record while the dialog was open, saving this form
        // silently overwrites that real change with the stale one -- and
        // since the stored value genuinely transitions (e.g. back from
        // "Shipped" to "Pending"), computeChangedFields (routes/projects.ts)
        // correctly sees it as "changed" and can re-fire a field_equals
        // automation for a value nobody here actually set. Every sibling
        // mutation path in this file (commitInlineEdit, handleBulkUpdate,
        // the Kanban/calendar drag handlers below) already sends only the
        // field(s) it actually means to change -- diffing against the
        // snapshot startEdit took, rather than sending `form` whole, brings
        // this form in line with that same convention.
        const original = editingOriginalRef.current;
        const changedOnly: Record<string, unknown> = {};
        for (const f of entity.fields) {
          if (!original || form[f.name] !== original[f.name]) {
            changedOnly[f.name] = form[f.name];
          }
        }
        await updateRecord(projectId, entity.name, editingId, changedOnly);
      } else {
        await createRecord(projectId, entity.name, form);
      }
      if (formInstanceKeyRef.current === formInstanceAtSubmitTime) {
        setForm(emptyForm(entity));
        setEditingId(null);
        editingOriginalRef.current = null;
        bumpFormInstanceKey();
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitBusy(false);
    }
  }

  /**
   * Round 1004: the edit-form counterpart of round 1002's own create-form
   * fix (deleteUploadedRecordFile, wired into FieldInput's Remove button
   * and file-input onChange) -- but those two handlers only ever fire on
   * an explicit replace/remove click. Abandoning an in-progress edit
   * instead -- Cancel, Escape, or switching straight to a different
   * record/create without ever submitting -- left any file uploaded
   * during that edit (a replacement the user picked, or simply one picked
   * for a previously-empty field) sitting on disk forever: PATCH's own
   * deleteReplacedFileFields (routes/projects.ts) only ever runs on an
   * actual save, and never knows about an intermediate pick that was
   * never submitted at all.
   *
   * editingOriginalRef.current holds the record's own real persisted
   * snapshot (see its own doc comment) -- by construction, any `form`
   * value for a `file`-type field that differs from it can only be an
   * unsaved upload made during THIS edit session, never real persisted
   * data (which deleteReplacedFileFields already owns once an edit is
   * actually saved). A no-op whenever editingOriginalRef.current is null
   * -- not currently mid-edit of a real record -- so this is always safe
   * to call unconditionally at every point an edit can be abandoned.
   */
  function discardAbandonedFileUploads(formSnapshot: Record<string, unknown> = form) {
    const original = editingOriginalRef.current;
    if (!original || !projectId) return;
    for (const f of entity.fields) {
      if (f.type !== "file") continue;
      const current = formSnapshot[f.name];
      if (current === original[f.name]) continue;
      const parsed = parseFileFieldValue(current);
      if (!parsed) continue;
      deleteUploadedRecordFile(projectId, entity.name, f.name, parsed.url).catch(() => {});
    }
  }

  function startEdit(record: EntityRecord) {
    discardAbandonedFileUploads();
    setEditingId(record.id as number);
    setForm({ ...record });
    editingOriginalRef.current = record;
    bumpFormInstanceKey();
  }

  /**
   * The "n" shortcut's own target -- discards an in-progress edit (if any),
   * resets the form, and moves focus to it, so the keyboard alone can go
   * from anywhere in the panel to typing a new record's first field.
   */
  function startCreateNew() {
    discardAbandonedFileUploads();
    setEditingId(null);
    setForm(emptyForm(entity));
    editingOriginalRef.current = null;
    bumpFormInstanceKey();
    scrollIntoViewRespectingMotion(formRef.current, { behavior: "smooth", block: "start" });
    // formRef.current itself never remounts, but the fields inside it now
    // do (keyed on formInstanceKey, just incremented above) -- querying
    // for the first field synchronously here would still find the OLD,
    // about-to-be-replaced node (React's own state updates, including
    // this one, only commit after this synchronous handler returns), so
    // the focus would land on an element about to be torn down instead of
    // the real new one. Deferred one tick, matching this file's own
    // existing "wait for the browser to actually render first" pattern.
    setTimeout(() => {
      const firstField = formRef.current?.querySelector<HTMLElement>("input, select, textarea");
      firstField?.focus();
    }, 0);
  }

  /**
   * Clicking an empty calendar day was previously inert -- the only way to
   * add a record for a specific date was scrolling up to the general
   * create form and typing the date in by hand. Pre-fills that same form
   * with the clicked day, so calendar-heavy entities (appointments,
   * bookings) get the "click a day to add one" a real calendar app has.
   */
  function startCreateForDate(date: Date, dateField: Field) {
    discardAbandonedFileUploads();
    setEditingId(null);
    setForm({ ...emptyForm(entity), [dateField.name]: formatDateForInput(date) });
    editingOriginalRef.current = null;
    bumpFormInstanceKey();
    scrollIntoViewRespectingMotion(formRef.current, { behavior: "smooth", block: "start" });
  }

  /**
   * Kanban board's own sibling to startCreateForDate just above -- there was
   * no way to add a new record already set to one column's own value
   * without opening the general create form and picking that value by hand,
   * unlike the calendar view's own "click an empty day" convenience.
   */
  function startCreateForColumn(value: string, field: Field) {
    discardAbandonedFileUploads();
    setEditingId(null);
    setForm({ ...emptyForm(entity), [field.name]: value });
    editingOriginalRef.current = null;
    bumpFormInstanceKey();
    scrollIntoViewRespectingMotion(formRef.current, { behavior: "smooth", block: "start" });
  }

  // Fires the real DELETE request for a record the undo window has already
  // closed on (either the timer ran out, or a newer delete pre-empted it).
  // The row was already removed from view the moment Delete was confirmed,
  // on the assumption the real delete would simply succeed later -- but a
  // record another record still points to via a `relation` field genuinely
  // can't be deleted (a real foreign-key constraint, see connection.ts's
  // `PRAGMA foreign_keys = ON`). This used to be a bare `.catch(() => {})`,
  // silently discarding that failure: the row stayed gone from view with no
  // error shown at all, and would only reappear, unexplained, the next time
  // the panel happened to refetch. Restores the row (same helper
  // handleUndoDelete uses) and surfaces the real error instead -- setRecords/
  // setError on an unmounted component (the unmount-flush caller below) are
  // simply no-ops in React 18, so this is safe from every call site.
  async function commitPendingDelete(pending: PendingDelete) {
    const results = await Promise.allSettled(pending.entries.map((e) => deleteRecord(projectId, entity.name, e.id)));
    const failed = pending.entries.filter((_, i) => results[i].status === "rejected");
    if (failed.length === 0) return;
    setRecords((prev) => failed.reduce((acc, e) => restoreRecordAt(acc, e.record, e.index), prev));
    const firstFailure = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
    setError(
      failed.length === pending.entries.length
        ? (firstFailure.reason as Error).message
        : t("entity.bulk.partialFailure", { failed: failed.length, total: pending.entries.length }),
    );
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
        void commitPendingDelete(pending);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Round 1036: the same "switching entity tabs/navigating Home fully
   * unmounts this component" fact the pendingDelete-flush effect just
   * above already relies on also abandons any file the user had just
   * picked mid-edit, exactly the gap discardAbandonedFileUploads exists
   * to close for every OTHER way of abandoning an edit (Cancel, Escape,
   * starting a different edit/create, deleting the record -- see that
   * function's own call sites). None of those fire on a plain unmount.
   * Mirrors WhatsAppPanel.tsx's own round-1005 fix for its structurally
   * identical test-send-attachment leak.
   */
  useEffect(() => {
    return () => {
      discardAbandonedFileUploads(formValueRef.current);
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
   *
   * Returns whether the record was actually (optimistically) removed, so
   * the record-form's own Delete button (see form-actions below) knows
   * whether to close itself -- a caller that just fires-and-forgets (the
   * table row/BoardCard's own Delete button) can ignore the return value
   * entirely, same as before this return type existed. Deliberately plain
   * (not async, unlike handleDuplicate/handleSubmit) -- every step below is
   * genuinely synchronous, and keeping it that way lets the form's own
   * Delete button consume the return value in the very same event-dispatch
   * tick React already wraps in act(), rather than in a later microtask
   * continuation outside any act() scope.
   */
  function handleDelete(id: number): boolean {
    // Round 1118: a single-record delete (table row, board card, calendar
    // chip, keyboard shortcut, or the in-form Delete button) raced a bulk
    // update/duplicate/delete batch still in flight on the exact same
    // record -- round 1117 only cross-gated the bulk-action bar's own
    // three buttons against each other, never against every OTHER way to
    // mutate a record. See handleBulkDelete's own identical guard. Round
    // 1260: also guards against a CSV/JSON import batch (see writesInFlight).
    if (writesInFlight) return false;
    const index = records.findIndex((r) => (r.id as number) === id);
    if (index === -1) return false;
    const record = records[index];
    const label = recordDisplayLabel(entity, record, lang);
    if (!window.confirm(t("entity.confirmDelete", { label }))) return false;

    if (pendingDeleteRef.current) {
      clearTimeout(pendingDeleteRef.current.timeoutId);
      void commitPendingDelete(pendingDeleteRef.current);
    }

    // Round 1017: this id may be the record the edit form currently has
    // open (deleted via the table row/board-card/keyboard-shortcut path,
    // none of which go through the in-form Delete button's own close-on-
    // success handling) -- leaving that form open on a row that just
    // vanished let a later Save either PATCH a record that's actually
    // already gone once the undo window elapses, or -- worse, and with no
    // error at all -- succeed while the record is still alive during the
    // undo window, only for the save to be invisible (refresh() filters
    // out a pending-delete id) and then silently discarded the moment
    // either the window elapses or the user clicks the delete toast's own
    // Undo (which splices back pending.entries' PRE-delete snapshot, not
    // whatever was just saved). Closing the form the same way Cancel/
    // Escape/the in-form Delete button already do removes the window for
    // either outcome entirely.
    if (id === editingId) {
      discardAbandonedFileUploads();
      setForm(emptyForm(entity));
      setEditingId(null);
      editingOriginalRef.current = null;
      bumpFormInstanceKey();
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
        if (current?.timeoutId !== timeoutId) return current;
        void commitPendingDelete(current);
        return null;
      });
    }, UNDO_WINDOW_MS);

    setPendingDelete({ entries: [{ id, record, index }], message: t("entity.delete.undoToast", { label }), timeoutId });
    return true;
  }

  function handleUndoDelete() {
    const pending = pendingDeleteRef.current;
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    setRecords((prev) => pending.entries.reduce((acc, e) => restoreRecordAt(acc, e.record, e.index), prev));
    setPendingDelete(null);
  }

  // Copies a record's own field values into a real new record -- a quick
  // way to create several similar entries (e.g. a recurring appointment,
  // near-identical orders) without retyping the whole form. Only the
  // entity's own fields are sent (id/createdAt are server-assigned), and
  // nothing is asked for confirmation since duplicating, unlike deleting,
  // creates rather than destroys data.
  async function handleDuplicate(id: number) {
    // Round 1118: see handleDelete's own identical guard just above -- a
    // single-record duplicate (table row, board card, in-form button, or
    // keyboard shortcut) can race a bulk batch on the same record just as
    // easily as the bulk-action bar's own buttons could race each other.
    // Round 1260: also guards against an in-flight import (writesInFlight).
    if (writesInFlight) return;
    const record = records.find((r) => (r.id as number) === id);
    if (!record) return;
    setError(null);
    // A required "file" field can never be filled in by a duplicate (see
    // the file-nulling comment below for why) -- without this check, the
    // request below always reaches createRecord only to be rejected by
    // coerceValue's own required-field check (repository.ts), surfacing a
    // generic "field is required" error for an action the user never
    // filled in a form for. Mirrors buildImportRecords' own upfront
    // refusal for the identical "a required file field makes this
    // operation impossible" shape (entityFormatting.ts).
    const requiredFileField = entity.fields.find((f) => f.type === "file" && f.required);
    if (requiredFileField) {
      setError(t("entity.duplicate.requiredFileField", { field: requiredFileField.label ?? requiredFileField.name }));
      return;
    }
    // Round 1167: see staleEnumValue's own doc comment above -- this
    // record's own copied value would otherwise always reach coerceValue's
    // enum rejection only to be masked by the generic VALIDATION_ERROR text,
    // for an action with no form to show the field-specific message in.
    const staleEnumField = entity.fields.find((f) => staleEnumValue(f, record[f.name]));
    if (staleEnumField) {
      setError(t("entity.duplicate.staleEnumField", { field: staleEnumField.label ?? staleEnumField.name, value: String(record[staleEnumField.name]) }));
      return;
    }
    try {
      const copy: Record<string, unknown> = {};
      // A "file" field's stored value is just the uploaded file's own
      // descriptor (url/name/size/mimeType) -- copying it verbatim would
      // make the new record point at the exact same file on disk as the
      // original, not a fresh upload. routes/projects.ts's own
      // deleteReplacedFileFields has no way to know a second record now
      // shares that reference, so deleting either copy deletes the file
      // out from under the other, leaving a broken link. There's no
      // "clone the underlying file" operation to call instead, so the
      // duplicate simply starts with that field empty, the same way its
      // own form already starts empty for a new record.
      for (const field of entity.fields) copy[field.name] = field.type === "file" ? null : record[field.name];
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
    const visibleIds = effectivelyVisibleRecords.map((r) => r.id as number);
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
    // Round 1260: also refuses while a CSV/JSON import batch is in flight
    // (writesInFlight) -- see its own declaration for why.
    if (writesInFlight) return;
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    // Same upfront refusal as handleDuplicate above -- a required "file"
    // field would doom every single one of these requests identically, so
    // this refuses the whole batch once rather than firing N requests that
    // all fail the same way.
    const requiredFileField = entity.fields.find((f) => f.type === "file" && f.required);
    if (requiredFileField) {
      setError(t("entity.duplicate.requiredFileField", { field: requiredFileField.label ?? requiredFileField.name }));
      return;
    }
    setBulkActionBusy(true);
    setError(null);
    try {
      const results = await Promise.allSettled(
        ids.map((id) => {
          const record = records.find((r) => (r.id as number) === id);
          if (!record) return Promise.reject(new Error(t("entity.bulk.recordGone")));
          // Same staleEnumValue check as handleDuplicate above, applied
          // per-record rather than as an upfront whole-batch refusal --
          // unlike requiredFileField (a field-definition-level hazard that
          // dooms every record identically), staleness is a property of
          // THIS record's own stored value, so a batch can genuinely mix
          // records that would succeed with ones that wouldn't.
          const staleEnumField = entity.fields.find((f) => staleEnumValue(f, record[f.name]));
          if (staleEnumField) {
            return Promise.reject(
              new Error(t("entity.duplicate.staleEnumField", { field: staleEnumField.label ?? staleEnumField.name, value: String(record[staleEnumField.name]) })),
            );
          }
          const copy: Record<string, unknown> = {};
          // Same shared-file-reference hazard as handleDuplicate above, and
          // the same fix -- see its own comment for why.
          for (const field of entity.fields) copy[field.name] = field.type === "file" ? null : record[field.name];
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
    } finally {
      setBulkActionBusy(false);
    }
  }

  /**
   * Bulk delete used to call the real DELETE endpoint for every selected
   * record the instant the confirm dialog closed -- window.confirm (round
   * 73-equivalent for the bulk path) was the only safety net, with zero
   * recovery once confirmed, unlike single-record delete's own undo window
   * (round 184). Selecting the wrong rows (an easy mistake with checkboxes
   * and a stale filter) meant real, permanent data loss. Now reuses the
   * exact same pendingDelete/commitPendingDelete machinery as handleDelete
   * -- all selected rows disappear from view immediately, but every real
   * DELETE call is delayed behind the same UNDO_WINDOW_MS window, with one
   * shared toast and Undo button for the whole batch. commitPendingDelete's
   * own Promise.allSettled still protects a partial failure (a dropped
   * connection, a record another tab already removed) from hiding the
   * deletes that DID succeed.
   */
  async function handleBulkDelete() {
    // Round 1117: unlike handleBulkUpdate/handleBulkDuplicate, this had no
    // bulkActionBusy guard at all -- clicking this while one of those two
    // was still awaiting its own Promise.allSettled raced a real PATCH/
    // POST against this handler's own optimistic removal + delayed DELETE
    // for the same ids, in unpredictable order. Round 1260: also an import.
    if (writesInFlight) return;
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(t("entity.bulk.confirmDelete", { count: ids.length }))) return;

    if (pendingDeleteRef.current) {
      clearTimeout(pendingDeleteRef.current.timeoutId);
      void commitPendingDelete(pendingDeleteRef.current);
    }

    // Round 1017: see handleDelete's own identical check just above -- a
    // bulk selection can just as easily include the record the edit form
    // currently has open as a single delete can.
    if (editingId != null && ids.includes(editingId)) {
      discardAbandonedFileUploads();
      setForm(emptyForm(entity));
      setEditingId(null);
      editingOriginalRef.current = null;
      bumpFormInstanceKey();
    }

    setError(null);
    const idSet = new Set(ids);
    const entries: PendingDeleteEntry[] = [];
    records.forEach((r, index) => {
      if (idSet.has(r.id as number)) entries.push({ id: r.id as number, record: r, index });
    });
    setRecords((prev) => prev.filter((r) => !idSet.has(r.id as number)));
    setSelectedIds(new Set());

    const timeoutId = setTimeout(() => {
      setPendingDelete((current) => {
        if (current?.timeoutId !== timeoutId) return current;
        void commitPendingDelete(current);
        return null;
      });
    }, UNDO_WINDOW_MS);

    setPendingDelete({
      entries,
      message: t(entries.length === 1 ? "entity.bulk.deleteUndoToast.one" : "entity.bulk.deleteUndoToast.many", {
        count: entries.length,
      }),
      timeoutId,
    });
  }

  /**
   * Bulk delete/duplicate already existed, but changing a single shared
   * field's value across several selected records (e.g. marking 15
   * selected orders "Shipped", moving 8 leads to "Closed", or reassigning
   * a batch of orders to a different customer) still meant editing each
   * row one at a time -- double-clicking a cell, or dragging board cards
   * one card at a time -- for what any real ops tool treats as a single
   * mass action. Same Promise.allSettled resilience as
   * handleBulkDelete/handleBulkDuplicate above: one record another tab
   * already deleted, or a validation failure on one record's current
   * value, must not hide the successful updates to the rest. bulkEditValue
   * is already in the right shape to PATCH directly -- for a relation
   * field it's the chosen record's own id (FieldInput's relation branch
   * onChange already resolves to that), the exact same value the single-
   * record add/edit form sends through this same updateRecord call.
   */
  async function handleBulkUpdate() {
    // Round 1260: also refuses while a CSV/JSON import batch is in flight
    // (writesInFlight) -- see its own declaration for why.
    if (writesInFlight) return;
    const ids = [...selectedIds];
    if (ids.length === 0 || !bulkEditField) return;
    // Mirrors the single-record add/edit form's own pre-submit required-field
    // check (see missingField above) -- without it, leaving a required field
    // at its default blank value fires one doomed PATCH per selected record,
    // every one rejected server-side, surfaced only as the generic
    // VALIDATION_ERROR string with no field name at all.
    const bulkEditFieldDef = entity.fields.find((f) => f.name === bulkEditField);
    // Round 939: mirrors the single-record form's own missingField fix --
    // trims before comparing, so a whitespace-only value doesn't slip
    // past this friendly check into the generic server-side rejection.
    if (bulkEditFieldDef?.required && String(bulkEditValue ?? "").trim() === "") {
      setError(t("entity.form.requiredField", { field: bulkEditFieldDef.label ?? bulkEditFieldDef.name }));
      return;
    }
    // Round 984: mirrors the required-field check just above for the
    // "present but not actually numeric" case -- see invalidNumberField's
    // own doc comment.
    if (bulkEditFieldDef && invalidNumberField(bulkEditFieldDef, bulkEditValue)) {
      setError(t("entity.form.invalidNumber", { field: bulkEditFieldDef.label ?? bulkEditFieldDef.name }));
      return;
    }
    // Round 1023: before this, the confirm dialog named neither the field
    // nor the value about to be applied -- clicking Apply right after
    // picking a field in the dropdown, before ever touching the value
    // picker, silently blanked that field across every selected record
    // (bulkEditValue defaults to ""/false and no earlier guard catches a
    // non-required field left blank). Unlike bulk-delete, there's no undo.
    // Names the field always, and uses a distinct "clear" wording for the
    // blank-value case specifically, so an accidental mass-blank is now
    // impossible to miss before confirming -- without blocking a genuinely
    // intentional bulk-clear.
    const fieldLabel = bulkEditFieldDef?.label ?? bulkEditFieldDef?.name ?? bulkEditField;
    const isBlankClear = bulkEditFieldDef?.type !== "boolean" && String(bulkEditValue ?? "") === "";
    const confirmMessage = isBlankClear
      ? t("entity.bulk.confirmClearField", { field: fieldLabel, count: ids.length })
      : t("entity.bulk.confirmUpdate", { field: fieldLabel, value: bulkEditValueDisplay(bulkEditFieldDef, bulkEditValue), count: ids.length });
    if (!window.confirm(confirmMessage)) return;
    setBulkActionBusy(true);
    setError(null);
    try {
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
    } finally {
      setBulkActionBusy(false);
    }
  }

  /** A field's "empty" starting value depends on its type -- switching the
   * bulk-edit field picker from, say, an enum to a boolean must not leave
   * a stale string value FieldInput would render nonsensically. */
  function handleBulkEditFieldChange(fieldName: string) {
    setBulkEditField(fieldName);
    const field = entity.fields.find((f) => f.name === fieldName);
    setBulkEditValue(field?.type === "boolean" ? false : "");
  }

  /** Resolves a bulk-edit field's raw picker value to the human-readable
   * string the confirm dialog should show -- an enum's translated label,
   * a relation's target record's own display label (matching
   * relationDisplayLabel's use elsewhere in this file), or the
   * calendarChipLabelValue-style "TRUE"/"FALSE" convention for booleans,
   * rather than a raw stored key/id the user never typed. */
  function bulkEditValueDisplay(field: Field | undefined, value: unknown): string {
    if (!field) return String(value);
    if (field.type === "boolean") return value ? "TRUE" : "FALSE";
    if (field.type === "enum") return (field.enumLabels && field.enumLabels[String(value)]) || String(value);
    if (field.type === "relation") return relationDisplayLabel(field, value, allEntities, relatedRecords, lang);
    return String(value);
  }

  function handleExportCsv() {
    // includeId: true -- unlike handleCopy below (pasted into Slack/email,
    // never re-imported), this is the one CSV this app actually hands back
    // to handleImportFile, so it needs the id column that lets re-import
    // update these exact records instead of duplicating them.
    const csv = recordsToCsv(
      orderedFields,
      selectedOrAllRecords(records, effectivelyVisibleRecords, selectedIds),
      lang,
      allEntities,
      relatedRecords,
      true,
    );
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeDownloadName(entity.name, "export")}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /**
   * Round 1217: the sibling of Export CSV just above, for anyone taking
   * this data into another tool or script rather than a spreadsheet --
   * see `recordsToJson`'s own doc comment (entityFormatting.ts) for why
   * CSV's display-text values (a relation's resolved label, an enum's
   * enumLabels text, "TRUE"/"FALSE") aren't usable for that, while this
   * preserves each field's real stored value instead.
   */
  function handleExportJson() {
    const json = recordsToJson(orderedFields, selectedOrAllRecords(records, effectivelyVisibleRecords, selectedIds));
    const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeDownloadName(entity.name, "export")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /**
   * The same "Copy" companion action BusinessTwinPanel/HistoryPanel/
   * GlobalSearchPanel/WhatsAppPanel's own log already have next to their
   * Download button -- EntityPanel, the single most-used screen in the
   * app, only ever had a real file download (handleExportCsv), with no
   * way to paste a handful of rows straight into Slack/email/a doc
   * without downloading a CSV and opening it elsewhere first. Reuses the
   * exact same CSV text handleExportCsv already builds, just written to
   * the clipboard instead of a downloaded file.
   */
  async function handleCopy() {
    try {
      const csv = recordsToCsv(orderedFields, selectedOrAllRecords(records, effectivelyVisibleRecords, selectedIds), lang, allEntities, relatedRecords);
      await navigator.clipboard.writeText(csv);
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
    const ics = buildCalendarIcs(entity, dateField, labelField, icsMonthRecords, allEntities, relatedRecords, new Date(), endDateField, orderedFields, lang, projectId);
    downloadCalendarIcs(ics, entity.name);
  }

  /**
   * Round 1006: the live counterpart of handleExportIcs just above -- that
   * button downloads a one-shot snapshot of whichever month is currently
   * open; this one copies a subscription URL a real calendar app (Google/
   * Apple Calendar, a phone) re-fetches on its own schedule forever, so
   * every appointment/booking added or rescheduled after today shows up
   * there too, with no manual re-export ever needed again. Fetches the
   * project's own feed token fresh each click (cheap -- getOrCreateCalendarFeedToken
   * is a single indexed row read once the token already exists) rather
   * than caching it, since this button is clicked rarely and a stale
   * cached value would be wrong forever if the token were ever rotated.
   */
  async function handleSubscribeCalendar() {
    try {
      const { token } = await getCalendarFeedToken(projectId);
      const url = `${window.location.origin}/api/public/calendar/${projectId}/${encodeURIComponent(entity.name)}.ics?token=${token}`;
      await navigator.clipboard.writeText(url);
      setSubscribeStatus("copied");
    } catch {
      setSubscribeStatus("failed");
    }
  }

  useEffect(() => {
    if (subscribeStatus === "idle") return;
    const timer = setTimeout(() => setSubscribeStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [subscribeStatus]);

  /**
   * The complement to CSV export: parses an uploaded file with parseCsv,
   * converts it to record payloads with buildImportRecords (which already
   * validates types/required fields client-side), then writes each valid
   * row. Uses allSettled rather than assuming success once client-side
   * validation passes, since the server has the final say (e.g. a
   * cross-field rule this component doesn't know about) -- the summary
   * message reports real created/updated/skipped counts either way, not an
   * optimistic guess.
   *
   * A row whose `id` buildImportRecords resolved (handleExportCsv's own
   * leading "id" column, round-tripped) is PATCHed instead of POSTed --
   * this is what lets re-importing an edited copy of your own export
   * update those exact records instead of creating a duplicate row for
   * every one of them. `id` is pulled out of the payload before sending
   * either request: it's metadata about WHICH record, never a field value
   * to write.
   *
   * Every write below sets suppressAutomations -- without it, importing a
   * spreadsheet of pre-existing customers (the whole point of this
   * feature, e.g. migrating off another system) fires every
   * "record_created"/"record_updated" WhatsApp automation rule for each
   * row, all at once (these requests run concurrently via
   * Promise.allSettled), sending a real "welcome"/"updated" message to
   * everyone in the file even though none of them just happened through
   * the app. See routes/projects.ts's own comment on X-Suppress-Automations
   * for why this is scoped to import alone and not the single "Add" form,
   * duplicate, or bulk-duplicate.
   */
  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file to retry
    if (!file) return;
    // Round 1260: the reverse direction of writesInFlight's own guard --
    // refuses to start an import while a bulk batch is still in flight on
    // the exact same records, instead of firing a second independent set
    // of concurrent writes on top of it.
    if (bulkActionBusy) return;
    setImportBusy(true);
    setImportMessage(null);
    setImportErrors([]);
    setShowImportErrors(false);
    setImportWarnings([]);
    setShowImportWarnings(false);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      const { records: parsedRecords, errors: parseErrors, warnings } = buildImportRecords(
        entity.fields,
        rows,
        allEntities,
        relatedRecords,
        lang,
        entity,
        records,
      );
      setImportWarnings(warnings);
      await writeImportedRecords(parsedRecords, parseErrors);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImportBusy(false);
    }
  }

  /**
   * The JSON counterpart to handleImportFile -- the write-back half of
   * Export JSON (round 1217), letting a user re-import their own exported
   * file (or a hand-edited copy) without CSV's string-coercion ambiguity.
   * buildImportRecordsFromJson already validates everything per-row; the
   * only thing specific to this entry point is confirming the uploaded
   * file is actually valid JSON holding an array at all, surfaced through
   * importMessage (the same place every other whole-file import problem
   * already goes) rather than the panel's top-level `error` banner.
   */
  async function handleImportJsonFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file to retry
    if (!file) return;
    // Round 1260: see handleImportFile's own identical guard just above.
    if (bulkActionBusy) return;
    setImportBusy(true);
    setImportMessage(null);
    setImportErrors([]);
    setShowImportErrors(false);
    setImportWarnings([]);
    setShowImportWarnings(false);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        setImportMessage(t("entity.import.jsonParseError"));
        return;
      }
      if (!Array.isArray(parsed)) {
        setImportMessage(t("entity.import.jsonParseError"));
        return;
      }
      const { records: parsedRecords, errors: parseErrors, warnings } = buildImportRecordsFromJson(
        entity.fields,
        parsed,
        allEntities,
        relatedRecords,
        entity,
        records,
      );
      setImportWarnings(warnings);
      await writeImportedRecords(parsedRecords, parseErrors);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImportBusy(false);
    }
  }

  /**
   * Shared by handleImportFile and handleImportJsonFile once each has its
   * own format-specific parsing done -- both write the exact same way
   * (Promise.allSettled, id present -> PATCH else POST, suppressAutomations
   * on every write, same created/updated/error summary message), so this
   * is the one place that shared tail lives rather than two copies of it
   * silently drifting apart.
   */
  async function writeImportedRecords(parsedRecords: Record<string, unknown>[], parseErrors: string[]): Promise<void> {
    if (parsedRecords.length === 0) {
      setImportErrors(parseErrors);
      setImportMessage(
        parseErrors.length > 0
          ? t(parseErrors.length === 1 ? "entity.import.allFailed.one" : "entity.import.allFailed.many", { errorCount: parseErrors.length })
          : t("entity.import.empty"),
      );
      return;
    }

    const results = await Promise.allSettled(
      parsedRecords.map((record) => {
        const { id, ...data } = record as { id?: number } & Record<string, unknown>;
        return id != null
          ? updateRecord(projectId, entity.name, id, data, { suppressAutomations: true })
          : createRecord(projectId, entity.name, data, { suppressAutomations: true });
      }),
    );
    const serverErrors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => (r.reason as Error).message);
    let createdCount = 0;
    let updatedCount = 0;
    results.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      if ((parsedRecords[i] as { id?: number }).id != null) updatedCount += 1;
      else createdCount += 1;
    });
    const allErrors = [...parseErrors, ...serverErrors];
    setImportErrors(allErrors);
    setImportMessage(
      updatedCount === 0
        ? allErrors.length === 0
          ? t(createdCount === 1 ? "entity.import.success.one" : "entity.import.success.many", { count: createdCount })
          : t("entity.import.successWithErrors", { count: createdCount, errorCount: allErrors.length })
        : allErrors.length === 0
          ? t("entity.import.successWithUpdates", { count: createdCount, updatedCount })
          : t("entity.import.successWithUpdatesAndErrors", { count: createdCount, updatedCount, errorCount: allErrors.length }),
    );
    await refresh();
  }

  async function handleMoveFields(id: number, fields: Record<string, string>) {
    // Round 1118: covers handleMove (the board dropdown) and both
    // handleCardDrop/handleCalendarDrop (board + calendar drag-and-drop),
    // all of which funnel through here -- see handleDelete's own identical
    // guard above for why a single-record write must never race a bulk
    // batch still in flight on the same record. Round 1260: also an import.
    if (writesInFlight) return;
    setError(null);
    try {
      await updateRecord(projectId, entity.name, id, fields);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
      setMoveErrorId(id);
    }
  }

  async function handleMove(id: number, fieldName: string, value: string) {
    await handleMoveFields(id, { [fieldName]: value });
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
    // A column accepts any drag, not just this board's own cards -- an
    // entity tab (App.tsx's own onDragStart never calls setData, so its
    // text/plain payload is "") or a file dragged in from the desktop both
    // land here too. Number("") is 0, not NaN, so the check above alone
    // lets id 0 through; without this guard, a record this project never
    // had would still reach handleMove below, PATCHing a nonexistent id
    // and surfacing a real "Record 0 not found" error banner over a board
    // where nothing was actually dragged. The calendar view's own sibling
    // drop handler just below already guards the identical case.
    if (!record) return;
    // Dropping a card back onto the column it's already in is a real no-op
    // -- nothing actually changed, so there's nothing worth a PATCH request for.
    if (String(record[fieldName] ?? "") === value) return;
    void handleMove(id, fieldName, value);
  }

  /**
   * The calendar view's own drag-and-drop, the direct sibling of the board
   * view's handleCardDrop above -- dragging a record's chip onto a
   * different day reschedules it there (e.g. moving an appointment from
   * Tuesday to Thursday) without opening the edit form. Reuses the exact
   * same handleMoveFields PATCH+refresh, just addressed by the date field's
   * own name and a freshly-formatted "YYYY-MM-DD" value instead of a board
   * enum value.
   *
   * For a ranged entity (e.g. Rental's startDate/endDate), buildCalendarMonth
   * deliberately renders the SAME chip on every day the booking spans, and
   * every one of those chip instances is draggable -- so the day actually
   * dragged (originDay, carried through dataTransfer by the chip's own
   * onDragStart) is not necessarily the record's current start day. Shifting
   * BOTH start and end by the delta between the dropped-on day and originDay
   * (rather than always anchoring start to the drop target) keeps the
   * booking's actual duration and moves it by exactly the days dragged,
   * whichever day of the span was grabbed -- what dragging a multi-day event
   * on a real calendar app does. When originDay is unavailable (or equals
   * the record's own start value, the common case of dragging the start
   * day's chip), this reduces to the original start-anchored behavior.
   */
  function handleCalendarDrop(record: EntityRecord, dateFieldName: string, date: Date, originDay?: string) {
    const value = formatDateForInput(date);
    const originValue = originDay ?? String(record[dateFieldName] ?? "");
    if (originValue === value) return;
    const fields: Record<string, string> = {};
    if (endDateField && dateField && dateFieldName === dateField.name) {
      const rawOldStart = record[dateFieldName];
      const rawEnd = record[endDateField.name];
      if (rawOldStart !== null && rawOldStart !== undefined && rawOldStart !== "" && rawEnd !== null && rawEnd !== undefined && rawEnd !== "") {
        const oldStart = parseFieldDate(String(rawOldStart));
        const oldEnd = parseFieldDate(String(rawEnd));
        const origin = parseFieldDate(originValue);
        if (
          !Number.isNaN(oldStart.getTime()) &&
          !Number.isNaN(oldEnd.getTime()) &&
          !Number.isNaN(origin.getTime()) &&
          oldEnd.getTime() >= oldStart.getTime()
        ) {
          const deltaDays = Math.round((date.getTime() - origin.getTime()) / (24 * 60 * 60 * 1000));
          const newStart = new Date(oldStart);
          newStart.setDate(newStart.getDate() + deltaDays);
          const newEnd = new Date(oldEnd);
          newEnd.setDate(newEnd.getDate() + deltaDays);
          fields[dateFieldName] = formatDateForInput(newStart);
          fields[endDateField.name] = formatDateForInput(newEnd);
        }
      }
    }
    if (!fields[dateFieldName]) fields[dateFieldName] = value;
    void handleMoveFields(record.id as number, fields);
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
    if (readOnly || !isInlineEditableField(field)) return;
    setEditingCell({ recordId: record.id as number, field: field.name });
    setCellDraft(record[field.name]);
  }

  // Sets the suppress flag *before* clearing editingCell, for the same
  // reason cancelInlineEdit below does: removing the input from the DOM
  // (React's re-render after setEditingCell(null)) can still fire a real
  // native blur event, and without the flag that blur reads a stale
  // closure's still-non-null editingCell/cellDraft and fires a SECOND real
  // commitInlineEdit() for the value Enter already just saved -- a
  // redundant PATCH that can clobber a concurrent edit to the same field
  // landing in the gap between the two requests (round 545).
  async function commitInlineEdit() {
    if (!editingCell) return;
    const { recordId, field } = editingCell;
    const value = cellDraft;
    // Mirrors the single-record add/edit form's own missingField guard and
    // handleBulkUpdate's identical check (round 702) -- the third sibling
    // mutation path through this same FieldInput/isInlineEditableField set
    // of types, previously the only one with no pre-submit required-field
    // check at all. Without it, clearing a required text/longtext/number/
    // date cell and committing fired a doomed PATCH, rejected server-side,
    // surfaced only as the generic VALIDATION_ERROR string -- actively
    // misleading here, since it says "check the form" while inline cell
    // editing never shows a form, just one table cell.
    const fieldDef = entity.fields.find((f) => f.name === field);
    // Round 939: mirrors the single-record form's own missingField fix --
    // trims before comparing, so a whitespace-only value doesn't slip
    // past this friendly check into the generic server-side rejection.
    if (fieldDef?.required && String(value ?? "").trim() === "") {
      setError(t("entity.form.requiredField", { field: fieldDef.label ?? fieldDef.name }));
      setMoveErrorId(recordId);
      return;
    }
    // Round 984: mirrors the required-field check just above for the
    // "present but not actually numeric" case -- see invalidNumberField's
    // own doc comment.
    if (fieldDef && invalidNumberField(fieldDef, value)) {
      setError(t("entity.form.invalidNumber", { field: fieldDef.label ?? fieldDef.name }));
      setMoveErrorId(recordId);
      return;
    }
    suppressCellBlurCommitRef.current = true;
    setEditingCell(null);
    try {
      await updateRecord(projectId, entity.name, recordId, { [field]: value });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
      setMoveErrorId(recordId);
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
            record.id === moveErrorId ? "record-row-move-error" : null,
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
            disabled={readOnly}
          />
        </td>
        {visibleFields.map((f) => {
          const isEditingThisCell =
            editingCell != null && editingCell.recordId === (record.id as number) && editingCell.field === f.name;
          // Mirrors startInlineEdit's own readOnly check above -- without
          // this, a read-only viewer still gets the "cell-inline-editable"
          // hover/cursor styling and the "Double-click to edit quickly"
          // tooltip on every cell, then double-clicking one silently does
          // nothing (startInlineEdit's own check rejects it with no
          // feedback). Every other read-only affordance in this file (the
          // row-select checkbox, BoardCard's drag/Edit/Delete, the bulk-
          // actions bar) gates the control's own look, not just its
          // callback -- this was the one place only the callback was gated.
          const editable = !readOnly && isInlineEditableField(f);
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
                  // Round 1178: case-insensitive -- without it, a case-mismatched
                  // relation field silently fell through FieldInput's own
                  // "relation" branch (gated on relatedEntity being truthy) to
                  // its generic number-input fallback, forcing a raw numeric id
                  // instead of a searchable record picker.
                  relatedEntity={f.relationTo ? allEntities.find((e) => e.name.toLowerCase() === f.relationTo!.toLowerCase()) : undefined}
                  relatedEntityRecords={f.relationTo ? relatedRecords[f.relationTo] : undefined}
                  // Round 1243: case-insensitive, same reason as relatedEntity/
                  // relatedEntityRecords just above (round 1178) and
                  // repository.ts's own server-side self-reference guard
                  // (round 1176) -- without it, a self-referencing relation
                  // field whose relationTo differed from this entity's own
                  // name only by letter case silently stopped excluding the
                  // record being edited from its own relation dropdown,
                  // offering a guaranteed-400 option the server-side guard
                  // (already case-insensitive) only rejects after Save.
                  excludeRecordIds={f.relationTo?.toLowerCase() === entity.name.toLowerCase() ? [record.id as number] : undefined}
                  autoFocus
                  onBlur={handleCellBlur}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      // A longtext field's own <textarea> has no other way
                      // to insert a newline -- mirrors the full add/edit
                      // form's own identical carve-out just below, so a
                      // bare Enter here types a line break instead of
                      // silently committing and closing the cell.
                      if (f.type === "longtext" && !(e.ctrlKey || e.metaKey)) return;
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
                    f.type === "relation" ? relationDisplayLabel(f, record[f.name], allEntities, relatedRecords, lang) : undefined
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
          {!readOnly && (
            <button type="button" onClick={() => startEdit(record)}>
              {t("entity.edit")}
            </button>
          )}
          {!readOnly && (
            <button type="button" disabled={writesInFlight} onClick={() => handleDuplicate(record.id as number)}>
              {t("entity.duplicate")}
            </button>
          )}
          {!readOnly && phoneField && onSendWhatsApp && findRecordPhoneNumber(entity.fields, record) && (
            <button type="button" onClick={() => onSendWhatsApp(findRecordPhoneNumber(entity.fields, record) as string)}>
              {t("entity.sendWhatsApp")}
            </button>
          )}
          <button type="button" onClick={() => setRecordToPrint(record)}>
            {t("entity.print")}
          </button>
          {!readOnly && (
            <button type="button" className="danger" disabled={writesInFlight} onClick={() => handleDelete(record.id as number)}>
              {t("entity.delete")}
            </button>
          )}
        </td>
      </tr>
    );
  }

  return (
    <div className="entity-panel">
      <EntityLabelEditor entity={entity} allEntities={allEntities} projectId={projectId} onRenamed={onEntityRenamed} readOnly={readOnly} />
      {entity.description && <p className="muted">{entity.description}</p>}

      {!readOnly && (
      <form
        className="record-form"
        ref={formRef}
        onSubmit={handleSubmit}
        noValidate
        onKeyDown={(e) => {
          // Escape discards an in-progress edit the same way the Cancel
          // button already does, mirroring the inline cell-edit Escape
          // convention just above -- but only while actually editing an
          // existing record. Outside edit mode this form IS the blank
          // create form, so Escape must never wipe a user's in-progress
          // new-record draft.
          if (e.key === "Escape" && editingId != null) {
            e.preventDefault();
            discardAbandonedFileUploads();
            setEditingId(null);
            setForm(emptyForm(entity));
            editingOriginalRef.current = null;
            // Without this, a save still in flight for the record just
            // abandoned here would -- once it resolves -- see its own
            // captured formInstanceKeyRef snapshot still match, and wipe
            // out whatever the user has since typed into this now-blank
            // form (see handleSubmit's own formInstanceAtSubmitTime check).
            bumpFormInstanceKey();
          } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            // A longtext field's own <textarea> has no other way to submit --
            // a bare Enter there only inserts a newline, unlike every
            // single-line input where Enter already submits natively.
            // requestSubmit() (rather than calling handleSubmit directly)
            // goes through the exact same real submit event every other
            // path already does, including this form's own noValidate.
            e.preventDefault();
            e.currentTarget.requestSubmit();
          }
        }}
      >
        {/*
         * orderedFields, not the entity's raw declared order -- the one
         * remaining surface in this file still following the old pattern
         * (table header, CSV export, both print sheets, and board cards
         * all already follow the user's drag-reordered columns). The
         * create/edit form has no functional reason to differ: handleSubmit
         * builds a plain keyed object regardless of field order.
         */}
        {orderedFields.map((field) => (
          <label key={`${field.name}-${formInstanceKey}`} className="field-row">
            <FieldLabelEditor
              entityName={entity.name}
              field={field}
              projectId={projectId}
              onRenamed={onEntityRenamed}
              readOnly={readOnly}
              labelOccurrences={entityFieldLabelOccurrences}
            />
            <FieldInput
              field={field}
              value={form[field.name]}
              onChange={(v) => setForm((prev) => ({ ...prev, [field.name]: v }))}
              // Round 1178: case-insensitive, same reason as the inline-cell-edit
              // call site above.
              relatedEntity={field.relationTo ? allEntities.find((e) => e.name.toLowerCase() === field.relationTo!.toLowerCase()) : undefined}
              relatedEntityRecords={field.relationTo ? relatedRecords[field.relationTo] : undefined}
              // Round 1243: case-insensitive, same reason as the inline-cell-edit call site above.
              excludeRecordIds={field.relationTo?.toLowerCase() === entity.name.toLowerCase() && editingId != null ? [editingId] : undefined}
              projectId={projectId}
              entityName={entity.name}
              editingId={editingId}
              originalValue={editingOriginalRef.current?.[field.name]}
              formInstanceKeyRef={formInstanceKeyRef}
            />
          </label>
        ))}
        <div className="form-actions">
          <button type="submit" disabled={writesInFlight}>
            {editingId != null ? t("entity.save") : t("entity.add")}
          </button>
          {editingId != null && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                discardAbandonedFileUploads();
                setEditingId(null);
                setForm(emptyForm(entity));
                editingOriginalRef.current = null;
                // Same reasoning as the Escape handler above: a save still
                // in flight for the record just abandoned here must not be
                // able to wipe out a fresh draft typed after this Cancel.
                bumpFormInstanceKey();
              }}
            >
              {t("entity.cancel")}
            </button>
          )}
          {editingId != null && (
            <button type="button" disabled={writesInFlight} onClick={() => handleDuplicate(editingId)}>
              {t("entity.duplicate")}
            </button>
          )}
          {editingId != null && (
            <button
              type="button"
              className="danger"
              disabled={writesInFlight}
              onClick={() => {
                const id = editingId;
                const deleted = handleDelete(id);
                // Only close the form once the delete actually went through
                // -- window.confirm's own Cancel (handleDelete returning
                // false) must leave the in-progress edit exactly as it was,
                // not silently discard it.
                if (deleted) {
                  // Round 1016: this form reset is otherwise identical to
                  // Cancel's/Escape's own (see their own calls just above),
                  // which is exactly the shape discardAbandonedFileUploads's
                  // own doc comment lists as abandoning an in-progress edit
                  // -- but handleDelete's own server-side cleanup
                  // (deleteReplacedFileFields) only ever knows the record's
                  // last PERSISTED file value, never a replacement file this
                  // edit session uploaded but never saved. Missing this call
                  // left that file orphaned on disk forever, for a record
                  // that no longer even exists.
                  discardAbandonedFileUploads();
                  setForm(emptyForm(entity));
                  setEditingId(null);
                  editingOriginalRef.current = null;
                  bumpFormInstanceKey();
                }
              }}
            >
              {t("entity.delete")}
            </button>
          )}
        </div>
      </form>
      )}

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
          <button type="button" className="secondary small" onClick={refresh}>
            {t("entity.retry")}
          </button>
        </div>
      )}

      {pendingDelete && (
        <p className="entity-undo-toast" role="status">
          {pendingDelete.message}
          <button type="button" className="link-button" onClick={handleUndoDelete}>
            {t("entity.delete.undo")}
          </button>
        </p>
      )}

      {!readOnly && (
      <div className="csv-import-row">
        <label className="csv-import-label">
          {importBusy ? t("entity.import.parsing") : t("entity.importCsv")}
          <input type="file" accept=".csv,text/csv" onChange={handleImportFile} disabled={writesInFlight} hidden />
        </label>
        <label className="json-import-label">
          {importBusy ? t("entity.import.parsing") : t("entity.importJson")}
          <input type="file" accept=".json,application/json" onChange={handleImportJsonFile} disabled={writesInFlight} hidden />
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
        {importWarnings.length > 0 && (
          <button type="button" className="secondary small" onClick={() => setShowImportWarnings((v) => !v)}>
            {showImportWarnings
              ? t("entity.import.hideWarnings")
              : t(importWarnings.length === 1 ? "entity.import.showWarnings.one" : "entity.import.showWarnings.many", {
                  count: importWarnings.length,
                })}
          </button>
        )}
      </div>
      )}
      {showImportErrors && importErrors.length > 0 && (
        <ul className="csv-import-errors">
          {importErrors.map((msg, i) => (
            <li key={i}>{msg}</li>
          ))}
        </ul>
      )}
      {showImportWarnings && importWarnings.length > 0 && (
        <ul className="csv-import-warnings">
          {importWarnings.map((msg, i) => (
            <li key={i}>{msg}</li>
          ))}
        </ul>
      )}

      {loading ? (
        <p className="muted" role="status">
          {t("entity.loading")}
        </p>
      ) : records.length === 0 ? (
        loadError ? null : (
          <div className="empty-state">
            <p>{t("entity.noRecords")}</p>
          </div>
        )
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
              onKeyDown={handleSearchKeyDown}
            />
            {search.length > 0 && (
              <button
                type="button"
                className="secondary small entity-clear-search"
                aria-label={t("entity.search.clear")}
                onClick={() => setSearch("")}
              >
                ✕
              </button>
            )}
            <span className="muted small entity-record-count">
              {formatEntityRecordCount(visibleRecords.length, records.length, t)}
            </span>
            {filterableFields.map((f) => {
              // A filter already set to a value (enum value or related
              // record id) that's since become stale -- an AI refine
              // renaming/narrowing f.enumValues, or the filtered-to related
              // record being deleted, both while the field itself survives
              // under the same name -- has no matching <option> below,
              // which silently blanks this controlled <select> even though
              // fieldFilters[f.name] (and visibleRecords' own filtering by
              // it) stays set to the stale value. The exact same "stale
              // value has no <option>" bug class FieldInput's own
              // enum/relation branches and BoardCard's move select already
              // guard against (round 508) -- this toolbar filter select
              // used the same raw pattern with no synthetic-option guard.
              const currentFilterValue = fieldFilters[f.name] ?? "";
              const knownRelationRecords = f.type === "relation" ? relatedRecords[f.relationTo!] ?? [] : [];
              const hasCurrentRelationOption =
                f.type !== "relation" || currentFilterValue === "" || knownRelationRecords.some((r) => String(r.id) === currentFilterValue);
              const knownEnumFilterValues = f.type === "enum" ? uniqueEnumValues(f.enumValues) : [];
              const enumFilterOptionValues =
                f.type === "enum" && currentFilterValue && !knownEnumFilterValues.includes(currentFilterValue)
                  ? [currentFilterValue, ...knownEnumFilterValues]
                  : knownEnumFilterValues;
              return (
                <select
                  key={f.name}
                  className="entity-status-filter"
                  aria-label={t("entity.filter.byField", { field: fieldDisplayLabel(f, filterableFieldLabelOccurrences) })}
                  value={currentFilterValue}
                  onChange={(e) =>
                    setFieldFilters((prev) => {
                      const next = { ...prev, [f.name]: e.target.value };
                      setFieldFiltersPreference(projectId, entity.name, userId, next);
                      return next;
                    })
                  }
                >
                  <option value="">{t("entity.filter.allValues", { field: fieldDisplayLabel(f, filterableFieldLabelOccurrences) })}</option>
                  {f.type === "boolean" ? (
                    <>
                      <option value="true">{t("entity.groupBy.yes")}</option>
                      <option value="false">{t("entity.groupBy.no")}</option>
                    </>
                  ) : f.type === "date" ? (
                    <>
                      <option value="overdue">{t("entity.dateOverdue")}</option>
                      <option value="dueSoon">{t("entity.dateDueSoon")}</option>
                    </>
                  ) : f.type === "relation" ? (
                    <>
                      {!hasCurrentRelationOption && <option value={currentFilterValue}>{`#${currentFilterValue}`}</option>}
                      {knownRelationRecords.map((r) => (
                        <option key={r.id as number} value={String(r.id)}>
                          {/* Round 1178: case-insensitive -- findFilterableFields above now lets a
                              case-mismatched relation field reach this branch, so this lookup must
                              resolve the same way or the `!` below would throw on undefined. */}
                          {recordDisplayLabel(allEntities.find((e) => e.name.toLowerCase() === f.relationTo!.toLowerCase())!, r, lang)}
                        </option>
                      ))}
                    </>
                  ) : (
                    enumFilterOptionValues.map((v) => (
                      <option key={v} value={v}>
                        {f.enumLabels?.[v] ?? v}
                      </option>
                    ))
                  )}
                </select>
              );
            })}
            {filterableFields.length > 0 && Object.values(fieldFilters).some(Boolean) && (
              <button
                type="button"
                className="secondary small entity-clear-filters"
                onClick={() =>
                  setFieldFilters(() => {
                    setFieldFiltersPreference(projectId, entity.name, userId, {});
                    return {};
                  })
                }
              >
                {t("entity.filter.clearAll")}
              </button>
            )}
            {viewMode === "table" && groupableFields.length > 0 && (
              <select
                className="entity-group-by"
                aria-label={t("entity.groupBy.label")}
                value={groupFieldName}
                onChange={(e) => setGroupFieldName(setGroupByField(projectId, entity.name, userId, e.target.value))}
              >
                <option value="">{t("entity.groupBy.none")}</option>
                {groupableFields.map((f) => (
                  <option key={f.name} value={f.name}>
                    {fieldDisplayLabel(f, groupableFieldLabelOccurrences)}
                  </option>
                ))}
              </select>
            )}
            {(boardField || dateField) && (
              <div className="view-toggle" role="group">
                <button
                  type="button"
                  className={viewMode === "table" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                  aria-pressed={viewMode === "table"}
                  onClick={() => setViewMode(setViewModePreference(projectId, entity.name, userId, "table"))}
                >
                  {t("entity.view.table")}
                </button>
                {boardField && (
                  <button
                    type="button"
                    className={viewMode === "board" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                    aria-pressed={viewMode === "board"}
                    onClick={() => setViewMode(setViewModePreference(projectId, entity.name, userId, "board"))}
                  >
                    {t("entity.view.board")}
                  </button>
                )}
                {dateField && (
                  <button
                    type="button"
                    className={viewMode === "calendar" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                    aria-pressed={viewMode === "calendar"}
                    onClick={() => setViewMode(setViewModePreference(projectId, entity.name, userId, "calendar"))}
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
                {/* Round 937: unlike its sibling Export CSV button right
                    next to it (which already says "Export N selected" when
                    scoped), this button gave zero indication it only ever
                    exports the calendar grid's CURRENTLY-SHOWN month --
                    silently missing every other month's records with no
                    warning, confusing anyone expecting "export my bookings"
                    the way Export CSV means "export my records". */}
                {t("entity.exportIcs.month", {
                  month: calendarMonth.toLocaleDateString(LOCALE[lang], { month: "long", year: "numeric" }),
                })}
              </button>
            )}
            {viewMode === "calendar" && dateField && (
              <button type="button" className="secondary ics-subscribe-btn" onClick={handleSubscribeCalendar} aria-live="polite" aria-atomic="true">
                {subscribeStatus === "copied" ? t("entity.subscribeIcs.copied") : subscribeStatus === "failed" ? t("entity.subscribeIcs.failed") : t("entity.subscribeIcs.button")}
              </button>
            )}
            <button
              type="button"
              className="secondary copy-records-btn"
              onClick={handleCopy}
              disabled={selectedIds.size === 0 && effectivelyVisibleRecords.length === 0}
              aria-live="polite"
              aria-atomic="true"
            >
              {copyStatus === "copied"
                ? t("entity.copy.copied")
                : copyStatus === "failed"
                  ? t("entity.copy.failed")
                  : selectedIds.size > 0
                    ? t("entity.copy.selected", { count: selectedIds.size })
                    : t("entity.copy")}
            </button>
            <button
              type="button"
              className="secondary csv-export-btn"
              onClick={handleExportCsv}
              disabled={selectedIds.size === 0 && effectivelyVisibleRecords.length === 0}
            >
              {selectedIds.size > 0 ? t("entity.exportCsv.selected", { count: selectedIds.size }) : t("entity.exportCsv")}
            </button>
            <button
              type="button"
              className="secondary json-export-btn"
              onClick={handleExportJson}
              disabled={selectedIds.size === 0 && effectivelyVisibleRecords.length === 0}
            >
              {selectedIds.size > 0 ? t("entity.exportJson.selected", { count: selectedIds.size }) : t("entity.exportJson")}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setShowPrintList(true)}
              disabled={selectedIds.size === 0 && effectivelyVisibleRecords.length === 0}
            >
              {selectedIds.size > 0 ? t("entity.printList.selected", { count: selectedIds.size }) : t("entity.printList")}
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
                  {orderedFields.map((f) => (
                    <label key={f.name} className="columns-menu-item">
                      <input
                        type="checkbox"
                        checked={!hiddenFields.has(f.name)}
                        onChange={() => handleToggleColumn(f.name)}
                      />
                      {fieldDisplayLabel(f, orderedFieldLabelOccurrences)}
                    </label>
                  ))}
                </div>
              )}
            </div>
            {Object.keys(columnWidths).length > 0 && (
              <button
                type="button"
                className="secondary small entity-reset-column-widths"
                onClick={() => setColumnWidths(clearColumnWidths(projectId, entity.name, userId))}
              >
                {t("entity.columns.resetWidths")}
              </button>
            )}
            {sortKeys.length > 0 && (
              <button
                type="button"
                className="secondary small entity-clear-sort"
                onClick={() => setSortKeys(setSortKeysPreference(projectId, entity.name, userId, []))}
              >
                {t("entity.sort.clearAll")}
              </button>
            )}
          </div>
          {!search.trim() && recentSearches.length > 0 && (
            <div className="entity-search-recent">
              <div className="entity-search-recent-header">
                <span className="muted small">{t("entity.search.recent.heading")}</span>
                <button type="button" className="link-button small" onClick={handleClearRecentSearches}>
                  {t("entity.search.recent.clear")}
                </button>
              </div>
              <div className="chips">
                {recentSearches.map((q) => (
                  <span className="chip chip-removable" key={q}>
                    <button type="button" className="chip-text" onClick={() => handleRecentSearchClick(q)}>
                      {q}
                    </button>
                    <button
                      type="button"
                      className="chip-remove"
                      title={t("entity.search.recent.remove", { query: q })}
                      aria-label={t("entity.search.recent.remove", { query: q })}
                      onClick={() => handleRemoveRecentSearch(q)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
          {visibleRecords.length === 0 ? (
            <div className="empty-state">
              <p>{t("entity.noResults")}</p>
            </div>
          ) : viewMode === "board" && boardField ? (
            <div className="board-scroll">
              {groupByField(visibleRecords, boardField, t).map((column) => {
                const collapsed = collapsedBoardColumns.has(column.value);
                return (
                <div
                  className={
                    dragOverColumn === column.value
                      ? "board-column board-column-drag-over"
                      : column.isOther
                        ? "board-column board-column-other"
                        : "board-column"
                  }
                  key={column.value}
                  onDragOver={(e) => {
                    // The synthetic "(other)" column has no real enum value
                    // to write back, so it's display-only -- never a valid
                    // drop target. Not calling preventDefault() here means
                    // the browser rejects the drop before onDrop can fire.
                    if (column.isOther || readOnly) return;
                    e.preventDefault();
                    setDragOverColumn(column.value);
                  }}
                  onDragLeave={() => setDragOverColumn((prev) => (prev === column.value ? null : prev))}
                  onDrop={(e) => {
                    if (column.isOther || readOnly) return;
                    handleCardDrop(e, boardField.name, column.value);
                  }}
                >
                  <div className="board-column-header">
                    <div className="board-column-header-info">
                      <button
                        type="button"
                        className="board-column-toggle"
                        onClick={() => toggleBoardColumnCollapsed(column.value)}
                        aria-expanded={!collapsed}
                        aria-label={collapsed ? t("entity.board.expandColumn") : t("entity.board.collapseColumn")}
                      >
                        {collapsed ? "▸" : "▾"}
                      </button>
                      <span className={`badge badge-${badgeTone(column.value)}`}>{column.label}</span>
                      <span className="muted small">{column.records.length}</span>
                      {hasNumericVisibleField &&
                        visibleFields
                          .filter((f) => f.type === "number")
                          .map((f) => (
                            <span key={f.name} className="muted small board-column-total">
                              {t("entity.table.total")}: {formatNumberValue(boardColumnNumericTotals?.[column.value]?.[f.name] ?? 0, lang)}
                            </span>
                          ))}
                    </div>
                    {!column.isOther && !readOnly && (
                      <button
                        type="button"
                        className="board-add-card-btn"
                        title={t("entity.board.addCard", { value: column.label })}
                        aria-label={t("entity.board.addCard", { value: column.label })}
                        onClick={() => startCreateForColumn(column.value, boardField)}
                      >
                        +
                      </button>
                    )}
                  </div>
                  {!collapsed && column.records.map((record) => (
                    <BoardCard
                      key={record.id as number}
                      orderedFields={orderedFields}
                      boardField={boardField}
                      record={record}
                      lang={lang}
                      t={t}
                      allEntities={allEntities}
                      relatedRecords={relatedRecords}
                      highlightQuery={search}
                      hasMoveError={record.id === moveErrorId}
                      onMove={(value) => handleMove(record.id as number, boardField.name, value)}
                      onEdit={() => startEdit(record)}
                      onDuplicate={() => handleDuplicate(record.id as number)}
                      onDelete={() => handleDelete(record.id as number)}
                      onPrint={() => setRecordToPrint(record)}
                      phoneField={phoneField}
                      onSendWhatsApp={onSendWhatsApp}
                      onDragEnd={() => setDragOverColumn(null)}
                      onJumpToRecord={onJumpToRecord}
                      readOnly={readOnly}
                      bulkActionBusy={writesInFlight}
                    />
                  ))}
                </div>
                );
              })}
            </div>
          ) : viewMode === "calendar" && dateField ? (
            <CalendarView
              entity={entity}
              dateField={dateField}
              endDateField={endDateField}
              records={visibleRecords}
              month={calendarMonth}
              lang={lang}
              t={t}
              onPrevMonth={() => setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              onNextMonth={() => setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
              onToday={() => setCalendarMonth(new Date())}
              onJumpToMonth={(m) => setCalendarMonth(m)}
              onEdit={readOnly ? () => {} : startEdit}
              onPrint={(record) => setRecordToPrint(record)}
              onDuplicate={readOnly ? () => {} : (record) => handleDuplicate(record.id as number)}
              onDelete={readOnly ? () => {} : (record) => handleDelete(record.id as number)}
              orderedFields={orderedFields}
              phoneField={phoneField}
              onSendWhatsApp={onSendWhatsApp}
              onDayClick={readOnly ? () => {} : (date) => startCreateForDate(date, dateField)}
              onReschedule={readOnly ? () => {} : (record, date, originDay) => handleCalendarDrop(record, dateField.name, date, originDay)}
              moveErrorId={moveErrorId}
              readOnly={readOnly}
              bulkActionBusy={writesInFlight}
            />
          ) : (
            <div className="table-scroll" ref={tableScrollRef}>
              {visibleFields.length > 0 && <p className="muted small sort-hint">{t("entity.sort.multiHint")}</p>}
              {selectedIds.size > 0 && !readOnly && (
                <div className="bulk-actions-bar">
                  <span>{t("entity.bulk.selectedCount", { count: selectedIds.size })}</span>
                  <label className="bulk-edit-field-label">
                    {t("entity.bulk.setField")}
                    <select value={bulkEditField} onChange={(e) => handleBulkEditFieldChange(e.target.value)}>
                      <option value="">{t("entity.bulk.chooseField")}</option>
                      {bulkEditableFields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {fieldDisplayLabel(f, bulkEditableFieldLabelOccurrences)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {bulkEditField && bulkEditFieldDef && (
                    <FieldInput
                      field={bulkEditFieldDef}
                      value={bulkEditValue}
                      onChange={setBulkEditValue}
                      // Round 1178: case-insensitive, same reason as the two call sites above.
                      relatedEntity={bulkEditFieldDef.relationTo ? allEntities.find((e) => e.name.toLowerCase() === bulkEditFieldDef.relationTo!.toLowerCase()) : undefined}
                      relatedEntityRecords={bulkEditFieldDef.relationTo ? relatedRecords[bulkEditFieldDef.relationTo] : undefined}
                      // Round 1243: case-insensitive, same reason as the two call sites above.
                      excludeRecordIds={bulkEditFieldDef.relationTo?.toLowerCase() === entity.name.toLowerCase() ? Array.from(selectedIds) : undefined}
                    />
                  )}
                  {bulkEditField && (
                    <button type="button" className="secondary" disabled={writesInFlight} onClick={handleBulkUpdate}>
                      {bulkActionBusy ? t("entity.bulk.apply.busy") : t("entity.bulk.apply", { count: selectedIds.size })}
                    </button>
                  )}
                  <button type="button" className="secondary" disabled={writesInFlight} onClick={handleBulkDuplicate}>
                    {bulkActionBusy ? t("entity.bulk.duplicateSelected.busy") : t("entity.bulk.duplicateSelected")}
                  </button>
                  <button type="button" className="danger" disabled={writesInFlight} onClick={handleBulkDelete}>
                    {t("entity.bulk.deleteSelected")}
                  </button>
                  <button type="button" className="secondary" onClick={() => setSelectedIds(new Set())}>
                    {t("entity.bulk.clearSelection")}
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
                          effectivelyVisibleRecords.length > 0 &&
                          effectivelyVisibleRecords.every((r) => selectedIds.has(r.id as number))
                        }
                        ref={(el) => {
                          if (!el) return;
                          const someSelected = effectivelyVisibleRecords.some((r) => selectedIds.has(r.id as number));
                          const allSelected =
                            effectivelyVisibleRecords.length > 0 &&
                            effectivelyVisibleRecords.every((r) => selectedIds.has(r.id as number));
                          el.indeterminate = someSelected && !allSelected;
                        }}
                        onChange={toggleSelectAllVisible}
                        disabled={readOnly}
                      />
                    </th>
                    {visibleFields.map((f, visibleIndex) => {
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
                          onDragEnd={() => setDragOverField(null)}
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
                            {fieldDisplayLabel(f, visibleFieldLabelOccurrences)}
                            {key && (key.direction === "asc" ? " ▲" : " ▼")}
                            {key && sortKeys.length > 1 && <span className="sort-priority">{keyIndex + 1}</span>}
                          </button>
                          <span className="column-move-buttons">
                            <button
                              type="button"
                              className="column-move-btn"
                              onClick={() => handleMoveColumn(f.name, "earlier")}
                              disabled={visibleIndex === 0}
                              aria-label={t("entity.columns.moveEarlier", { field: fieldDisplayLabel(f, visibleFieldLabelOccurrences) })}
                            >
                              ‹
                            </button>
                            <button
                              type="button"
                              className="column-move-btn"
                              onClick={() => handleMoveColumn(f.name, "later")}
                              disabled={visibleIndex === visibleFields.length - 1}
                              aria-label={t("entity.columns.moveLater", { field: fieldDisplayLabel(f, visibleFieldLabelOccurrences) })}
                            >
                              ›
                            </button>
                          </span>
                          <span
                            className="column-resize-handle"
                            role="slider"
                            tabIndex={0}
                            aria-orientation="horizontal"
                            aria-valuemin={MIN_COLUMN_WIDTH}
                            aria-valuemax={MAX_COLUMN_WIDTH}
                            aria-valuenow={Math.round(columnWidths[f.name] ?? 150)}
                            aria-label={t("entity.columns.resizeHandle", { field: fieldDisplayLabel(f, visibleFieldLabelOccurrences) })}
                            onMouseDown={(e) => startResize(e, f.name)}
                            onKeyDown={(e) => handleResizeKeyDown(e, f.name)}
                            draggable
                            onDragStart={(e) => e.preventDefault()}
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
                    ? recordGroups.map((group) => {
                        const collapsed = collapsedGroups.has(group.key);
                        return (
                        <Fragment key={group.key}>
                          <tr className="entity-group-header-row">
                            <td colSpan={visibleFields.length + 3}>
                              <button
                                type="button"
                                className="entity-group-toggle"
                                onClick={() => toggleGroupCollapsed(group.key)}
                                aria-expanded={!collapsed}
                                aria-label={collapsed ? t("entity.group.expand") : t("entity.group.collapse")}
                              >
                                {collapsed ? "▸" : "▾"}
                              </button>{" "}
                              {group.label} <span className="muted small">({group.records.length})</span>
                            </td>
                          </tr>
                          {!collapsed && group.records.map(renderRecordRow)}
                          {!collapsed && hasNumericVisibleField && (
                            <tr className="entity-group-totals-row">
                              <td className="select-col" />
                              {visibleFields.map((f) => (
                                <td key={f.name}>
                                  {f.type === "number" && (
                                    <>
                                      {t("entity.table.total")}:{" "}
                                      {formatNumberValue(groupNumericTotals?.[group.key]?.[f.name] ?? 0, lang)}
                                    </>
                                  )}
                                </td>
                              ))}
                              <td />
                              <td />
                            </tr>
                          )}
                        </Fragment>
                        );
                      })
                    : visibleRecords.map(renderRecordRow)}
                </tbody>
                {hasNumericVisibleField && (
                  <tfoot>
                    <tr className="entity-totals-row">
                      <th className="select-col" />
                      {visibleFields.map((f) => (
                        <th key={f.name}>
                          {f.type === "number" && (
                            <>
                              {t("entity.table.total")}: {formatNumberValue(numericFieldTotals[f.name] ?? 0, lang)}
                            </>
                          )}
                        </th>
                      ))}
                      <th />
                      <th />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </>
      )}
      <RecordPrintSheet
        entity={entity}
        fields={orderedFields}
        record={recordToPrint}
        lang={lang}
        t={t}
        allEntities={allEntities}
        relatedRecords={relatedRecords}
      />
      <RecordListPrintSheet
        entity={entity}
        fields={orderedFields}
        records={selectedOrAllRecords(records, effectivelyVisibleRecords, selectedIds)}
        groups={printGroups}
        show={showPrintList}
        lang={lang}
        t={t}
        allEntities={allEntities}
        relatedRecords={relatedRecords}
      />
    </div>
  );
}
