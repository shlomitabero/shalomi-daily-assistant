// File-backed data store. Same pattern as every other project built this
// way: every route/engine goes through this module's get/where/insert/
// update, never touches the filesystem directly — so swapping this for a
// real Postgres repository (same function signatures) is the entire
// migration to production. Needed here because the Supabase org tied to
// this account is already at its 2-active-project free-tier limit.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const DB_FILE = join(DATA_DIR, 'db.json');

const TABLES = ['users', 'generations', 'subscriptions', 'referrals', 'events'];

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
    } catch {
      return emptyState();
    }
  }
  return emptyState();
}

let saveScheduled = false;
function persist() {
  if (saveScheduled) return;
  saveScheduled = true;
  setImmediate(() => {
    saveScheduled = false;
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
  });
}

let seq = Date.now() % 1_000_000;
export function makeId(prefix) {
  seq += 1;
  return `${prefix}_${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function collection(name) {
  return {
    get: (id) => state[name][id] ?? null,
    all: () => Object.values(state[name]),
    where: (pred) => Object.values(state[name]).filter(pred),
    insert: (row) => {
      state[name][row.id] = row;
      persist();
      return row;
    },
    update: (id, patch) => {
      if (!state[name][id]) return null;
      state[name][id] = { ...state[name][id], ...patch };
      persist();
      return state[name][id];
    },
    remove: (id) => {
      delete state[name][id];
      persist();
    },
  };
}

export const db = Object.fromEntries(TABLES.map((t) => [t, collection(t)]));

export function __resetForTests() {
  state = emptyState();
}
