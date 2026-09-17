import { randomUUID } from "node:crypto";
import type { ForgeDatabase } from "./connection.js";

/**
 * WhatsApp integration storage. Real, two-way sync with WhatsApp is only
 * possible through Meta's official WhatsApp Business Platform (Cloud
 * API) -- there is no other supported way for a third-party app to send
 * or receive WhatsApp messages. That means every project's owner must
 * bring their own Meta-issued credentials (a phone number id and an
 * access token) and their own verified WhatsApp Business phone number;
 * Forge AI can't create or fake that account for them. This module just
 * stores whatever credentials the project owner has entered, plus a log
 * of messages sent/received once they have.
 */

export interface WhatsAppSettings {
  projectId: string;
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  updatedAt: string;
}

export function ensureWhatsAppSettingsTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_settings (
      projectId TEXT PRIMARY KEY,
      phoneNumberId TEXT NOT NULL,
      accessToken TEXT NOT NULL,
      verifyToken TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
}

function rowToSettings(row: Record<string, unknown>): WhatsAppSettings {
  return {
    projectId: row.projectId as string,
    phoneNumberId: row.phoneNumberId as string,
    accessToken: row.accessToken as string,
    verifyToken: row.verifyToken as string,
    updatedAt: row.updatedAt as string,
  };
}

export function getWhatsAppSettings(db: ForgeDatabase, projectId: string): WhatsAppSettings | undefined {
  const row = db.prepare("SELECT * FROM whatsapp_settings WHERE projectId = ?").get(projectId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToSettings(row) : undefined;
}

export function upsertWhatsAppSettings(
  db: ForgeDatabase,
  projectId: string,
  settings: { phoneNumberId: string; accessToken: string; verifyToken: string },
): WhatsAppSettings {
  const updatedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO whatsapp_settings (projectId, phoneNumberId, accessToken, verifyToken, updatedAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(projectId) DO UPDATE SET
       phoneNumberId = excluded.phoneNumberId,
       accessToken = excluded.accessToken,
       verifyToken = excluded.verifyToken,
       updatedAt = excluded.updatedAt`,
  ).run(projectId, settings.phoneNumberId, settings.accessToken, settings.verifyToken, updatedAt);
  return getWhatsAppSettings(db, projectId)!;
}

export type WhatsAppMessageDirection = "in" | "out";
export type WhatsAppMessageStatus = "received" | "sent" | "failed";

export interface WhatsAppMessage {
  id: string;
  projectId: string;
  direction: WhatsAppMessageDirection;
  fromNumber: string;
  toNumber: string;
  body: string;
  /** Display label of the entity record this message was matched to by phone number, if any -- captured at insert time so the log stays readable even if that record is later edited or deleted. */
  matchedLabel: string | null;
  matchedEntityName: string | null;
  matchedRecordId: number | null;
  status: WhatsAppMessageStatus;
  createdAt: string;
}

export function ensureWhatsAppMessagesTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      direction TEXT NOT NULL,
      fromNumber TEXT NOT NULL,
      toNumber TEXT NOT NULL,
      body TEXT NOT NULL,
      matchedLabel TEXT,
      matchedEntityName TEXT,
      matchedRecordId INTEGER,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);
}

function rowToMessage(row: Record<string, unknown>): WhatsAppMessage {
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    direction: row.direction as WhatsAppMessageDirection,
    fromNumber: row.fromNumber as string,
    toNumber: row.toNumber as string,
    body: row.body as string,
    matchedLabel: (row.matchedLabel as string | null) ?? null,
    matchedEntityName: (row.matchedEntityName as string | null) ?? null,
    matchedRecordId: (row.matchedRecordId as number | null) ?? null,
    status: row.status as WhatsAppMessageStatus,
    createdAt: row.createdAt as string,
  };
}

export function insertWhatsAppMessage(
  db: ForgeDatabase,
  message: {
    projectId: string;
    direction: WhatsAppMessageDirection;
    fromNumber: string;
    toNumber: string;
    body: string;
    matchedLabel?: string | null;
    matchedEntityName?: string | null;
    matchedRecordId?: number | null;
    status: WhatsAppMessageStatus;
  },
): WhatsAppMessage {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO whatsapp_messages
       (id, projectId, direction, fromNumber, toNumber, body, matchedLabel, matchedEntityName, matchedRecordId, status, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    message.projectId,
    message.direction,
    message.fromNumber,
    message.toNumber,
    message.body,
    message.matchedLabel ?? null,
    message.matchedEntityName ?? null,
    message.matchedRecordId ?? null,
    message.status,
    createdAt,
  );
  return { ...message, id, createdAt, matchedLabel: message.matchedLabel ?? null, matchedEntityName: message.matchedEntityName ?? null, matchedRecordId: message.matchedRecordId ?? null };
}

export function listWhatsAppMessages(db: ForgeDatabase, projectId: string, limit = 50): WhatsAppMessage[] {
  // createdAt has only millisecond precision, so two messages inserted in
  // the same millisecond (a real possibility for a fast reply, or in a
  // test) would tie -- break the tie with rowid so "most recent first"
  // always matches actual insertion order, not an arbitrary one.
  const rows = db
    .prepare("SELECT * FROM whatsapp_messages WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?")
    .all(projectId, limit) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}
