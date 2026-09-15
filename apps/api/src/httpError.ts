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
