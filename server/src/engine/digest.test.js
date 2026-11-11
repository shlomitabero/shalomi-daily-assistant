import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyDigest } from './digest.js';

const ledgerSummary = {
  cashInToday: 100, cashOutToday: 20, netProfitToday: 80, outstandingReceivables: 0, pendingObligations: 0,
  netProfitAllTime: 80, spentSoFar: 0, lossSoFar: 0,
};

test('reports net profit, cash in/out, and action count', () => {
  const digest = buildDailyDigest({ ledgerSummary, actionsToday: [{ id: 1 }, { id: 2 }] });
  assert.match(digest.text, /רווח נטו מאומת היום: \$80\.00/);
  assert.match(digest.text, /נכנס בפועל: \$100\.00/);
  assert.match(digest.text, /יצא בפועל: \$20\.00/);
  assert.match(digest.text, /פעולות שבוצעו: 2/);
});

test('reports a negative net profit with a minus sign, not a fabricated positive', () => {
  const digest = buildDailyDigest({ ledgerSummary: { ...ledgerSummary, netProfitToday: -45.5 } });
  assert.match(digest.text, /רווח נטו מאומת היום: -\$45\.50/);
});

test('reports today\'s autonomous scan count even when it is zero, in the same neutral tone as "בעיות: אין"', () => {
  // Directly answers "is the scanner even running" every single day,
  // without the owner having to open the activity log and count entries
  // themselves - always present (not just on a problem), since a zero
  // here early in the day is a normal reading, not necessarily a fault.
  const digest = buildDailyDigest({ ledgerSummary });
  assert.match(digest.text, /סריקות אוטונומיות היום: 0 \(0 מתוכן יצרו הזדמנות חדשה\)/);
});

test('reports a non-zero autonomous scan count and how many of them actually created an opportunity', () => {
  const digest = buildDailyDigest({ ledgerSummary, scansRanToday: 3, scansSucceededToday: 1 });
  assert.match(digest.text, /סריקות אוטונומיות היום: 3 \(1 מתוכן יצרו הזדמנות חדשה\)/);
});

test('lists failures by their summary when present', () => {
  const digest = buildDailyDigest({ ledgerSummary, failuresToday: [{ summary: 'חיבור לפאדל נכשל' }] });
  assert.match(digest.text, /בעיות: חיבור לפאדל נכשל/);
});

test('reports "no problems" when nothing failed', () => {
  const digest = buildDailyDigest({ ledgerSummary, failuresToday: [] });
  assert.match(digest.text, /בעיות: אין/);
});

test('recommends waiting when there is no good next opportunity, rather than inventing one', () => {
  const digest = buildDailyDigest({ ledgerSummary, topOpportunity: null });
  assert.match(digest.text, /אין הזדמנות מספקת כרגע — להמתין/);
});

test('names the top opportunity when one exists', () => {
  const digest = buildDailyDigest({ ledgerSummary, topOpportunity: { title: 'מדריך דיגיטלי על X' } });
  assert.match(digest.text, /הפעולה המומלצת הבאה: מדריך דיגיטלי על X/);
});

test('calls out an active emergency stop, so "0 actions" is not mistaken for nothing worth doing', () => {
  const digest = buildDailyDigest({ ledgerSummary, emergencyStop: true });
  assert.match(digest.text, /עצירת חירום הייתה פעילה/);
});

test('says nothing about emergency stop when it was not active', () => {
  const digest = buildDailyDigest({ ledgerSummary, emergencyStop: false });
  assert.doesNotMatch(digest.text, /עצירת חירום/);
});

test('calls out research mode, so "0 actions" is not mistaken for nothing worth doing', () => {
  const digest = buildDailyDigest({ ledgerSummary, mode: 'research' });
  assert.match(digest.text, /מצב מחקר בלבד/);
});

test('says nothing about research mode in any other mode', () => {
  const digest = buildDailyDigest({ ledgerSummary, mode: 'auto_limited' });
  assert.doesNotMatch(digest.text, /מצב מחקר/);
});

test('reminds the owner when opportunities are approved but still waiting on their own manual publish click', () => {
  // "approve" mode never auto-publishes even after approval - a separate
  // manual "פרסם מוצר" click is still required, and this is the one
  // digest line that reminds the owner that's still pending.
  const digest = buildDailyDigest({ ledgerSummary, approvedAwaitingPublish: 2 });
  assert.match(digest.text, /2 הזדמנויות מאושרות ומחכות לפרסום בפועל/);
});

test('says nothing about approved-awaiting-publish when there is none', () => {
  const digest = buildDailyDigest({ ledgerSummary, approvedAwaitingPublish: 0 });
  assert.doesNotMatch(digest.text, /מאושרות ומחכות/);
});

test('shows only the emergency stop line, not also the research-mode line, when both are true', () => {
  // The emergency stop already fully explains "0 actions" on its own —
  // showing both would just be noise, not a second, independent reason.
  const digest = buildDailyDigest({ ledgerSummary, emergencyStop: true, mode: 'research' });
  assert.match(digest.text, /עצירת חירום הייתה פעילה/);
  assert.doesNotMatch(digest.text, /מצב מחקר בלבד/);
});

test('warns when spentSoFar reaches 80% of the configured budget', () => {
  // Dashboard.jsx warns in-app at the same 80% threshold - the whole point
  // of a daily digest is reaching the owner without them having to go
  // check, so an owner who only reads the digest needs this warning too.
  const digest = buildDailyDigest({
    ledgerSummary: { ...ledgerSummary, spentSoFar: 17 }, budget: 20, budgetConfigured: true,
  });
  assert.match(digest.text, /מתקרב לתקציב שהוגדר: \$17\.00 מתוך \$20\.00 \(85%\)/);
});

