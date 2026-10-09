import { rm } from "node:fs/promises";
import path from "node:path";
import {
  getProject,
  getWhatsAppConnection,
  insertWhatsAppMessage,
  recordWhatsAppConnected,
  recordWhatsAppDisconnected,
  type ForgeDatabase,
} from "@forge/db";
import { findMatchingRecord, normalizePhone } from "./whatsapp.js";

/**
 * Manages a real WhatsApp Web connection per project -- the same "link a
 * device" flow as WhatsApp Web/Desktop, done with the `@whiskeysockets/
 * baileys` library instead of Meta's official Business API, per direct
 * user request (she does not want a dependency on setting up a Meta
 * Business account). This is an unofficial method: it works by
 * impersonating a genuine WhatsApp Web client, which is against WhatsApp's
 * own terms of service and carries a real (if usually small) risk that a
 * number showing automated behavior gets flagged or temporarily blocked --
 * disclosed to the user up front, and shown in the UI.
 *
 * One live socket is held in memory per connected project. A real process
 * restart (a Render redeploy, a crash) always drops every live socket --
 * there is no way around that short of a fully custom, DB-backed Baileys
 * auth-state store, which is future work, not built here. What IS
 * persisted to disk (`sessionsRootDir/<projectId>/`) is Baileys' own
 * multi-file auth-state credentials, so a same-process reconnect (e.g. a
 * transient network drop) does not require re-scanning the QR code; a real
 * redeploy still will, exactly like unplugging and replugging a linked
 * device. `recordWhatsAppConnected`/`recordWhatsAppDisconnected` in the DB
 * only remember the last known phone number for display -- the live
 * connected/disconnected status always comes from this manager's own
 * memory, never from that DB row, since the DB row can't know a process
 * restart happened.
 *
 * No automatic reconnect-after-drop is implemented in this v1: a closed
 * connection simply becomes "disconnected", and the project owner clicks
 * "Connect" again to retry. A production-grade version would reconnect
 * automatically on a transient close and only give up on an explicit
 * logout -- a known, real limitation, not a silently skipped corner.
 */

export type WhatsAppConnectionStatus = "disconnected" | "connecting" | "qr" | "connected";

export interface WhatsAppConnectionState {
  status: WhatsAppConnectionStatus;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  error: string | null;
}

export interface WhatsAppSendResult {
  ok: boolean;
  error?: string;
}

/** The slice of Baileys' real `WASocket` this manager actually uses -- kept as its own interface so tests can inject a fake without touching the real network. */
export interface WhatsAppSocket {
  ev: {
    on(event: "creds.update", listener: () => void): void;
    on(event: "connection.update", listener: (update: BaileysConnectionUpdate) => void): void;
    on(event: "messages.upsert", listener: (upsert: BaileysMessagesUpsert) => void): void;
  };
  user?: { id: string } | null;
  sendMessage(jid: string, content: { text: string }): Promise<unknown>;
  logout(): Promise<void>;
}

export interface BaileysConnectionUpdate {
  connection?: "connecting" | "open" | "close";
  qr?: string;
  lastDisconnect?: { error?: { message?: string; output?: { statusCode?: number } } };
}

export interface BaileysIncomingMessage {
  key: { remoteJid?: string; fromMe?: boolean };
  message?: { conversation?: string; extendedTextMessage?: { text?: string } };
}

export interface BaileysMessagesUpsert {
  type: string;
  messages: BaileysIncomingMessage[];
}

/** WhatsApp/Baileys' own documented status code for "this device was logged out (unlinked) from the phone", as opposed to a merely transient network close. */
const LOGGED_OUT_STATUS_CODE = 401;

/**
 * User-facing explanations for a non-logged-out close (see
 * handleConnectionUpdate's own close branch). Baileys gives a fresh QR
 * code a limited number of refreshes before giving up and closing the
 * socket with a "timedOut"/"connectionLost" status (408) if nobody scans
 * it in time -- previously indistinguishable from any other disconnect,
 * surfacing as a bare "disconnected" state with no explanation at all.
 */
const QR_EXPIRED_MESSAGE = "The QR code expired before it was scanned. Click Connect to get a new one.";
const CONNECTION_LOST_MESSAGE = "The WhatsApp connection was lost. Click Connect to reconnect.";

async function defaultCreateSocket(authDir: string): Promise<{ sock: WhatsAppSocket; saveCreds: () => Promise<void> }> {
  const { default: makeWASocket, useMultiFileAuthState } = await import("@whiskeysockets/baileys");
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });
  return { sock: sock as unknown as WhatsAppSocket, saveCreds };
}

