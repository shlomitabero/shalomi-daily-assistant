import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests, makeId } from '../db/store.js';
import { generateDailyDigest, catchUpDailyDigestIfMissed } from './digest.js';
import { updateSettings } from './settings.js';

test('generateDailyDigest creates exactly one row for today on first run', () => {
  __resetForTests();
  generateDailyDigest();
  assert.equal(db.digests.all().length, 1);
});

test('generateDailyDigest counts every real autonomous_scan entry logged today, regardless of its outcome', () => {
  // Unlike actionsToday (only 'success' results, across every action
  // type), this count must include a blocked/skipped/failed scan too -
  // the whole point is answering "did the scan even run today", not just
  // "did it succeed".
  __resetForTests();
  const now = new Date().toISOString();
  db.actions_log.insert({ id: makeId('act'), type: 'autonomous_scan', detail: {}, result: 'blocked: source not connected', createdAt: now });
  db.actions_log.insert({ id: makeId('act'), type: 'autonomous_scan', detail: {}, result: 'success', createdAt: now });
  db.actions_log.insert({ id: makeId('act'), type: 'draft_product', detail: {}, result: 'success', createdAt: now }); // a different action type must not be counted here
  const digest = generateDailyDigest();
  assert.match(digest.text, /סריקות אוטונומיות היום: 2 \(1 מתוכן יצרו הזדמנות חדשה\)/);
});

test('generateDailyDigest counts an action logged in the Israel-midnight-to-UTC-midnight gap as today, not yesterday', () => {
  // createdAt is always a plain new Date().toISOString() (UTC). Now that
  // "today" is Israel-local, a naive createdAt.slice(0, 10) comparison
  // would wrongly exclude an action from roughly 2 hours of every day -
  // this is exactly that gap: 23:00 UTC on Jan 1 is already 01:00 Israel
  // time on Jan 2 (winter, UTC+2), so it must count as Jan 2's action, not
  // get excluded as "Jan 1's".
  __resetForTests();
  db.actions_log.insert({
    id: makeId('act'), type: 'draft_product', detail: {}, result: 'success',
    createdAt: '2026-01-01T23:00:00.000Z',
  });
  const digest = generateDailyDigest(new Date('2026-01-01T23:30:00.000Z')); // 01:30 Israel time, Jan 2
  assert.match(digest.text, /פעולות שבוצעו: 1/);
});

test('generateDailyDigest surfaces a real failed action in the real digest text', () => {
  // Every other test that covers the "בעיות" line hand-feeds an already-
  // built failuresToday array straight to engine/digest.js's pure
  // buildDailyDigest() - none of them exercise generateDailyDigest()'s own
  // real actions_log query + .map() that builds that array from a real
  // 'failed'-prefixed entry in the first place.
  __resetForTests();
  db.actions_log.insert({
    id: makeId('act'), type: 'draft_product', detail: { error: 'ANTHROPIC_API_KEY invalid' }, result: 'failed',
    createdAt: new Date().toISOString(),
  });
  const digest = generateDailyDigest();
  // The type itself is now translated ("יצירת טיוטת מוצר", not the raw
  // "draft_product") - detail.error stays as-is either way, same
  // reasoning as resultLabel()'s own partial translation on the client.
  assert.match(digest.text, /בעיות: יצירת טיוטת מוצר: ANTHROPIC_API_KEY invalid/);
  assert.doesNotMatch(digest.text, /draft_product/);
});

test('generateDailyDigest shows a real client-side crash\'s own message, not just the generic word "failed"', () => {
  // routes/actions.js's reportClientError (a real render crash reported by
  // the client's own ErrorBoundary) logs result: 'failed' with detail:
  // {message, path} - unlike every other 'failed' writer in this codebase
  // (draft_product/autonomous_scan/publish_product), which all use
  // detail.error. Falling back straight to a.result (the literal word
  // "failed", this type's own hardcoded result value) discarded the actual
  // crash message - the one piece of information that would tell the owner
  // what actually broke - even though ActivityLog.jsx already shows that
  // same detail.message correctly on the activity log page itself.
  __resetForTests();
  db.actions_log.insert({
    id: makeId('act'), type: 'client_error', detail: { message: 'TypeError: x is undefined', path: '/opportunities' },
    result: 'failed', createdAt: new Date().toISOString(),
  });
  const digest = generateDailyDigest();
  assert.match(digest.text, /בעיות: תקלה במסך: TypeError: x is undefined/);
  assert.doesNotMatch(digest.text, /client_error/);
});

