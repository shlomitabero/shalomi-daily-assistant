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
export interface EmailSender {
  readonly configured: boolean;
  send(to: string, subject: string, text: string): Promise<void>;
}

export class ResendEmailSender implements EmailSender {
  private readonly apiKey: string | undefined;
  private readonly fromEmail: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options?: { apiKey?: string; fromEmail?: string; fetchImpl?: typeof fetch }) {
    this.apiKey = options?.apiKey ?? process.env.RESEND_API_KEY;
    this.fromEmail = options?.fromEmail ?? process.env.RESEND_FROM_EMAIL ?? "Forge AI <onboarding@resend.dev>";
    this.fetchImpl = options?.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    if (!this.apiKey) {
      throw new Error("RESEND_API_KEY is not configured");
    }
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.fromEmail, to, subject, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Resend API request failed (${res.status}): ${body}`);
    }
  }
}