async function defaultQrToDataUrl(qr: string): Promise<string> {
  const { toDataURL } = await import("qrcode");
  return toDataURL(qr);
}

interface ManagedSession {
  sock: WhatsAppSocket | null;
  status: WhatsAppConnectionStatus;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  error: string | null;
}

export interface WhatsAppWebManagerOptions {
  db: ForgeDatabase;
  sessionsRootDir: string;
  createSocket?: (authDir: string) => Promise<{ sock: WhatsAppSocket; saveCreds: () => Promise<void> }>;
  qrToDataUrl?: (qr: string) => Promise<string>;
  /** Kept injectable so tests can control its exact timing, the same way createSocket is -- see cleanupAuthDir. */
  removeAuthDir?: (authDir: string) => Promise<void>;
}

export class WhatsAppWebManager {
  private readonly db: ForgeDatabase;
  private readonly sessionsRootDir: string;
  private readonly createSocket: (authDir: string) => Promise<{ sock: WhatsAppSocket; saveCreds: () => Promise<void> }>;
  private readonly qrToDataUrl: (qr: string) => Promise<string>;
  private readonly removeAuthDir: (authDir: string) => Promise<void>;
  private readonly sessions = new Map<string, ManagedSession>();
  /** Tracks an in-flight authDir cleanup per project -- see cleanupAuthDir and its use in connect(). */
  private readonly pendingCleanup = new Map<string, Promise<void>>();
  /** Tracks an in-flight connect() attempt's own createSocket() call per project -- see connect() and its use in cleanupAuthDir. */
  private readonly pendingConnect = new Map<string, Promise<void>>();

  constructor(options: WhatsAppWebManagerOptions) {
    this.db = options.db;
    this.sessionsRootDir = options.sessionsRootDir;
    this.createSocket = options.createSocket ?? defaultCreateSocket;
    this.qrToDataUrl = options.qrToDataUrl ?? defaultQrToDataUrl;
    this.removeAuthDir = options.removeAuthDir ?? ((dir) => rm(dir, { recursive: true, force: true }));
  }

  private authDirFor(projectId: string): string {
    return path.join(this.sessionsRootDir, projectId);
  }

  /**
   * disconnect() and handleConnectionUpdate's "close" branch both delete
   * the session from the map synchronously, then remove the auth dir from
   * disk asynchronously -- the deletion is what makes getStatus() report
   * "disconnected" right away, which is worth keeping immediate. But that
   * leaves a real window where a concurrent connect() sees no session and
   * starts useMultiFileAuthState() on the very directory this removal is
   * still deleting files from. Tracking the removal here lets connect()
   * wait for it to finish first, instead of racing it.
   *
   * The opposite race also needs guarding: a disconnect() that lands
   * while a connect() for the same project is still inside its OWN
   * createSocket() call (useMultiFileAuthState reads/writes the auth dir
   * as part of that call, before connect() ever gets a chance to react)
   * must not start removing that directory out from under it. Waiting on
   * pendingConnect here, before touching the disk, closes that window --
   * done inside cleanupAuthDir rather than inside disconnect() itself so
   * disconnect()'s own synchronous session.delete() above (and thus
   * getStatus() reporting "disconnected") is never delayed by how long
   * a *different* connect() attempt happens to take.
   */
  private cleanupAuthDir(projectId: string): Promise<void> {
    const pendingConnect = this.pendingConnect.get(projectId);
    const task = (pendingConnect ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.removeAuthDir(this.authDirFor(projectId)))
      .catch(() => {});
    this.pendingCleanup.set(projectId, task);
    void task.finally(() => {
      if (this.pendingCleanup.get(projectId) === task) this.pendingCleanup.delete(projectId);
    });
    return task;
  }

  getStatus(projectId: string): WhatsAppConnectionState {
    const session = this.sessions.get(projectId);
    if (session) {
      return { status: session.status, qrDataUrl: session.qrDataUrl, phoneNumber: session.phoneNumber, error: session.error };
    }
    const stored = getWhatsAppConnection(this.db, projectId);
    return { status: "disconnected", qrDataUrl: null, phoneNumber: stored?.phoneNumber ?? null, error: null };
  }

