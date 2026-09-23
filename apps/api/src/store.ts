import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  openDatabase,
  ensureProjectsTable,
  ensureProjectCollaboratorsTable,
  ensureUsersTable,
  ensureCheckpointsTable,
  ensureWhatsAppConnectionsTable,
  ensureWhatsAppMessagesTable,
  type ForgeDatabase,
} from "@forge/db";

export function createStore(path: string): ForgeDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = openDatabase(path);
  ensureProjectsTable(db);
  ensureProjectCollaboratorsTable(db);
  ensureUsersTable(db);
  ensureCheckpointsTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);
  return db;
}
