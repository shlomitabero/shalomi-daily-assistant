// A handful of baseline response headers nothing in this app was setting -
// no new dependency needed for just these three. This app handles a real
// owner password and real Paddle checkouts, so:
// - X-Frame-Options: DENY stops another site from framing any page here
//   (e.g. the login screen) to trick the owner into typing their password
//   into what looks like a different page (clickjacking). Paddle's own
//   checkout overlay is served from paddle.com inside its own iframe, not
//   by framing this app, so this never affects a real checkout.
// - X-Content-Type-Options: nosniff stops a browser from guessing a
//   response's content type from its body instead of trusting the
//   Content-Type header this app actually sent.
// - Referrer-Policy: no-referrer keeps this app's own URLs (which can
//   include a real Paddle transaction id in a query string, on the
//   product guide route) out of the Referer header sent to any external
//   resource a page happens to load.
export function securityHeaders(req, res, next) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}
