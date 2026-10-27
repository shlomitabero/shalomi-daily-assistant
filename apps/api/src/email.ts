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

export interface EmailSender {
  readonly configured: boolean;
  send(to: string, subject: string, text: string, attachments?: EmailAttachment[]): Promise<void>;
}

export class ResendEmailSender implements EmailSender {
  private readonly apiKey: string | undefined;
  private readonly fromEmail: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sendSpacingMs: number;
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

  constructor(options?: { apiKey?: string; fromEmail?: string; fetchImpl?: typeof fetch; sendSpacingMs?: number }) {
    this.apiKey = options?.apiKey ?? process.env.RESEND_API_KEY;
    this.fromEmail = options?.fromEmail ?? process.env.RESEND_FROM_EMAIL ?? "Forge AI <onboarding@resend.dev>";
    this.fetchImpl = options?.fetchImpl ?? fetch;
    // Kept injectable (defaulting to a real 600ms) purely so tests
    // exercising a multi-send sequence don't actually have to wait out
    // real spacing delays, the same reason whatsappWeb.ts's own
    // sendSpacingMs is injectable.
    this.sendSpacingMs = options?.sendSpacingMs ?? 600;
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
    this.sendQueue = queuedSend.then(() => this.delay(this.sendSpacingMs)).catch(() => {});
    return queuedSend;
  }

  private async performSend(to: string, subject: string, text: string, attachments?: EmailAttachment[]): Promise<void> {
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: this.fromEmail,
        to,
        subject,
        text,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Resend API request failed (${res.status}): ${body}`);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
