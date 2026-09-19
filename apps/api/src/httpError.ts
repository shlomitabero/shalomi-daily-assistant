import type { ZodError } from "zod";

/**
 * `code` is a stable, finite identifier (e.g. "BUILD_REQUIRED") the client
 * uses to show a translated message instead of this raw English `message`
 * (server errors were never localized -- see docs/roadmap.md). `message`
 * stays the detailed, English, developer-facing text and is still sent to
 * the client as a fallback for any code the client's dictionary doesn't
 * recognize yet.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

/** ZodError.message is a JSON dump of every issue, not readable text -- join the actual issue messages instead, matching HttpError's own "message" contract of a plain, readable fallback string. */
export function formatValidationError(error: ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}
