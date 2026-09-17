import { randomUUID } from "node:crypto";
import type { ForgeDatabase } from "./connection.js";

/**
 * WhatsApp integration storage. Per direct user request, this does NOT use
 * Meta's official WhatsApp Business Platform (which would require the
 * project owner to independently obtain a Meta Business account, a
 * verified business phone number, and an access token). Instead it
 * connects the way WhatsApp Web/Desktop does: the project owner scans a QR
 * code with their own personal or business WhatsApp app to link this
 * server as an additional device -- no Meta account of any kind needed.
 * This is an unofficial method (WhatsApp's own terms of service are
 * written around their official clients and the Business API), carrying a
 * real, if small, risk that WhatsApp could flag or block a number showing
 * automated behavior -- disclosed to the user before building this, and
 * again in the UI. This module tracks each project's last known
 * connection (for display only -- the live connected/disconnected state
 * always comes from the in-memory WhatsAppWebManager, since a real
 * process restart always drops the live socket) plus the message log.
 */

export interface WhatsAppConnection {
  projectId: string;
  /** The linked WhatsApp account's own number, once known -- null until a first successful connection. */
  phoneNumber: string | null;
  connectedAt: string | null;
  updatedAt: string;
}

export function ensureWhatsAppConnectionsTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_connections (
      projectId TEXT PRIMARY KEY,
      phoneNumber TEXT,
      connectedAt TEXT,
      updatedAt TEXT NOT NULL
    )
  `);
}

function rowToConnection(row: Record<string, unknown>): WhatsAppConnection {
  return {
    projectId: row.projectId as string,
    phoneNumber: (row.phoneNumber as string | null) ?? null,
    connectedAt: (row.connectedAt as string | null) ?? null,
    updatedAt: row.updatedAt as string,
  };
}

export function getWhatsAppConnection(db: ForgeDatabase, projectId: string): WhatsAppConnection | undefined {
  const row = db.prepare("SELECT * FROM whatsapp_connections WHERE projectId = ?").get(projectId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToConnection(row) : undefined;
}

/** Records that a project's WhatsApp Web session successfully paired with the given phone number. */
export function recordWhatsAppConnected(db: ForgeDatabase, projectId: string, phoneNumber: string): WhatsAppConnection {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO whatsapp_connections (projectId, phoneNumber, connectedAt, updatedAt)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(projectId) DO UPDATE SET
       phoneNumber = excluded.phoneNumber,
       connectedAt = excluded.connectedAt,
       updatedAt = excluded.updatedAt`,
  ).run(projectId, phoneNumber, now, now);
  return getWhatsAppConnection(db, projectId)!;
}

/** Records that a project's WhatsApp Web session was disconnected -- keeps the last known phone number for display, clears the "currently connected" timestamp. */
export function recordWhatsAppDisconnected(db: ForgeDatabase, projectId: string): void {
  const existing = getWhatsAppConnection(db, projectId);
  if (!existing) return;
  db.prepare(
    `UPDATE whatsapp_connections SET connectedAt = NULL, updatedAt = ? WHERE projectId = ?`,
  ).run(new Date().toISOString(), projectId);
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
