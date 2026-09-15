import type { EntityRecord, Field } from "@forge/shared";
import type { Lang } from "./i18n/language.js";

export const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

const POSITIVE_WORDS = [
  "won",
  "completed",
  "active",
  "paid",
  "delivered",
  "success",
  "qualified",
  "shipped",
  "confirmed",
  "approved",
];
const NEGATIVE_WORDS = [
  "lost",
  "cancelled",
  "canceled",
  "inactive",
  "overdue",
  "no-show",
  "failed",
  "rejected",
  "declined",
];

export type BadgeTone = "positive" | "negative" | "neutral";

/**
 * Classifies a raw enum value into a visual tone for the status-badge
 * rendering in EntityPanel, without needing per-app configuration: the
 * domain library's own enum values (see spec-engine/domainEntities.ts)
 * already use these common English words, so this covers every built-in
 * entity out of the box and degrades gracefully to neutral for anything
 * else (e.g. a freeform value an AI-generated spec introduced).
 */
export function badgeTone(rawValue: string): BadgeTone {
  const lower = rawValue.toLowerCase();
  if (POSITIVE_WORDS.some((w) => lower.includes(w))) return "positive";
  if (NEGATIVE_WORDS.some((w) => lower.includes(w))) return "negative";
  return "neutral";
}

/** Formats an ISO date string for display; returns the raw value unchanged if it isn't a valid date. */
export function formatDateValue(value: string, lang: Lang): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(LOCALE[lang]);
}

/** Adds locale-appropriate thousands separators to a numeric value. */
export function formatNumberValue(value: number, lang: Lang): string {
  return value.toLocaleString(LOCALE[lang]);
}

/** True if any of the entity's fields on this record contain the search query (case-insensitive). */
export function matchesSearch(record: EntityRecord, fields: Field[], query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  return fields.some((field) => {
    const value = record[field.name];
    if (value === null || value === undefined) return false;
    const display = field.type === "enum" ? (field.enumLabels?.[String(value)] ?? String(value)) : String(value);
    return display.toLowerCase().includes(trimmed);
  });
}

export type SortDirection = "asc" | "desc";

function compareValues(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

/** Sorts a copy of `records` by `field.name`; returns `records` unchanged (same reference) when `sortField` is null. */
export function sortRecords(records: EntityRecord[], sortField: string | null, direction: SortDirection): EntityRecord[] {
  if (!sortField) return records;
  const sorted = [...records].sort((a, b) => compareValues(a[sortField], b[sortField]));
  return direction === "desc" ? sorted.reverse() : sorted;
}