test('generateDailyDigest falls back to the raw result string when a failed action has neither detail.error nor detail.message', () => {
  // A genuine defensive fallback, not currently reachable through any real
  // writer in this codebase (every one of them sets detail.error or
  // detail.message) - kept so a future caller that forgets either still
  // shows something minimally informative instead of the literal
  // string "undefined".
  __resetForTests();
  db.actions_log.insert({
    id: makeId('act'), type: 'draft_product', detail: {}, result: 'failed', createdAt: new Date().toISOString(),
  });
  const digest = generateDailyDigest();
  assert.match(digest.text, /בעיות: יצירת טיוטת מוצר: failed/);
});

test('generateDailyDigest translates a real failed publish_product/autonomous_scan entry\'s type too, not just draft_product/client_error', () => {
  // publish_product fails for real whenever executeGatedAction's own
  // perform() throws (e.g. Paddle unreachable - services/execution.js);
  // autonomous_scan fails for real on a genuine AI-call error
  // (services/autonomousScan.js) - both are real, reachable production
  // paths, not hypothetical ones like the draft_product case above.
  __resetForTests();
  db.actions_log.insert({
    id: makeId('act'), type: 'publish_product', detail: { error: 'Paddle API unreachable' },
    result: 'failed', createdAt: new Date().toISOString(),
  });
  db.actions_log.insert({
    id: makeId('act'), type: 'autonomous_scan', detail: { error: 'timeout' },
    result: 'failed', createdAt: new Date().toISOString(),
  });
  const digest = generateDailyDigest();
  assert.match(digest.text, /בעיות: .*פרסום מוצר: Paddle API unreachable/);
  assert.match(digest.text, /בעיות: .*סריקה אוטונומית: timeout/);
  assert.doesNotMatch(digest.text, /publish_product/);
  assert.doesNotMatch(digest.text, /autonomous_scan: timeout/); // the raw type, not the translated label, must never appear
});

test('generateDailyDigest shows the raw type code for an unrecognized failed action, rather than fabricating a translation', () => {
  __resetForTests();
  db.actions_log.insert({
    id: makeId('act'), type: 'some_future_action', detail: { error: 'broke' },
    result: 'failed', createdAt: new Date().toISOString(),
  });
  const digest = generateDailyDigest();
  assert.match(digest.text, /בעיות: some_future_action: broke/);
});

test('generateDailyDigest warns in the real digest text when real spend is close to the configured budget', () => {
  // This is the real wiring behind engine/digest.js's pure budget-warning
  // logic - settings.budget/budgetConfigured and the ledger's own
  // spentSoFar must actually reach generateDailyDigest() through
  // getSettings()/getLedgerSummary(), not just the hand-fed values the
  // engine-level tests use.
  __resetForTests();
  updateSettings({ budget: 20, budgetConfigured: true });
  db.ledger.insert({ id: makeId('led'), type: 'cost', amount: 17, verified: true, description: 'ai usage', date: '2026-01-01' });
  const digest = generateDailyDigest();
  assert.match(digest.text, /מתקרב לתקציב שהוגדר/);
});

test('generateDailyDigest warns in the real digest text when the real pending-draft count hits the cap', () => {
  // Real wiring behind engine/digest.js's pure scan-paused logic -
  // pendingDraftCount() must actually reach generateDailyDigest(), not
  // just the hand-fed values the engine-level tests use. Demo drafts
  // (productDraft.demo) must never count toward this, same as the scan's
  // own cap check.
  __resetForTests();
  for (let i = 0; i < 5; i += 1) {
    db.opportunities.insert({ id: makeId('opp'), title: `draft ${i}`, status: 'draft', productDraft: { demo: false } });
  }
  const digest = generateDailyDigest();
  assert.match(digest.text, /הסריקה האוטומטית מושהית — 5 הזדמנויות ממתינות לסקירה/);
});

test('generateDailyDigest warns in the real digest text when a real payment failed to record into the ledger today', () => {
  // Real wiring behind engine/digest.js's pure unrecordedSales logic -
  // billing.js's own 'blocked: <error>' result on a sale_confirmed entry
  // must actually reach generateDailyDigest() via a real actions_log
  // query, not just the hand-fed value the engine-level tests use.
  __resetForTests();
  db.actions_log.insert({
    id: makeId('act'), type: 'sale_confirmed', detail: { opportunityId: 'opp_1', error: 'bad amount' },
    result: 'blocked: bad amount', createdAt: new Date().toISOString(),
  });
  const digest = generateDailyDigest();
  assert.match(digest.text, /1 תשלומים אמיתיים התקבלו אך לא נרשמו ביומן/);
});

