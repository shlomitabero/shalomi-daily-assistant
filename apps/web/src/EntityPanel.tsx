import { useEffect, useMemo, useState } from "react";
import type { Entity, EntityRecord, Field } from "@forge/shared";
import { createRecord, deleteRecord, listRecords, updateRecord } from "./api.js";
import { badgeTone, formatDateValue, formatNumberValue, matchesSearch, sortRecords, type SortDirection } from "./entityFormatting.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import type { Lang } from "./i18n/language.js";

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
function Cell({ field, value, lang, t }: { field: Field; value: unknown; lang: Lang; t: (key: string) => string }) {
  if (value === null || value === undefined || value === "") {
    return <span className="muted">{t("entity.empty")}</span>;
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

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation();
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

export function EntityPanel({ projectId, entity }: { projectId: string; entity: Entity }) {
  const { t, lang } = useTranslation();
  const [records, setRecords] = useState<EntityRecord[]>([]);
  const [form, setForm] = useState<Record<string, unknown>>(() => emptyForm(entity));
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>("asc");

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
    setError(null);
    try {
      await deleteRecord(projectId, entity.name, id);
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

      {error && <p className="error">{error}</p>}
      {loading ? (
        <p className="muted">{t("entity.loading")}</p>
      ) : records.length === 0 ? (
        <div className="empty-state">
          <p>{t("entity.noRecords")}</p>
        </div>
      ) : (
        <>
          <input
            type="text"
            className="entity-search"
            placeholder={t("entity.search.placeholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {visibleRecords.length === 0 ? (
            <div className="empty-state">
              <p>{t("entity.noResults")}</p>
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {entity.fields.map((f) => (
                      <th key={f.name}>
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
                      {entity.fields.map((f) => (
                        <td key={f.name}>
                          <Cell field={f} value={record[f.name]} lang={lang} t={t} />
                        </td>
                      ))}
                      <td className="row-actions">
                        <button type="button" onClick={() => startEdit(record)}>
                          {t("entity.edit")}
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
