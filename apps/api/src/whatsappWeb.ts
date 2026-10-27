import { readFile, rm } from "node:fs/promises";
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

/**
 * A real file already sitting on disk under this project's own uploads
 * directory (see routes/projects.ts's createUploadMiddleware), to attach
 * to an outgoing WhatsApp message alongside its text -- resolved by the
 * caller (automations.ts's findTemplateFileAttachment), never by this
 * manager, which has no concept of a record or a template.
 */
export interface WhatsAppAttachment {
  filePath: string;
  fileName: string;
  mimeType: string;
}

/** The slice of Baileys' real `WASocket` this manager actually uses -- kept as its own interface so tests can inject a fake without touching the real network. */
export interface WhatsAppSocket {
  ev: {
    on(event: "creds.update", listener: () => void): void;
    on(event: "connection.update", listener: (update: BaileysConnectionUpdate) => void): void;
    on(event: "messages.upsert", listener: (upsert: BaileysMessagesUpsert) => void): void;
  };
  user?: { id: string } | null;
  sendMessage(
    jid: string,
    content:
      | { text: string }
      | { document: Buffer; mimetype: string; fileName: string; caption?: string }
      | { image: Buffer; mimetype: string; caption?: string }
      | { video: Buffer; mimetype: string; caption?: string }
      | { audio: Buffer; mimetype: string; ptt?: boolean },
  ): Promise<unknown>;
  logout(): Promise<void>;
}

export interface BaileysConnectionUpdate {
  connection?: "connecting" | "open" | "close";
  qr?: string;
  lastDisconnect?: { error?: { message?: string; output?: { statusCode?: number } } };
}

export interface BaileysIncomingMessage {
  key: { remoteJid?: string; fromMe?: boolean };
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: { caption?: string };
    videoMessage?: { caption?: string };
    documentMessage?: { caption?: string; fileName?: string };
    audioMessage?: { ptt?: boolean };
    stickerMessage?: Record<string, never>;
    locationMessage?: { name?: string; address?: string };
    contactMessage?: { displayName?: string };
    contactsArrayMessage?: { displayName?: string; contacts?: { displayName?: string }[] };
    pollCreationMessage?: { name?: string };
    pollCreationMessageV2?: { name?: string };
    pollCreationMessageV3?: { name?: string };
    pollCreationMessageV5?: { name?: string };
    reactionMessage?: { text?: string };
    liveLocationMessage?: { caption?: string };
    viewOnceMessage?: { message?: BaileysIncomingMessage["message"] };
    viewOnceMessageV2?: { message?: BaileysIncomingMessage["message"] };
  };
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