test('generateDailyDigest keeps warning about an unrecorded sale from days ago, not just today', () => {
  // Unlike actionsToday/failuresToday (a log of what happened today),
  // this is a current-unresolved-problem check - there's no route that
  // ever retries or marks a blocked sale as resolved, so the real money
  // stays unrecorded indefinitely and the warning must not quietly stop
  // just because a new calendar day started.
  __resetForTests();
  db.actions_log.insert({
    id: makeId('act'), type: 'sale_confirmed', detail: { opportunityId: 'opp_1', error: 'bad amount' },
    result: 'blocked: bad amount', createdAt: '2020-01-01T00:00:00.000Z',
  });
  const digest = generateDailyDigest();
  assert.match(digest.text, /1 תשלומים אמיתיים התקבלו אך לא נרשמו ביומן/);
});

test('generateDailyDigest does not warn about a successful sale_confirmed entry', () => {
  __resetForTests();
  db.actions_log.insert({
    id: makeId('act'), type: 'sale_confirmed', detail: { opportunityId: 'opp_1', amount: 10 },
    result: 'success', createdAt: new Date().toISOString(),
  });
  const digest = generateDailyDigest();
  assert.doesNotMatch(digest.text, /תשלומים אמיתיים התקבלו/);
});

test('generating again the same day updates the existing row instead of duplicating it', () => {
  // This is the bug this test guards against: the owner can click
  // "generate now" on the Digests page any number of times a day on top of
  // the 7am cron run, and each click must refresh today's entry, not pile
  // up several near-duplicate rows for the same date.
  __resetForTests();
  const first = generateDailyDigest();
  const second = generateDailyDigest();
  assert.equal(db.digests.all().length, 1);
  assert.equal(second.id, first.id);
});

test('generateDailyDigest reflects a currently-active emergency stop in the text', () => {
  __resetForTests();
  updateSettings({ emergencyStop: true });
  const digest = generateDailyDigest();
  assert.match(digest.text, /עצירת חירום הייתה פעילה/);
});

test('generateDailyDigest warns in the real digest text when JWT_SECRET is genuinely unset in the environment', () => {
  // Same env var, same check as routes/health.js's own jwtSecretConfigured
  // flag - must actually reach buildDailyDigest() via a real
  // process.env.JWT_SECRET read, not just a hand-fed boolean in
  // digest.test.js (engine/), which only proves the text itself is
  // correct once the flag is already false.
  __resetForTests();
  const original = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    const digest = generateDailyDigest();
    assert.match(digest.text, /JWT_SECRET לא מוגדר/);
  } finally {
    if (original !== undefined) process.env.JWT_SECRET = original;
  }
});

test('generateDailyDigest says nothing about JWT_SECRET when it is actually configured', () => {
  __resetForTests();
  const original = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'a-stable-secret';
  try {
    const digest = generateDailyDigest();
    assert.doesNotMatch(digest.text, /JWT_SECRET/);
  } finally {
    if (original !== undefined) process.env.JWT_SECRET = original;
    else delete process.env.JWT_SECRET;
  }
});

test('generateDailyDigest counts today\'s real login_attempt entries and warns in the digest text', () => {
  // Must actually reach generateDailyDigest() via a real actions_log scan
  // of entries routes/auth.js itself would log (a wrong password, a
  // rate-limit block), not just a hand-fed count in digest.test.js
  // (engine/), which only proves the warning text itself is correct once
  // the count is already known.
  __resetForTests();
  const now = new Date().toISOString();
  db.actions_log.insert({ id: makeId('act'), type: 'login_attempt', detail: { ip: '1.2.3.4' }, result: 'failed', createdAt: now });
  db.actions_log.insert({ id: makeId('act'), type: 'login_attempt', detail: { ip: '1.2.3.4' }, result: 'blocked: יותר מדי ניסיונות התחברות שגויים', createdAt: now });
  db.actions_log.insert({ id: makeId('act'), type: 'autonomous_scan', detail: {}, result: 'failed', createdAt: now }); // a different action type must not be counted here
  const digest = generateDailyDigest();
  assert.match(digest.text, /2 ניסיונות התחברות כושלים היום/);
});

