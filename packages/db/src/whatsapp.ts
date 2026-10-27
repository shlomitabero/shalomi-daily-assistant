import { randomUUID } from "node:crypto";
import type { ForgeDatabase } from "./connection.js";
import { NotFoundError } from "./repository.js";

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
  /**
   * Round 1101: the send route always deletes a test-send's uploaded
   * attachment file right after whatsapp.sendMessage() resolves, win or
   * lose (round 979's own doc comment: "single-use... deleting it now,
   * regardless of whether the send itself succeeded") -- and nothing
   * about the attachment itself (its name, or even that one existed) was
   * ever stored on the message row. A failed send with an attachment
   * that's later retried from the log (WhatsAppPanel.tsx's handleRetry)
   * had no way to know the original attempt had one at all, so it always
   * resent text-only with no warning -- a real, silent data-loss gap:
   * the customer never receives the attachment, and nothing in the UI
   * or log ever says so. This flag alone is enough for the log to warn
   * before a text-only retry; there's deliberately no way to actually
   * re-send the original file (it's already gone from disk by the time
   * this row is even inserted).
   */
  hadAttachment: boolean;
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
      hadAttachment INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL
    )
  `);
  // Round 1101: additive-only, same discipline as every other column
  // migration in this codebase -- a table created before this round has
  // no hadAttachment column at all. Defaults every pre-existing row to 0
  // (false): whether any of those messages originally had an attachment
  // is genuinely unknowable now (the attachment itself was already
  // deleted from disk and never recorded anywhere), and false is the
  // safe default here -- it just means the log won't show this round's
  // new retry warning for a message that predates this column, not that
  // anything is lost that wasn't already gone.
  const columns = (db.prepare("PRAGMA table_info(whatsapp_messages)").all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes("hadAttachment")) {
    db.exec("ALTER TABLE whatsapp_messages ADD COLUMN hadAttachment INTEGER NOT NULL DEFAULT 0");
  }
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
    hadAttachment: Boolean(row.hadAttachment),
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
    hadAttachment?: boolean;
  },
): WhatsAppMessage {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO whatsapp_messages
       (id, projectId, direction, fromNumber, toNumber, body, matchedLabel, matchedEntityName, matchedRecordId, status, hadAttachment, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    message.hadAttachment ? 1 : 0,
    createdAt,
  );
  return {
    ...message,
    id,
    createdAt,
    matchedLabel: message.matchedLabel ?? null,
    matchedEntityName: message.matchedEntityName ?? null,
    matchedRecordId: message.matchedRecordId ?? null,
    hadAttachment: Boolean(message.hadAttachment),
  };
}

/**
 * A conversation with a real customer only ever grows, and this always
 * returned at most `limit` rows with no way to ask for the ones before
 * them -- once a project's log passed 50 messages, everything older
 * silently became permanently unreachable, with nothing in the response
 * even hinting that more existed (see formatWhatsAppMessageCount's own
 * "N of N (all)" phrasing in whatsappLog.ts, which took the returned
 * array's own length as the true total). `hasMore` -- computed by asking
 * for one extra row past `limit` and checking whether it came back, never
 * a second COUNT(*) query -- tells the caller honestly whether there's
 * anything left to load, instead of it having to guess from
 * `messages.length === limit` (which is also true on the last page,
 * whenever the log's real total is an exact multiple of `limit`).
 *
 * `cursor` is a keyset cursor (an opaque `"<createdAt>|<rowid>"` string
 * taken from `nextCursor` on a previous page), not a row offset -- an
 * earlier version used `OFFSET`, which counts position from the START of
 * the DESC-ordered log on every call. Any message deleted anywhere above
 * the pagination boundary between two "load more" calls (deleteWhatsAppMessage
 * below is reachable by any collaborator, not just whoever is paginating)
 * shifts every later row's position up by one, so the next OFFSET-based
 * call silently skips exactly one message -- never duplicated, never
 * re-fetched by the newest-page poll, permanently unreachable until the
 * whole panel remounts. A keyset cursor pins "everything strictly after
 * this specific row" instead of a row count, so it's unaffected by any
 * number of inserts or deletes elsewhere in the log.
 */
export function listWhatsAppMessages(
  db: ForgeDatabase,
  projectId: string,
  limit = 50,
  cursor?: string | null,
): { messages: WhatsAppMessage[]; hasMore: boolean; nextCursor: string | null } {
  // createdAt has only millisecond precision, so two messages inserted in
  // the same millisecond (a real possibility for a fast reply, or in a
  // test) would tie -- break the tie with rowid so "most recent first"
  // always matches actual insertion order, not an arbitrary one. rowid is
  // SQLite's own hidden per-row integer, not a column on this table (its
  // real primary key, `id`, is a TEXT UUID with no inherent order), so it
  // has to be selected explicitly to build the next page's own cursor.
  const parsedCursor = parseWhatsAppMessagesCursor(cursor);
  const rows = (
    parsedCursor
      ? db
          .prepare(
            "SELECT *, rowid AS _rowid FROM whatsapp_messages WHERE projectId = ? AND (createdAt < ? OR (createdAt = ? AND rowid < ?)) ORDER BY createdAt DESC, rowid DESC LIMIT ?",
          )
          .all(projectId, parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.rowid, limit + 1)
      : db
          .prepare("SELECT *, rowid AS _rowid FROM whatsapp_messages WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?")
          .all(projectId, limit + 1)
  ) as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? `${last.createdAt as string}|${last._rowid as number}` : null;
  return { messages: page.map(rowToMessage), hasMore, nextCursor };
}

/** Rejects anything that isn't a genuine `"<createdAt>|<rowid>"` cursor (missing, malformed, or hand-edited) by treating it as "start from the newest message" -- the same tolerant fallback listWhatsAppMessages' own former `offset` param already had for a non-numeric value. */
function parseWhatsAppMessagesCursor(cursor?: string | null): { createdAt: string; rowid: number } | null {
  if (!cursor) return null;
  const separatorIndex = cursor.lastIndexOf("|");
  if (separatorIndex === -1) return null;
  const createdAt = cursor.slice(0, separatorIndex);
  const rowid = Number(cursor.slice(separatorIndex + 1));
  if (!createdAt || !Number.isInteger(rowid)) return null;
  return { createdAt, rowid };
}

/** Wipes a project's whole WhatsApp message log (both directions) -- the user's own explicit "clear history" action, not something triggered automatically. */
export function clearWhatsAppMessages(db: ForgeDatabase, projectId: string): void {
  db.prepare("DELETE FROM whatsapp_messages WHERE projectId = ?").run(projectId);
}

/**
 * Deletes a single message from a project's own log, rather than only ever
 * offering an all-or-nothing clearWhatsAppMessages -- one junk/test message
 * previously meant wiping the whole log to get rid of it. Scoped to
 * projectId in the same WHERE clause as the id itself (matching
 * deleteRecord's own convention in repository.ts), so a message id that
 * happens to belong to a different project can never be deleted through
 * this call. Throws NotFoundError (mirroring deleteRecord) for an id that
 * doesn't exist in this project's own log, rather than silently no-op'ing.
 */
export function deleteWhatsAppMessage(db: ForgeDatabase, projectId: string, messageId: string): void {
  const result = db.prepare("DELETE FROM whatsapp_messages WHERE projectId = ? AND id = ?").run(projectId, messageId);
  if (result.changes === 0) {
    throw new NotFoundError(`WhatsApp message ${messageId} not found in project ${projectId}`);
  }
}

/**
 * Part of deleteProject's cleanup (projects.ts) -- unlike clearWhatsAppMessages,
 * also drops the connection row itself (phone number, last-connected timestamp),
 * not just the message log, since the project it describes no longer exists.
 * Callers must tear down any *live* socket via WhatsAppWebManager.disconnect
 * first (that in-memory state lives in apps/api, outside this package).
 */
export function deleteWhatsAppData(db: ForgeDatabase, projectId: string): void {
  db.prepare("DELETE FROM whatsapp_connections WHERE projectId = ?").run(projectId);
  db.prepare("DELETE FROM whatsapp_messages WHERE projectId = ?").run(projectId);
}
