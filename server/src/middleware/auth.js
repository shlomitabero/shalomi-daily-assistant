import { verifyOwnerToken } from '../engine/auth.js';

// Guards nearly every route in this app - a missing/expired/invalid token
// here was the one 401 whose body stayed raw English ('not authenticated')
// while every other error in this codebase is Hebrew. engine/auth.js's own
// resolveJwtSecret() documents a real, expected way this gets hit: a
// missing JWT_SECRET silently invalidates every existing token on every
// single redeploy, so a page the owner already has open can 401 here
// mid-session, not just on a stale bookmark. client/src/api.js's own 401
// handling already dispatches auth:expired and redirects to /login purely
// off the status code, never this message, so translating it changes
// nothing about that flow - it only stops the raw English text from
// flashing in a page's own error line in the gap before that redirect
// takes effect (several simultaneous requests on one page load, e.g.
// Dashboard's five parallel calls, can each set their own error state
// before the redirect-triggering state update actually re-renders).
export function requireOwner(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || !verifyOwnerToken(token)) return res.status(401).json({ error: 'לא מחובר — יש להתחבר מחדש' });
  next();
}
