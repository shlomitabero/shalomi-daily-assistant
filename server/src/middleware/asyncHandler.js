// Express 4 does not catch a rejected promise from an async route handler —
// an exception thrown inside one becomes an unhandled promise rejection,
// which by default crashes the entire Node process (not just that one
// request), taking the whole app down for every user over a single
// transient failure. Wrapping every async handler in this forwards the
// rejection to next(err) instead, so the app's existing error-handling
// middleware catches it like any other error.
export function asyncHandler(fn) {
  return (req, res, next) => {
    // fn(...) itself can throw synchronously, before there's any promise to
    // attach .catch to — Promise.resolve(fn(...)) alone would let that throw
    // escape uncaught, so the call itself needs its own try/catch too.
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (err) {
      next(err);
    }
  };
}