/**
 * Baileys shapes a photo/video/voice-note/document/sticker completely
 * differently from a plain text message: conversation/extendedTextMessage
 * is never populated for any of them, only a type-specific key
 * (imageMessage/videoMessage/audioMessage/documentMessage/stickerMessage),
 * each with its own optional `caption` -- audio and stickers have none at
 * all, since WhatsApp itself doesn't support a caption on either. Before
 * this, handleIncomingMessages' plain text lookup returned undefined for
 * every one of these, and the whole message was silently dropped via
 * `continue` with no row ever inserted -- a customer texting in a photo of
 * a damaged product, or a voice note placing an order, with no caption,
 * never showed up in the WhatsApp log at all, with nothing telling the
 * business owner a message had even arrived. A bracketed, plain-English
 * placeholder (matching this file's own QR_EXPIRED_MESSAGE/
 * CONNECTION_LOST_MESSAGE convention for backend-origin text -- never
 * localized, since this isn't a UI-chrome string with an error code the
 * client can translate) at minimum tells the owner something arrived and
 * what kind, even though the actual photo/voice note/document content
 * itself still isn't retrievable from here. Deliberately scoped to just
 * these five common kinds at the time -- an unrecognized message shape (a
 * shared contact card, a location pin, a poll, etc.) still returns null
 * and is skipped exactly as before, rather than guessing at an unverified
 * shape.
 *
 * Round 1035: location pins and contact cards are no longer unverified --
 * confirmed directly against Baileys' own shipped protobuf type
 * definitions (node_modules/@whiskeysockets/baileys/WAProto/index.d.ts,
 * proto.Message.ILocationMessage/IContactMessage) to be exactly as stable
 * a shape as the five already trusted above. A real-estate/courier/
 * logistics lead sharing a pickup/delivery location, or a contact card for
 * a referral, is an everyday one-tap WhatsApp action, not an edge case --
 * and was previously dropped with zero trace: no log row, no notification,
 * no automation trigger, nothing telling the business owner anything had
 * even arrived.
 *
 * Round 1051: polls join the same list, for the same reason. Confirmed
 * against proto.Message.IPollCreationMessage: the poll's own question
 * (`name`) and answer options are plaintext in the protobuf -- only a
 * *vote* (pollUpdateMessage.vote.encPayload) is encrypted, so this needs no
 * decryption any more than location/contact did. WhatsApp populates one of
 * four near-identical fields depending on client version
 * (pollCreationMessage/V2/V3/V5); V4 is a genuinely different shape
 * (IFutureProofMessage) and stays out of scope, same spirit as every other
 * still-unrecognized message kind below. A customer asking "which day works
 * -- Mon/Tue/Wed?" via WhatsApp's own one-tap poll UI instead of typing it
 * is ordinary usage, not an edge case, and was previously silently dropped
 * exactly like an unfixed location pin.
 *
 * Round 1088: an emoji reaction (long-press a message, tap an emoji) joins
 * the same list. Confirmed against proto.Message.IReactionMessage: `text`
 * (the reacted emoji, or an empty string when a reaction is removed) is
 * plaintext in this protobuf, same as every message type already handled
 * above -- the separate, genuinely-encrypted `encReactionMessage`
 * (IEncReactionMessage) is a different field this file still doesn't
 * populate or touch. A business sending "reply 👍 to confirm your order"
 * and the customer just reacting instead of typing is an everyday
 * one-tap WhatsApp action, not an edge case, and was previously silently
 * dropped exactly like an unfixed poll.
 *
 * Round 1106: sharing TWO OR MORE contacts in one tap (WhatsApp's own
 * "select multiple -> Send" flow) populates a distinct field,
 * contactsArrayMessage, never contactMessage -- round 1035 only ever
 * checked the latter, so this sibling was missed entirely and fell
 * through to the same silent drop as every other still-unrecognized
 * shape. Confirmed against proto.Message.IContactsArrayMessage: its
 * `displayName`/`contacts` are plaintext in the protobuf, the same
 * stable shape round 1035 already verified for the singular
 * contactMessage case.
 *
 * Round 1121: a "View once" photo/video -- WhatsApp's own one-tap toggle on
 * the camera UI, ordinary usage (e.g. a payment-proof photo), not an edge
 * case -- wraps the real imageMessage/videoMessage one level down inside
 * viewOnceMessage/viewOnceMessageV2 (proto.Message.IFutureProofMessage's
 * own `message` field, a full nested IMessage) instead of populating
 * imageMessage/videoMessage directly, so it fell through to the same
 * silent drop as every other still-unrecognized shape. A live-location
 * share (WhatsApp's continuous-sharing mode, proto.Message.
 * ILiveLocationMessage) is a distinct field from the already-handled
 * locationMessage (a single pinned location) and was missed the same way.
 * Both confirmed directly against Baileys' own shipped protobuf types.
 */