test('says nothing about the budget when spentSoFar is well under 80%', () => {
  const digest = buildDailyDigest({
    ledgerSummary: { ...ledgerSummary, spentSoFar: 2 }, budget: 20, budgetConfigured: true,
  });
  assert.doesNotMatch(digest.text, /מתקרב לתקציב/);
});

test('says nothing about the budget when it was never configured, even with real spend', () => {
  // budget defaults to 0 until the owner explicitly configures one -
  // without checking budgetConfigured, spentSoFar/0 would be Infinity and
  // always warn.
  const digest = buildDailyDigest({
    ledgerSummary: { ...ledgerSummary, spentSoFar: 5 }, budget: 0, budgetConfigured: false,
  });
  assert.doesNotMatch(digest.text, /מתקרב לתקציב/);
});

test('warns when lossSoFar reaches 80% of the configured maxLoss', () => {
  const digest = buildDailyDigest({
    ledgerSummary: { ...ledgerSummary, lossSoFar: 9 }, maxLoss: 10,
  });
  assert.match(digest.text, /מתקרב להפסד המרבי שהוגדר: \$9\.00 מתוך \$10\.00 \(90%\)/);
});

test('says nothing about maxLoss when it is not configured (null)', () => {
  const digest = buildDailyDigest({
    ledgerSummary: { ...ledgerSummary, lossSoFar: 9 }, maxLoss: null,
  });
  assert.doesNotMatch(digest.text, /מתקרב להפסד המרבי/);
});

test('warns that the automatic scan is paused once the pending-draft cap is reached', () => {
  // runAutonomousScan logs this as a 'skipped: N drafts already awaiting
  // review' result, which matches neither actionsToday's success filter
  // nor failuresToday's failed prefix - without this line, a scan quietly
  // skipping itself every cycle had nothing in the digest explaining why
  // nothing new ever shows up.
  const digest = buildDailyDigest({ ledgerSummary, scanPaused: true, pendingDrafts: 5 });
  assert.match(digest.text, /הסריקה האוטומטית מושהית — 5 הזדמנויות ממתינות לסקירה/);
});

test('says nothing about a paused scan when under the pending-draft cap', () => {
  const digest = buildDailyDigest({ ledgerSummary, scanPaused: false, pendingDrafts: 2 });
  assert.doesNotMatch(digest.text, /הסריקה האוטומטית מושהית/);
});

test('warns loudly when a real payment could not be recorded into the ledger', () => {
  // billing.js logs this as 'blocked: <error>' when a real
  // transaction.completed webhook's amount/fee couldn't be parsed - a
  // result that matches neither actionsToday's success filter nor
  // failuresToday's failed prefix, so without this line a real customer's
  // real payment going unrecorded would have no mention anywhere in the
  // one place meant to reach the owner without them having to go check.
  const digest = buildDailyDigest({ ledgerSummary, unrecordedSales: 2 });
  assert.match(digest.text, /2 תשלומים אמיתיים התקבלו אך לא נרשמו ביומן/);
});

test('says nothing about unrecorded sales when there were none', () => {
  const digest = buildDailyDigest({ ledgerSummary, unrecordedSales: 0 });
  assert.doesNotMatch(digest.text, /תשלומים אמיתיים התקבלו/);
});

test('warns about an unset JWT_SECRET, since an owner who only reads the digest would otherwise never learn why they keep getting logged out', () => {
  // Dashboard.jsx already shows this as a banner, but this app's own daily
  // digest exists specifically to reach an owner who never opens the
  // dashboard itself - same reasoning already applied above to the
  // emergency-stop/research-mode/unrecorded-sales lines.
  const digest = buildDailyDigest({ ledgerSummary, jwtSecretConfigured: false });
  assert.match(digest.text, /JWT_SECRET לא מוגדר/);
});

test('says nothing about JWT_SECRET when it is configured, or when the caller never passes the field at all', () => {
  // Defaults to true (no warning), not false - every caller before this
  // field existed never passed it, and must never see a false "not
  // configured" warning just because it omitted a field it doesn't know
  // about.
  const digestConfigured = buildDailyDigest({ ledgerSummary, jwtSecretConfigured: true });
  assert.doesNotMatch(digestConfigured.text, /JWT_SECRET/);

  const digestOmitted = buildDailyDigest({ ledgerSummary });
  assert.doesNotMatch(digestOmitted.text, /JWT_SECRET/);
});

test('warns about failed login attempts today, since a brute-force attempt is exactly the kind of thing an owner who only reads the digest should learn about', () => {
  // routes/auth.js logs a 'login_attempt' entry on a wrong password or a
  // rate-limit block - this is a personal console with a single
  // password, reachable on the open internet, so even a handful of
  // attempts in one day is a real signal worth a daily mention, same
  // reasoning already applied to every other warning above.
  const digest = buildDailyDigest({ ledgerSummary, failedLoginAttemptsToday: 3 });
  assert.match(digest.text, /3 ניסיונות התחברות כושלים היום/);
});

test('says nothing about login attempts when there were none, or when the caller never passes the field at all', () => {
  const digestZero = buildDailyDigest({ ledgerSummary, failedLoginAttemptsToday: 0 });
  assert.doesNotMatch(digestZero.text, /ניסיונות התחברות/);

  const digestOmitted = buildDailyDigest({ ledgerSummary });
  assert.doesNotMatch(digestOmitted.text, /ניסיונות התחברות/);
});