test('generateDailyDigest never doubles up a login_attempt entry into the generic "בעיות" line too', () => {
  // failuresToday's own summary format (`${a.type}: ...`) has no
  // translation layer for a.type at all - without excluding login_attempt
  // here, this showed up as raw, repeated English ("login_attempt:
  // failed") right next to the same information already shown correctly
  // in the dedicated warning line above it.
  __resetForTests();
  db.actions_log.insert({ id: makeId('act'), type: 'login_attempt', detail: { ip: '1.2.3.4' }, result: 'failed', createdAt: new Date().toISOString() });
  const digest = generateDailyDigest();
  assert.match(digest.text, /1 ניסיונות התחברות כושלים היום/);
  assert.doesNotMatch(digest.text, /login_attempt/);
  assert.match(digest.text, /בעיות: אין/);
});

test('generateDailyDigest says nothing about login attempts when there were none today', () => {
  __resetForTests();
  const digest = generateDailyDigest();
  assert.doesNotMatch(digest.text, /ניסיונות התחברות/);
});

test('generateDailyDigest ignores a login_attempt entry from a previous day when counting today\'s', () => {
  __resetForTests();
  db.actions_log.insert({ id: makeId('act'), type: 'login_attempt', detail: { ip: '1.2.3.4' }, result: 'failed', createdAt: '2020-01-01T00:00:00.000Z' });
  const digest = generateDailyDigest();
  assert.doesNotMatch(digest.text, /ניסיונות התחברות/);
});

test('generateDailyDigest reflects research mode (the default) in the text', () => {
  __resetForTests();
  const digest = generateDailyDigest();
  assert.match(digest.text, /מצב מחקר בלבד/);
});

test('generateDailyDigest never recommends a demo opportunity as the next action', () => {
  // A demo draft (no ANTHROPIC_API_KEY when it was drafted) can never
  // actually be published for real money - publishing.js refuses it -
  // so it must never be recommended here as if it were a real next step,
  // even if the owner set a revenue estimate on it.
  __resetForTests();
  db.opportunities.insert({
    id: makeId('opp'), status: 'draft', title: '[דמו] מדריך: x',
    revenueEstimate: { low: 100, mid: 200, high: 300 }, costs: {},
    riskLevel: 'medium', dataQuality: 'unknown',
    productDraft: { demo: true, title: '[דמו] מדריך: x' },
  });
  const digest = generateDailyDigest();
  assert.doesNotMatch(digest.text, /דמו/);
  assert.match(digest.text, /אין הזדמנות מספקת כרגע/);
});

test('generateDailyDigest still recommends a real (non-demo) opportunity normally', () => {
  __resetForTests();
  db.opportunities.insert({
    id: makeId('opp'), status: 'draft', title: 'מדריך ניהול זמן',
    revenueEstimate: { low: 100, mid: 200, high: 300 }, costs: {},
    riskLevel: 'medium', dataQuality: 'unknown',
    productDraft: { demo: false, title: 'מדריך ניהול זמן' },
  });
  const digest = generateDailyDigest();
  assert.match(digest.text, /מדריך ניהול זמן/);
});

test('generateDailyDigest never recommends a money-losing opportunity as the next action', () => {
  // ranking.js's risk/quality/capital/speed factors are all positive
  // multipliers - for a net-loss opportunity, a WORSE profile (higher
  // risk, slower, lower data quality) actually scores less negative, not
  // more, so ranked[0] among several losses would be the single worst one
  // by every other measure. If every current draft happens to be a loss
  // (costs exceed a low revenue estimate), recommending it anyway would
  // directly contradict the one promise this digest makes: never
  // recommend losing money.
  __resetForTests();
  db.opportunities.insert({
    id: makeId('opp'), status: 'draft', title: 'מדריך בהפסד',
    revenueEstimate: { low: 1, mid: 2, high: 3 }, costs: { aiUsage: 50 },
    riskLevel: 'high', dataQuality: 'unknown',
    productDraft: { demo: false, title: 'מדריך בהפסד' },
  });
  const digest = generateDailyDigest();
  assert.doesNotMatch(digest.text, /מדריך בהפסד/);
  assert.match(digest.text, /אין הזדמנות מספקת כרגע/);
});

test('generateDailyDigest counts an approved-but-unpublished opportunity as awaiting the owner\'s manual publish click', () => {
  // "approve" mode never auto-publishes even once approved - this is the
  // one digest line reminding the owner a separate "פרסם מוצר" click is
  // still needed for real money to start coming in.
  __resetForTests();
  const opp = db.opportunities.insert({ id: makeId('opp'), status: 'draft', title: 'מדריך', costs: {} });
  db.approvals.insert({
    id: makeId('appr'), opportunityId: opp.id, actionType: 'publish_product', status: 'approved',
    createdAt: new Date().toISOString(), approvedAt: new Date().toISOString(),
  });
  const digest = generateDailyDigest();
  assert.match(digest.text, /1 הזדמנויות מאושרות ומחכות לפרסום בפועל/);
});