function describeIncomingMessage(message: BaileysIncomingMessage["message"]): string | null {
  if (!message) return null;
  const text = message.conversation ?? message.extendedTextMessage?.text;
  if (text) return text;
  if (message.imageMessage) return message.imageMessage.caption ? `[Photo] ${message.imageMessage.caption}` : "[Photo]";
  if (message.videoMessage) return message.videoMessage.caption ? `[Video] ${message.videoMessage.caption}` : "[Video]";
  if (message.documentMessage) {
    const name = message.documentMessage.fileName;
    const label = `[Document${name ? `: ${name}` : ""}]`;
    return message.documentMessage.caption ? `${label} ${message.documentMessage.caption}` : label;
  }
  if (message.audioMessage) return message.audioMessage.ptt ? "[Voice note]" : "[Audio]";
  if (message.stickerMessage) return "[Sticker]";
  if (message.locationMessage) {
    const detail = message.locationMessage.name || message.locationMessage.address;
    return detail ? `[Location] ${detail}` : "[Location]";
  }
  if (message.liveLocationMessage) {
    return message.liveLocationMessage.caption ? `[Live location] ${message.liveLocationMessage.caption}` : "[Live location]";
  }
  if (message.contactMessage) {
    const name = message.contactMessage.displayName;
    return name ? `[Contact: ${name}]` : "[Contact]";
  }
  if (message.contactsArrayMessage) {
    const count = message.contactsArrayMessage.contacts?.length ?? 0;
    return count > 0 ? `[${count} Contacts]` : "[Contacts]";
  }
  const poll =
    message.pollCreationMessage ?? message.pollCreationMessageV2 ?? message.pollCreationMessageV3 ?? message.pollCreationMessageV5;
  if (poll) return poll.name ? `[Poll] ${poll.name}` : "[Poll]";
  if (message.reactionMessage) return message.reactionMessage.text ? `[Reaction] ${message.reactionMessage.text}` : "[Reaction removed]";
  const viewOnceInner = message.viewOnceMessageV2?.message ?? message.viewOnceMessage?.message;
  if (viewOnceInner) {
    const inner = describeIncomingMessage(viewOnceInner);
    return inner ? `[View once] ${inner}` : "[View once]";
  }
  return null;
}

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
  /**
   * Fixed delay (ms) sendMessage waits after each send before letting the
   * next queued send for the same project go out -- see the sendQueue
   * field's own doc comment. Kept injectable (defaulting to a real
   * 1200ms) purely so tests exercising a multi-send sequence don't
   * actually have to wait out real spacing delays, the same reason
   * createSocket/removeAuthDir are injectable above.
   */
  sendSpacingMs?: number;
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
  /**
   * Round 794: chains every sendMessage() call for the same project onto
   * the one before it, with a fixed delay inserted after each actual
   * send -- the same Promise-chain-per-project-id idiom pendingConnect/
   * pendingCleanup above already use, just for ordering sends instead of
   * connect/cleanup. Without this, a legitimate workflow that fires many
   * concurrent sendMessage() calls for one project at once (EntityPanel.
   * tsx's bulk-update "Apply to N" firing N concurrent PATCH requests,
   * each independently triggering a matching automation rule's WhatsApp
   * send -- deliberately left un-suppressed for bulk-update, unlike CSV
   * import, since notifying real customers on a status change is the
   * actual point of that feature) sent all of them through the one
   * shared Baileys socket in the same instant: exactly the "automated
   * behavior" burst pattern this file's own module doc comment above
   * already warns can get a real WhatsApp number flagged or temporarily
   * blocked. Flagged as a known, real gap in round 744's survey and
   * deliberately left for a dedicated round rather than rushed; this is
   * that round.
   */
  private readonly sendQueue = new Map<string, Promise<void>>();
  private readonly sendSpacingMs: number;

  constructor(options: WhatsAppWebManagerOptions) {
    this.db = options.db;
    this.sessionsRootDir = options.sessionsRootDir;
    this.createSocket = options.createSocket ?? defaultCreateSocket;
    this.qrToDataUrl = options.qrToDataUrl ?? defaultQrToDataUrl;
    this.removeAuthDir = options.removeAuthDir ?? ((dir) => rm(dir, { recursive: true, force: true }));
    this.sendSpacingMs = options.sendSpacingMs ?? 1200;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

    // Round 990: `existing` above was read and checked BEFORE this await --
    // a real suspension point -- and never re-checked after resuming. Two
    // connect() calls landing in the same disconnect-cleanup window (two
    // collaborators both clicking Connect near-simultaneously shortly after
    // a disconnect, or one impatiently double-clicking across two tabs --
    // the frontend's own per-tab disable state only ever prevents the FIRST
    // of those) both read `existing` as undefined, both pass the guard
    // above, and both await this exact same pendingCleanup promise. Without
    // re-checking here, BOTH would then build their own fresh session and
    // call runConnectAttempt -> createSocket() -> useMultiFileAuthState()
    // concurrently against the identical auth directory on disk, before
    // runConnectAttempt's own identity check (below) ever gets a chance to
    // react -- two real Baileys sockets racing to read/write the same
    // credential files. Checking pendingConnect (rather than just
    // `sessions`) is what actually closes the gap: whichever caller's
    // continuation resumes first runs everything from here through this
    // function's own `pendingConnect.set` below with no further await in
    // between, so that registration is always visible to every other
    // caller's continuation before any of them gets a turn to run --
    // ordinary single-threaded JS semantics, not a new assumption.
    const alreadyConnecting = this.pendingConnect.get(projectId);
    if (alreadyConnecting) {
      await alreadyConnecting;
      return this.getStatus(projectId);
    }
    const nowExisting = this.sessions.get(projectId);
    if (nowExisting && nowExisting.status !== "disconnected") {
      return this.getStatus(projectId);
    }

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
      // "@g.us" is a group chat; "@broadcast" is WhatsApp's own Status/Story
      // updates ("status@broadcast") and broadcast lists -- Baileys relays
      // a connected account's own contacts' Status posts through this exact
      // same messages.upsert/"notify" stream, with fromMe: false, so nothing
      // else here incidentally excludes them. A plain-text Status update
      // carries the identical conversation/extendedTextMessage shape as a
      // real chat message, so it isn't caught by the text-presence check
      // below either -- without this, every Status post from the owner's
      // own contacts (far more frequent than real incoming messages for a
      // typical small business) gets logged as an unmatched incoming
      // message from a customer literally named "status", permanent noise
      // in the one panel this feature exists to keep reliable.
      if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid.endsWith("@broadcast")) continue;
      const text = describeIncomingMessage(msg.message);
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

  async sendMessage(projectId: string, to: string, body: string, attachment?: WhatsAppAttachment): Promise<WhatsAppSendResult> {
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
    // guessing. Counting the *raw* string's leading zeros (before
    // normalizePhone's own stripping) distinguishes the two real cases its
    // own doc comment already establishes, without comparing digit counts
    // against any other number (which breaks across countries -- a US
    // number is 11 digits total, shorter than an Israeli number's 12, so
    // comparing lengths against the connected account's own number wrongly
    // flagged every legitimate cross-country send): exactly one leading
    // zero is the local trunk prefix (country code missing), two is the
    // "00" international access code (already fully qualified), and zero
    // is either already-international or untaggable either way.
    //
    // Three or more leading zeros is neither of those two legitimate
    // shapes -- it's the same "00" access-code typo this check already
    // guards against for the 1-zero case, just with the destination's own
    // local trunk zero left in too (e.g. "00" + "0501234567" = 3 leading
    // zeros). normalizePhone strips the *entire* run of leading zeros
    // regardless of count, so this would otherwise silently resolve to the
    // exact same country-code-missing number the 1-zero branch exists to
    // reject, just reached via a different leading-zero count.
    const rawDigits = to.replace(/\D/g, "");
    const leadingZeros = rawDigits.length - rawDigits.replace(/^0+/, "").length;
    if (leadingZeros === 1 || leadingZeros >= 3) {
      return { ok: false, error: "missing_country_code" };
    }

    // Everything above is pure validation with no socket interaction, so it
    // runs immediately rather than queueing -- only the actual Baileys send
    // below is serialized per project (see sendQueue's own doc comment).
    // Chained off whatever is already queued for this project, so a burst
    // of concurrent calls ends up as one project-wide sequence instead of
    // each racing the socket at once; the fixed delay is appended AFTER
    // each send so the next queued one doesn't go out back-to-back with it.
    const previousInQueue = this.sendQueue.get(projectId) ?? Promise.resolve();
    const queuedSend = previousInQueue.then(() => this.performSend(projectId, phone, body, attachment));
    const nextInQueue = queuedSend.then(() => this.delay(this.sendSpacingMs)).catch(() => {});
    this.sendQueue.set(projectId, nextInQueue);
    void nextInQueue.finally(() => {
      if (this.sendQueue.get(projectId) === nextInQueue) this.sendQueue.delete(projectId);
    });
    return queuedSend;
  }

  /**
   * The actual Baileys send, run one at a time per project through
   * sendQueue above -- re-reads the live session fresh (rather than
   * reusing sendMessage's own earlier lookup) since a queued call can sit
   * behind others for a while, and the connection may have dropped by the
   * time its own turn actually comes up.
   */
  private async performSend(projectId: string, phone: string, body: string, attachment?: WhatsAppAttachment): Promise<WhatsAppSendResult> {
    const session = this.sessions.get(projectId);
    if (!session || session.status !== "connected" || !session.sock) {
      return { ok: false, error: "not_connected" };
    }
    try {
      const jid = `${phone}@s.whatsapp.net`;
      // Resolved lazily, inside the try block, so a disk error (the
      // referenced upload was deleted/replaced since the automation rule
      // last ran, or the project's uploads directory isn't readable for
      // some other reason) degrades to a plain text send with the file
      // simply missing -- caught separately via .catch(() => null), not by
      // this function's own outer catch, so it never turns into a reported
      // send FAILURE the way a genuine Baileys/network error below does.
      const fileBuffer = attachment ? await readFile(attachment.filePath).catch(() => null) : null;
      if (fileBuffer && attachment) {
        // Round 965: a photo/video attachment sent as a generic "document"
        // renders in the recipient's real WhatsApp client as a plain
        // download/file icon with the filename, not an inline, chat-
        // rendered thumbnail/preview -- a real degradation for exactly the
        // use case a "file" field attached to an automation was built for
        // (shipping photos, menu images, damage reports). Baileys itself
        // (the real library this interface's own doc comment says this is
        // "the slice of" -- see WhatsAppSocket above) natively supports
        // `{ image: ... }`/`{ video: ... }` content for this; only a
        // mimeType this app doesn't recognize as either still falls back to
        // the generic document shape, which is the correct choice for an
        // actual document (PDF, spreadsheet, etc.).
        if (attachment.mimeType.startsWith("image/")) {
          await session.sock.sendMessage(jid, { image: fileBuffer, mimetype: attachment.mimeType, caption: body });
        } else if (attachment.mimeType.startsWith("video/")) {
          await session.sock.sendMessage(jid, { video: fileBuffer, mimetype: attachment.mimeType, caption: body });
        } else if (attachment.mimeType.startsWith("audio/")) {
          // Round 966: same degradation round 965 fixed for image/video,
          // but Baileys' own real audio content shape (confirmed directly
          // against node_modules/@whiskeysockets/baileys's own type
          // definitions, Types/Message.d.ts's AnyMediaMessageContent) has
          // no `caption` field at all, unlike image/video/document --
          // WhatsApp itself has no "voice note with a caption" concept in
          // its own real UI either, so this isn't a gap this app's code
          // could paper over even by passing one through. messageTemplate
          // is always non-empty (CreateAutomationRuleSchema's own
          // `.min(1)`), so silently dropping it the way naively copying
          // the image/video branch's shape would (an untyped field Baileys
          // simply never serializes) would silently discard a caption the
          // user explicitly wrote, every single time. Sending it as its
          // own text message first, immediately before the now-playable
          // (not generic-document) audio attachment, preserves it in full
          // instead.
          await session.sock.sendMessage(jid, { text: body });
          await session.sock.sendMessage(jid, { audio: fileBuffer, mimetype: attachment.mimeType, ptt: false });
        } else {
          await session.sock.sendMessage(jid, { document: fileBuffer, mimetype: attachment.mimeType, fileName: attachment.fileName, caption: body });
        }
      } else {
        await session.sock.sendMessage(jid, { text: body });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
