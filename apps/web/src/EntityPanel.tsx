import { useEffect, useState } from "react";
import type { Entity, EntityRecord, Field } from "@forge/shared";
import { createRecord, deleteRecord, listRecords, updateRecord } from "./api.js";

function emptyForm(entity: Entity): Record<string, unknown> {
  const form: Record<string, unknown> = {};
  for (const field of entity.fields) {
    form[field.name] = field.type === "boolean" ? false : "";
  }
  return form;
}

function formatCell(field: Field, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (field.type === "boolean") return value ? "כן" : "לא";
  if (field.type === "enum") return field.enumLabels?.[String(value)] ?? String(value);
  return String(value);
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
          לבחור…
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
        placeholder={field.type === "relation" ? "מספר מזהה" : undefined}
      />
    );
  }
  if (field.type === "date") {
    return <input type="date" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
  }
  return <input type="text" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
}

export function EntityPanel({ projectId, entity }: { projectId: string; entity: Entity }) {
  const [records, setRecords] = useState<EntityRecord[]>([]);
  const [form, setForm] = useState<Record<string, unknown>>(() => emptyForm(entity));
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.name]);

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
          <button type="submit">{editingId != null ? "שמירה" : "הוספה"}</button>
          {editingId != null && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setEditingId(null);
                setForm(emptyForm(entity));
              }}
            >
              ביטול
            </button>
          )}
        </div>
      </form>

      {error && <p className="error">{error}</p>}
      {loading ? (
        <p className="muted">טוען…</p>
      ) : records.length === 0 ? (
        <p className="muted">אין עדיין רשומות — אפשר להוסיף את הראשונה למעלה.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {entity.fields.map((f) => (
                  <th key={f.name}>{f.label ?? f.name}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id as number}>
                  {entity.fields.map((f) => (
                    <td key={f.name}>{formatCell(f, record[f.name])}</td>
                  ))}
                  <td className="row-actions">
                    <button type="button" onClick={() => startEdit(record)}>
                      עריכה
                    </button>
                    <button type="button" className="danger" onClick={() => handleDelete(record.id as number)}>
                      מחיקה
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
