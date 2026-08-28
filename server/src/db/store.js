// File-backed data store implementing the entities defined in /schema.sql.
//
// FROM ZERO's MVP ships without external infrastructure so it can be cloned
// and played immediately. Every table in schema.sql has a matching in-memory
// collection here, persisted to a single JSON snapshot on disk. All access
// goes through this module — routes and engines never touch the filesystem
// directly — so replacing this file with a real Postgres repository (same
// function signatures) is the entire migration to production.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const DB_FILE = join(DATA_DIR, 'db.json');

const TABLES = [
  'users', 'profiles', 'reputation', 'businesses', 'business_financials',
  'employees', 'properties', 'loans', 'investments', 'offers', 'negotiations',
  'transactions', 'player_rank', 'legacy', 'events', 'world_feed',
  'leaderboards', 'ai_conversations',
];

// A handful of tables use profile_id as their primary key instead of id.
const KEY_FIELD = {
  reputation: 'profile_id',
  player_rank: 'profile_id',
};

function emptyState() {
  const state = { market_state: { id: 1, cycle: 'stable', interest_rate: 0.06 } };
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
  const keyField = KEY_FIELD[name] ?? 'id';
  return {
    get: (id) => state[name][id] ?? null,
    all: () => Object.values(state[name]),
    where: (pred) => Object.values(state[name]).filter(pred),
    insert: (row) => {
      state[name][row[keyField]] = row;
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

export function getMarketState() {
  return state.market_state;
}

export function setMarketState(patch) {
  state.market_state = { ...state.market_state, ...patch };
  persist();
  return state.market_state;
}

// Used only by tests / seed reset.
export function __resetForTests() {
  state = emptyState();
}