test('generateDailyDigest does not count an approval whose opportunity was already published', () => {
  // Once published, the approval has already done its job - counting it
  // again here would make the digest nag about a non-existent backlog.
  __resetForTests();
  const opp = db.opportunities.insert({ id: makeId('opp'), status: 'published', title: 'מדריך', costs: {}, paddlePriceId: 'pri_1', slug: 's' });
  db.approvals.insert({
    id: makeId('appr'), opportunityId: opp.id, actionType: 'publish_product', status: 'approved',
    createdAt: new Date().toISOString(), approvedAt: new Date().toISOString(),
  });
  const digest = generateDailyDigest();
  assert.doesNotMatch(digest.text, /מאושרות ומחכות/);
});

test('generateDailyDigest does not count an approval for a demo draft, which can never actually be published', () => {
  // routes/approvals.js now refuses to even create this approval for a
  // demo draft (no ANTHROPIC_API_KEY when drafted) going forward - this
  // proves a stale one created before that server-side fix existed
  // doesn't keep nagging the owner about something that structurally can
  // never become real money.
  __resetForTests();
  const opp = db.opportunities.insert({
    id: makeId('opp'), status: 'draft', title: 'מדריך דמו', costs: {}, productDraft: { demo: true },
  });
  db.approvals.insert({
    id: makeId('appr'), opportunityId: opp.id, actionType: 'publish_product', status: 'approved',
    createdAt: new Date().toISOString(), approvedAt: new Date().toISOString(),
  });
  const digest = generateDailyDigest();
  assert.doesNotMatch(digest.text, /מאושרות ומחכות/);
});

// Times are explicit UTC (Z) and chosen so that in winter (Israel = UTC+2,
// no DST), '04:59Z' is 06:59 Israel time, '07:00Z' is 09:00 Israel time,
// and '08:00Z' is 10:00 Israel time - the function checks Israel-local
// hours, not UTC, now that server.js's cron is scheduled in Asia/Jerusalem.
test('catchUpDailyDigestIfMissed does nothing before 7am Israel time, leaving the 7am cron tick to handle it normally', () => {
  __resetForTests();
  const result = catchUpDailyDigestIfMissed(new Date('2026-01-01T04:59:00Z'));
  assert.equal(result, null);
  assert.equal(db.digests.all().length, 0);
});

test('catchUpDailyDigestIfMissed correctly accounts for Israel daylight saving (UTC+3 in summer, not a fixed UTC+2 offset)', () => {
  // A naive fixed offset would get this wrong for half the year - July is
  // Israel Daylight Time (UTC+3), so 06:59 Israel time is 03:59Z, not
  // 04:59Z as it would be in winter.
  __resetForTests();
  const result = catchUpDailyDigestIfMissed(new Date('2026-07-01T03:59:00Z')); // 06:59 Israel (summer)
  assert.equal(result, null);
  assert.equal(db.digests.all().length, 0);
});

test('catchUpDailyDigestIfMissed generates today\'s digest when called after 7am Israel time and none exists yet', () => {
  // This is the self-healing case: the process restarted (this app gets
  // redeployed roughly hourly) at, say, 9am Israel time, missing the exact
  // 7:00 cron tick entirely - without this, that day's digest would
  // simply never be generated, with no error or indication anything was
  // skipped.
  __resetForTests();
  const result = catchUpDailyDigestIfMissed(new Date('2026-01-01T07:00:00Z'));
  assert.ok(result);
  assert.equal(db.digests.all().length, 1);
});

test('catchUpDailyDigestIfMissed does nothing when today\'s digest already exists, even after 7am Israel time', () => {
  // Must never silently overwrite a digest the owner already generated
  // today (via the normal cron tick or their own manual "generate now"
  // click) just because the server happened to restart again later.
  __resetForTests();
  const first = generateDailyDigest();
  const result = catchUpDailyDigestIfMissed(new Date('2026-01-01T08:00:00Z'));
  assert.equal(result, null);
  assert.equal(db.digests.all().length, 1);
  assert.equal(db.digests.get(first.id).generatedAt, first.generatedAt);
});

test('a digest generated for a different day does not get merged with today\'s', () => {
  __resetForTests();
  const today = generateDailyDigest();
  db.digests.insert({ id: 'dig_yesterday', date: '2000-01-01', text: 'old', generatedAt: '2000-01-01T00:00:00.000Z' });
  const updatedToday = generateDailyDigest();
  assert.equal(db.digests.all().length, 2);
  assert.equal(updatedToday.id, today.id);
});
