// File-backed data store. Every route/engine goes through this module's
// get/where/insert/update, never touches the filesystem directly — so
// swapping this for a real Postgres repository (same function signatures)
// is the entire migration to production. This is a personal single-owner
// tool, not a multi-tenant SaaS, so there is no users table.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';

const __dirname = dirname(fileURLToPath(import.meta.url));

// On a platform like Railway, a plain relative path lives inside the
// container's filesystem, which is thrown away and rebuilt fresh on every
// deploy — there is nothing to attach a persistent volume to unless the
// path is a fixed, known location. DATA_DIR lets the deploy pin that
// location explicitly (e.g. a volume mounted at /data) while local dev and
// tests keep working unchanged with no env var set.
export function resolveDataDir(envValue, defaultDir) {
  return envValue || defaultDir;
}

const DATA_DIR = resolveDataDir(process.env.DATA_DIR, join(__dirname, '..', '..', 'data'));
const DB_FILE = join(DATA_DIR, 'db.json');

const TABLES = [
  'settings', 'sources', 'opportunities', 'ledger', 'actions_log',
  'approvals', 'financial_watchlist', 'paper_trades', 'digests',
];

function emptyState() {
  const state = {};
  for (const t of TABLES) state[t] = {};
  return state;
}

let state = load();

function load() {
  if (existsSync(DB_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(DB_FILE, 'utf-8'));
      return { ...emptyState(), ...raw };
    } catch (err) {
      // A corrupt db.json silently swallowed here used to be catastrophic:
      // the in-memory state would start empty, and the very first write
      // anywhere in the app (even just `getSettings()` inserting its
      // defaults on login) calls persist(), which overwrites DB_FILE with
      // that near-empty state — permanently destroying the entire ledger,
      // every opportunity, every approval, before the owner could ever
      // notice. Back up the corrupt file first so it's recoverable, and
      // log loudly so this shows up in the deploy logs instead of vanishing.
      console.error(`db.json is corrupt and could not be parsed (${err.message}) — starting from empty state. The corrupt file has been preserved for recovery.`);
      try {
        renameSync(DB_FILE, `${DB_FILE}.corrupt-${Date.now()}`);
      } catch (renameErr) {
        console.error('could not back up the corrupt db.json', renameErr);
      }
      return emptyState();
    }
  }
  return emptyState();
}

function persist() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
}

export function makeId(prefix) {
  return `${prefix}_${nanoid(10)}`;
}

function table(name) {
  return {
    get(id) {
      return state[name][id] ?? null;
    },
    all() {
      return Object.values(state[name]);
    },
    where(predicate) {
      return Object.values(state[name]).filter(predicate);
    },
    insert(row) {
      state[name][row.id] = row;
      persist();
      return row;
    },
    update(id, patch) {
      const existing = state[name][id];
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      state[name][id] = updated;
      persist();
      return updated;
    },
    delete(id) {
      const existed = Boolean(state[name][id]);
      delete state[name][id];
      if (existed) persist();
      return existed;
    },
  };
}

export const db = Object.fromEntries(TABLES.map((t) => [t, table(t)]));

// Test-only: reset all tables to empty without touching disk.
export function __resetForTests() {
  state = emptyState();
}
