/**
 * Minimal Resend (resend.com) client, built on plain `fetch` rather than a
 * dependency -- same choice this codebase already made for Anthropic (see
 * anthropicFetch.ts) and for the exported app's own zero-dependency output.
 * Resend's free tier needs nothing but an API key (no SMTP setup, no
 * domain-verification requirement for its own `onboarding@resend.dev`
 * sender), which is the lowest-friction way for someone self-hosting this
 * app to turn on the email-login-code step.
 *
 * `configured` is `false` whenever RESEND_API_KEY isn't set -- the caller
 * (routes/auth.ts's login route) uses that to skip the whole code step
 * rather than ever calling `send()`, so a deployment that hasn't set up an
 * email provider yet keeps logging in exactly as it always has. Nothing
 * about this file makes the code step mandatory; setting the one
 * environment variable is what turns it on.
 */
/**
 * Round 1013: a real file already sitting on disk under this project's own
 * uploads directory (see routes/projects.ts's createUploadMiddleware), to
 * attach to an outgoing email alongside its subject/body -- resolved by the
 * caller (automations.ts's findTemplateFileAttachment, the exact same
 * resolver fireRule's own WhatsApp branch already uses), never by this
 * sender, which has no concept of a record or a template. `content` is the
 * raw file bytes, base64-encoded -- Resend's own API (see send() below)
 * expects an attachment this way, not as a file path or a URL it would
 * fetch itself.
 */
export interface EmailAttachment {
  filename: string;
  content: string;
}

/**
 * Round 1126: mirrors anthropicFetch.ts's own ANTHROPIC_REQUEST_TIMEOUT_MS
 * and automations.ts's fireWebhookAction, both already given this exact
 * treatment for the identical reason their own doc comments spell out -- an
 * external `fetch` with no timeout can hang forever if the server accepts
 * the TCP connection but never responds. This sender was the one sibling
 * left without it, and the consequence here is worse than either of those
 * two: performSend's caller chains every send through a single
 * deployment-wide `sendQueue` (see its own doc comment below), so a hung
 * performSend call never lets `queuedSend` settle, which means it never
 * lets the queue advance -- silently stalling every future login-code
 * email, password reset, and send_email automation for every project on
 * the whole deployment, with no recovery short of restarting the process.
 */
const RESEND_REQUEST_TIMEOUT_MS = 10_000;

export interface EmailSender {
  readonly configured: boolean;
  send(to: string, subject: string, text: string, attachments?: EmailAttachment[]): Promise<void>;
}

export class ResendEmailSender implements EmailSender {
  private readonly apiKey: string | undefined;
  private readonly fromEmail: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sendSpacingMs: number;
  private readonly requestTimeoutMs: number;
  /**
   * Round 1073: mirrors whatsappWeb.ts's own per-project sendQueue (round
   * 794), for the structurally identical hazard -- EntityPanel.tsx's
   * bulk-update "Apply to N" fires N concurrent PATCH requests, each
   * independently triggering a matching send_email automation rule
   * (deliberately left un-suppressed for bulk-update, same reasoning as
   * WhatsApp's own doc comment), with zero spacing between any of the
   * resulting Resend API calls. Resend's own rate limit is keyed to the
   * API key, not the project, so unlike WhatsApp's per-project Map this is
   * a single global chain -- every send through one ResendEmailSender
   * instance (shared across the whole deployment, see app.ts/server.ts)
   * queues behind the one before it, with the fixed delay appended AFTER
   * each actual network call so the next queued send doesn't go out
   * back-to-back with it.
   */
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(options?: {
    apiKey?: string;
    fromEmail?: string;
    fetchImpl?: typeof fetch;
    sendSpacingMs?: number;
    requestTimeoutMs?: number;
  }) {
    this.apiKey = options?.apiKey ?? process.env.RESEND_API_KEY;
    this.fromEmail = options?.fromEmail ?? process.env.RESEND_FROM_EMAIL ?? "Forge AI <onboarding@resend.dev>";
    this.fetchImpl = options?.fetchImpl ?? fetch;
    // Kept injectable (defaulting to a real 600ms) purely so tests
    // exercising a multi-send sequence don't actually have to wait out
    // real spacing delays, the same reason whatsappWeb.ts's own
    // sendSpacingMs is injectable.
    this.sendSpacingMs = options?.sendSpacingMs ?? 600;
    // Kept injectable for the same reason as sendSpacingMs above -- a test
    // proving the timeout actually fires shouldn't have to wait out a real
    // 10s budget.
    this.requestTimeoutMs = options?.requestTimeoutMs ?? RESEND_REQUEST_TIMEOUT_MS;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async send(to: string, subject: string, text: string, attachments?: EmailAttachment[]): Promise<void> {
    if (!this.apiKey) {
      throw new Error("RESEND_API_KEY is not configured");
    }
    // Validation above runs immediately rather than queueing -- only the
    // actual network call below is serialized, chained off whatever is
    // already queued so a burst of concurrent calls ends up as one
    // deployment-wide sequence instead of each racing Resend's API at once.
    const previousInQueue = this.sendQueue;
    const queuedSend = previousInQueue.then(() => this.performSend(to, subject, text, attachments));
    // Round 1096: unlike whatsappWeb.ts's own performSend (which always
    // resolves to {ok, error?} and never rejects), this performSend throws
    // on a failed Resend call -- so queuedSend.then(() => delay(...))'s
    // fulfillment handler never ran when the previous send failed, and the
    // trailing .catch(() => {}) silently swallowed that rejection with zero
    // delay. The next queued send then fired back-to-back with the
    // failure, which is exactly the Resend 429 case this pacing exists to
    // prevent cascading. Running the SAME delay on both the fulfilled and
    // rejected paths (rather than relying on one shared .then handler)
    // makes this mirror whatsappWeb.ts's actual effective behavior instead
    // of just its surface shape.
    this.sendQueue = queuedSend.then(
      () => this.delay(this.sendSpacingMs),
      () => this.delay(this.sendSpacingMs),
    );
    return queuedSend;
  }

  private async performSend(to: string, subject: string, text: string, attachments?: EmailAttachment[]): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: this.fromEmail,
          to,
          subject,
          text,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Resend API request timed out after ${this.requestTimeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Resend API request failed (${res.status}): ${body}`);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
