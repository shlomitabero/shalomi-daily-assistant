import type { Entity, EntityRecord, Project } from "@forge/shared";
import { listRecords, type ForgeDatabase, type WhatsAppSettings } from "@forge/db";

/**
 * Real integration with Meta's WhatsApp Business Platform (Cloud API) --
 * the only officially supported way for a third-party app to send or
 * receive WhatsApp messages. Every function here is written against
 * Meta's actual, documented request/response shapes (Graph API send
 * endpoint, the GET webhook-verification handshake, the POST incoming-
 * message payload), not a guess -- but none of it can be end-to-end
 * verified against Meta's real servers from this environment, since that
 * requires a project owner's own Meta-issued phone number id and access
 * token. `sendWhatsAppMessage` takes an injectable `fetchImpl` so tests
 * can exercise the real request-building logic without a live network
 * call, and this is documented rather than hidden -- see docs/roadmap.md.
 */

const GRAPH_API_VERSION = "v21.0";

export interface SendResult {
  ok: boolean;
  /** Meta's own message id (wamid...) on success. */
  messageId?: string;
  /** Human-readable failure reason on failure -- Meta's own error message when available. */
  error?: string;
}

/**
 * Sends a real WhatsApp text message via the Cloud API. `to` should be a
 * full international phone number with no leading "+" (Meta's own
 * convention, e.g. "972501234567").
 */
export async function sendWhatsAppMessage(
  settings: WhatsAppSettings,
  to: string,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  try {
    const res = await fetchImpl(`https://graph.facebook.com/${GRAPH_API_VERSION}/${settings.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      messages?: { id: string }[];
      error?: { message?: string };
    };
    if (!res.ok) {
      return { ok: false, error: data.error?.message ?? `WhatsApp API request failed (${res.status})` };
    }
    return { ok: true, messageId: data.messages?.[0]?.id };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Meta's webhook-verification handshake: when the project owner pastes
 * the webhook URL and verify token into Meta's console, Meta immediately
 * sends a GET request with these three query params to confirm the
 * endpoint is real and controlled by them. Responding with the raw
 * `hub.challenge` value (as plain text, not JSON) completes setup;
 * anything else must be rejected, or a stranger who knows the URL could
 * hijack the subscription.
 */
export function verifyWebhookChallenge(
  settings: WhatsAppSettings | undefined,
  query: Record<string, unknown>,
): string | null {
  if (!settings) return null;
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode !== "subscribe" || token !== settings.verifyToken || typeof challenge !== "string") {
    return null;
  }
  return challenge;
}

export interface IncomingWhatsAppMessage {
  from: string;
  to: string;
  body: string;
  messageId: string;
  contactName: string | null;
}

/**
 * Parses a real Cloud API webhook delivery (the documented
 * `entry[].changes[].value.messages[]` shape) into a flat list of
 * incoming text messages. Non-text message types (images, location,
 * status updates, ...) are present in the same payload shape but are
 * skipped here -- only real text bodies can be logged and matched to a
 * record, and pretending to handle media without downloading/storing it
 * would be its own kind of fabrication.
 */
export function parseIncomingWebhookPayload(payload: unknown): IncomingWhatsAppMessage[] {
  const results: IncomingWhatsAppMessage[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return results;

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      if (!value) continue;
      const metadata = value.metadata as { display_phone_number?: string; phone_number_id?: string } | undefined;
      const to = metadata?.display_phone_number ?? "";
      const contacts = (value.contacts as { wa_id?: string; profile?: { name?: string } }[] | undefined) ?? [];
      const messages = (value.messages as Record<string, unknown>[] | undefined) ?? [];
      for (const message of messages) {
        if (message.type !== "text") continue;
        const text = (message.text as { body?: string } | undefined)?.body;
        const from = message.from as string | undefined;
        const id = message.id as string | undefined;
        if (!text || !from || !id) continue;
        const contact = contacts.find((c) => c.wa_id === from);
        results.push({ from, to, body: text, messageId: id, contactName: contact?.profile?.name ?? null });
      }
    }
  }
  return results;
}

const PHONE_FIELD_NAME = "phone";

/**
 * Keeps only digits, then strips a single leading trunk "0" -- the local
 * dialing prefix most countries' national format uses (e.g. Israeli
 * "050-123-4567") is *replaced* by the country code in international
 * format ("972501234567"), not merely prefixed with it, so a naive
 * digit-only comparison would never match a real number entered in local
 * format against the same number as WhatsApp delivers it internationally.
 */
function normalizePhone(value: string): string {
  return value.replace(/\D/g, "").replace(/^0/, "");
}

export interface MatchedRecord {
  entityName: string;
  entityLabel: string;
  recordId: number;
  label: string;
}

const DISPLAY_FIELD_NAME_HINTS = ["name", "title"];

function pickDisplayField(entity: Entity) {
  const named = entity.fields.find((f) => DISPLAY_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
  if (named) return named;
  const firstText = entity.fields.find((f) => f.type === "text");
  return firstText ?? entity.fields[0] ?? null;
}

function recordDisplayLabel(entity: Entity, record: EntityRecord): string {
  const field = pickDisplayField(entity);
  const value = field ? record[field.name] : undefined;
  if (value === null || value === undefined || value === "") return `#${record.id}`;
  return String(value);
}

/**
 * Best-effort match: looks across every entity that has a field literally
 * named "phone" (the domain library's own convention -- see
 * spec-engine/domainEntities.ts) for a record whose phone number
 * normalizes to the same digits as the incoming message's sender.
 * International prefixes (a stored "050-..." vs. an incoming
 * "972 50 ..." from the same real number) are reconciled by comparing
 * digit suffixes, not exact equality -- a genuine, common mismatch this
 * app's own seed data and real phone entry habits both produce. Returns
 * null rather than guessing when nothing matches, which is the normal
 * case for a brand-new contact.
 */
export function findMatchingRecord(db: ForgeDatabase, project: Project, fromNumber: string): MatchedRecord | null {
  const normalizedFrom = normalizePhone(fromNumber);
  if (!normalizedFrom) return null;

  for (const entity of project.spec.entities) {
    const phoneField = entity.fields.find((f) => f.name === PHONE_FIELD_NAME);
    if (!phoneField) continue;
    const records = listRecords(db, project.id, entity);
    for (const record of records) {
      const raw = record[phoneField.name];
      if (typeof raw !== "string" || !raw) continue;
      const normalizedStored = normalizePhone(raw);
      if (!normalizedStored) continue;
      const shorter = normalizedStored.length <= normalizedFrom.length ? normalizedStored : normalizedFrom;
      const longer = normalizedStored.length <= normalizedFrom.length ? normalizedFrom : normalizedStored;
      if (shorter.length >= 7 && longer.endsWith(shorter)) {
        return {
          entityName: entity.name,
          entityLabel: entity.label ?? entity.name,
          recordId: record.id as number,
          label: recordDisplayLabel(entity, record),
        };
      }
    }
  }
  return null;
}
