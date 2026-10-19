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
  ensureIdempotencyKeysTable,
  ensureLoginCodesTable,
  ensurePasswordResetTokensTable,
  ensureAutomationRulesTable,
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
  ensureIdempotencyKeysTable(db);
  ensureLoginCodesTable(db);
  ensurePasswordResetTokensTable(db);
  ensureAutomationRulesTable(db);
  return db;
}