  async connect(projectId: string): Promise<WhatsAppConnectionState> {
    const existing = this.sessions.get(projectId);
    if (existing && existing.status !== "disconnected") {
      return this.getStatus(projectId);
    }

    // A disconnect (or a logged-out close) may still be deleting this
    // project's auth dir from disk -- wait for it so createSocket()
    // below doesn't read/write into a directory being removed underneath it.
    const pendingCleanup = this.pendingCleanup.get(projectId);
    if (pendingCleanup) await pendingCleanup;

    const session: ManagedSession = { sock: null, status: "connecting", qrDataUrl: null, phoneNumber: null, error: null };
    this.sessions.set(projectId, session);

    // Tracked in pendingConnect for the exact duration of createSocket()
    // (and its own event-handler wiring just after) -- see cleanupAuthDir's
    // own comment for why a disconnect() landing in this window must wait
    // for it before touching the auth dir on disk.
    const task = this.runConnectAttempt(projectId, session);
    this.pendingConnect.set(projectId, task);
    void task.finally(() => {
      if (this.pendingConnect.get(projectId) === task) this.pendingConnect.delete(projectId);
    });
    await task;
    return this.getStatus(projectId);
  }

  private async runConnectAttempt(projectId: string, session: ManagedSession): Promise<void> {
    try {
      const { sock, saveCreds } = await this.createSocket(this.authDirFor(projectId));
      if (this.sessions.get(projectId) !== session) {
        // A concurrent disconnect() (or a fresh connect()) replaced this
        // session while createSocket() was still in flight, before this
        // socket's event handlers were ever wired up. Nothing else in this
        // manager holds a reference to it, so it would otherwise stay
        // linked to the real WhatsApp account indefinitely with no code
        // path left able to close it -- log it out immediately instead.
        await sock.logout().catch(() => {});
        return;
      }
      session.sock = sock;
      // Every handler below is wired with a real `.catch`, not a bare
      // `void` -- a `void asyncFn()` discards the returned promise
      // without attaching a rejection handler, so a thrown error inside
      // (a DB write hitting SQLITE_BUSY, a disk error saving credentials)
      // would become an unhandled promise rejection and crash the whole
      // Node process, taking down every project's connection, not just
      // this one. `session` is captured directly (not re-looked-up by
      // projectId) so a stale event from a socket this manager has
      // already replaced or torn down can recognize itself as stale --
      // see the identity check at the top of handleConnectionUpdate/
      // handleIncomingMessages.
      sock.ev.on("creds.update", () => {
        saveCreds().catch((err) => this.logHandlerError(projectId, err));
      });
      sock.ev.on("connection.update", (update) => {
        this.handleConnectionUpdate(projectId, session, update).catch((err) => this.logHandlerError(projectId, err));
      });
      sock.ev.on("messages.upsert", (upsert) => {
        this.handleIncomingMessages(projectId, session, upsert).catch((err) => this.logHandlerError(projectId, err));
      });
    } catch (err) {
      session.status = "disconnected";
      session.error = (err as Error).message;
    }
  }

