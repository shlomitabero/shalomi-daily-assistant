// node:sqlite is experimental as of Node 22 but ships in core — no native
// build step, which matters a lot for a sandboxed build/dev environment.
// See docs/ADR/0001-initial-architecture.md for the tradeoff.
import { DatabaseSync } from "node:sqlite";

export type ForgeDatabase = DatabaseSync;

export function openDatabase(path: string): ForgeDatabase {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}
