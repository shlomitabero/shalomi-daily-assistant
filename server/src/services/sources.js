import { db, makeId } from '../db/store.js';
import { SOURCE_DEFINITIONS, isSourceConnected } from '../engine/sourceDefinitions.js';

// Keeps the sources table in sync with the honest connector registry —
// re-checks which env vars are actually present so "connected" always
// reflects reality, never a stale guess.
export function syncSources() {
  const now = new Date().toISOString();
  for (const def of SOURCE_DEFINITIONS) {
    const existing = db.sources.where((s) => s.key === def.id)[0];
    const connected = isSourceConnected(def);
    if (existing) {
      // name/description/howToConnect must be refreshed too, not just
      // connected/lastCheckedAt — otherwise editing SOURCE_DEFINITIONS (e.g.
      // fixing a howToConnect instruction) would silently never reach a
      // source row created before the edit, since insert() only runs once.
      db.sources.update(existing.id, {
        connected,
        lastCheckedAt: now,
        name: def.name,
        description: def.description,
        howToConnect: def.howToConnect,
        category: def.category,
      });
    } else {
      db.sources.insert({
        id: makeId('src'),
        key: def.id,
        name: def.name,
        category: def.category,
        description: def.description,
        howToConnect: def.howToConnect,
        connected,
        lastCheckedAt: now,
        lastScannedAt: null,
      });
    }
  }
  return db.sources.all();
}