  /**
   * Never lets a handler's rejection escape as an unhandled promise
   * rejection (which would crash the process); records the failure on
   * the session (if it's still the live one) so the UI can surface it
   * instead of silently stalling.
   */
  private logHandlerError(projectId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`WhatsApp handler error for project ${projectId}:`, message);
    const session = this.sessions.get(projectId);
    if (session) session.error = message;
  }

  private async handleConnectionUpdate(projectId: string, session: ManagedSession, update: BaileysConnectionUpdate): Promise<void> {
    // This event was registered on a specific socket; if the manager has
    // since replaced or torn down that socket's session (a disconnect
    // followed by a fresh connect, for instance), this event arrived
    // after the fact and must not touch whatever is in the map now.
    if (this.sessions.get(projectId) !== session) return;

    if (update.qr) {
      session.status = "qr";
      try {
        session.qrDataUrl = await this.qrToDataUrl(update.qr);
      } catch (err) {
        session.error = (err as Error).message;
      }
    }

    if (update.connection === "open") {
      session.status = "connected";
      session.qrDataUrl = null;
      session.error = null;
      const rawId = session.sock?.user?.id ?? "";
      const phoneNumber = rawId.split(":")[0].split("@")[0] || null;
      session.phoneNumber = phoneNumber;
      if (phoneNumber) recordWhatsAppConnected(this.db, projectId, phoneNumber);
    }

    if (update.connection === "close") {
      const loggedOut = update.lastDisconnect?.error?.output?.statusCode === LOGGED_OUT_STATUS_CODE;
      if (loggedOut) {
        this.sessions.delete(projectId);
        recordWhatsAppDisconnected(this.db, projectId);
        await this.cleanupAuthDir(projectId);
      } else {
        // Keep the session in the map (the same thing runConnectAttempt's
        // own catch block already does on a connect failure) instead of
        // deleting it the way the logged-out branch above does --
        // getStatus() unconditionally returns error: null the instant a
        // project has no live session (see its own comment), so deleting
        // it here would silently discard whatever explanation is set
        // below. That was the actual bug: a QR code timing out before
        // being scanned closed with a non-401 status, fell into this
        // branch, got deleted, and reverted straight to a bare
        // "disconnected" with zero explanation. The next connect() call
        // still works fine against a session left in "disconnected"
        // status -- see connect()'s own `existing.status !== "disconnected"`
        // check -- it just overwrites this one with a fresh session object.
        const wasAwaitingQr = session.status === "qr" || session.status === "connecting";
        session.status = "disconnected";
        session.qrDataUrl = null;
        session.error = wasAwaitingQr ? QR_EXPIRED_MESSAGE : CONNECTION_LOST_MESSAGE;
        recordWhatsAppDisconnected(this.db, projectId);
      }
    }
  }

  private async handleIncomingMessages(projectId: string, session: ManagedSession, upsert: BaileysMessagesUpsert): Promise<void> {
    if (this.sessions.get(projectId) !== session) return;
    if (upsert.type !== "notify") return;
    const project = getProject(this.db, projectId);
    if (!project || project.status !== "built") return;

    for (const msg of upsert.messages) {
      if (msg.key.fromMe) continue;
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.endsWith("@g.us")) continue;
      const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text;
      if (!text) continue;
      const from = remoteJid.split("@")[0];

      const match = findMatchingRecord(this.db, project, from);
      insertWhatsAppMessage(this.db, {
        projectId,
        direction: "in",
        fromNumber: from,
        toNumber: session?.phoneNumber ?? "",
        body: text,
        matchedEntityName: match?.entityName ?? null,
        matchedRecordId: match?.recordId ?? null,
        matchedLabel: match?.label ?? null,
        status: "received",
      });
    }
  }

  async disconnect(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (session?.sock) {
      await session.sock.logout().catch(() => {});
    }
    this.sessions.delete(projectId);
    recordWhatsAppDisconnected(this.db, projectId);
    // Not awaited: cleanupAuthDir itself now waits for any in-flight
    // connect() (pendingConnect) before touching the auth dir on disk --
    // see its own comment -- and that can take as long as createSocket()
    // does. disconnect() must stay as fast as it already is above (the
    // synchronous session.delete() is what makes getStatus() report
    // "disconnected" right away); it was never meant to block its own
    // caller on how long the actual directory removal takes, any more
    // than it already didn't before this round.
    void this.cleanupAuthDir(projectId);
  }

  async sendMessage(projectId: string, to: string, body: string): Promise<WhatsAppSendResult> {
    const session = this.sessions.get(projectId);
    if (!session || session.status !== "connected" || !session.sock) {
      return { ok: false, error: "not_connected" };
    }
    // The route's own schema only checks `to` is a non-empty string, not
    // that it contains an actual phone number -- normalizePhone strips
    // every non-digit character, so a value with no digits at all (e.g.
    // "abc") would otherwise silently become an empty JID ("@s.whatsapp.net")
    // handed straight to Baileys instead of failing with a clear reason.
    const phone = normalizePhone(to);
    if (!phone) {
      return { ok: false, error: "invalid_phone_number" };
    }
    // `to` may be stored/typed in local format with no country code at all
    // (e.g. "050-123-4567" -> "501234567") -- this app's own seed data and
    // Hebrew templates store phone fields exactly this way, and EntityPanel's
    // "Send WhatsApp" row action feeds a record's raw field value straight
    // through, so this is the common path, not a rare edge case. Silently
    // building a JID from it anyway would address a wrong/nonexistent
    // number while still reporting success -- exactly the quiet-wrong-
    // success this function's own "abc" check above already refuses to
    // allow. There's no reliable way to *infer* the missing country code
    // for an arbitrary contact (unlike findMatchingRecord's suffix
    // comparison in whatsapp.ts, which only ever compares the same number
    // against itself in two formats), so refuse honestly instead of
    // guessing: a real international number including its country code is
    // never shorter than the connected account's own number for a
    // plausible same-country contact.
    const ownNumber = session.phoneNumber ? normalizePhone(session.phoneNumber) : "";
    if (ownNumber && phone.length < ownNumber.length) {
      return { ok: false, error: "missing_country_code" };
    }
    try {
      const jid = `${phone}@s.whatsapp.net`;
      await session.sock.sendMessage(jid, { text: body });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
