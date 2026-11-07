// Decides how the global Express error handler should respond to a caught
// error. Previously every error — including a client simply sending
// malformed JSON — was reported as a 500 "internal server error". That's
// both wrong (it's the client's mistake, not a server fault) and
// misleading to whoever is reading the logs trying to find a real bug.
// body-parser already marks its own client-input errors as safe to expose
// (status in the 4xx range, expose: true) — this just honors that instead
// of flattening everything to 500.
export function classifyApiError(err) {
  if (err?.type === 'entity.parse.failed') {
    return { status: 400, message: 'גוף הבקשה אינו JSON תקין' };
  }
  // err.message here is the underlying library's (e.g. body-parser's) own
  // message, in whatever language it wrote it in - genuinely not practical
  // to translate every possible one, same as resultLabel()'s own partial
  // translation elsewhere in this app. Only the fallback below (no message
  // at all) and the generic 500 case are this file's own authored text.
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500 && err.expose) {
    return { status: err.status, message: err.message || 'בקשה לא תקינה' };
  }
  return { status: 500, message: 'שגיאת שרת פנימית' };
}
