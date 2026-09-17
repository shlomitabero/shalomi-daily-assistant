import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  openDatabase,
  ensureProjectsTable,
  ensureUsersTable,
  ensureCheckpointsTable,
  ensureWhatsAppSettingsTable,
  ensureWhatsAppMessagesTable,
  type ForgeDatabase,
} from "@forge/db";

export function createStore(path: string): ForgeDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = openDatabase(path);
  ensureProjectsTable(db);
  ensureUsersTable(db);
  ensureCheckpointsTable(db);
  ensureWhatsAppSettingsTable(db);
  ensureWhatsAppMessagesTable(db);
  return db;
}
