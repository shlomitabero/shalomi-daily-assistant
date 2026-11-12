import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMoney, actionTypeLabel, resultLabel, riskLevelLabel, sideLabel,
  opportunityStatusLabel, sourceLabel, missingFieldLabel, reasonLabel,
  autonomousScanSummary, saleConfirmedSummary, refreshAllFailuresSummary,
  latestSourceCheckTimestamp, pendingPublishApprovals,
} from './labels.js';

// This is the client's one module with zero React/DOM dependency - pure
// functions the server-side build already proves it's safe to run under
// plain Node, the same way every server/src/engine/*.js test does. Until
// now the entire client had no automated test coverage at all (every
// verification here was a manual Playwright pass, never a repeatable
// assertion) - this is the first and most natural place to close that gap,
// since it needs no new tooling (jsdom, React Testing Library) to do.

test('formatMoney puts the minus sign before the dollar sign for a negative value', () => {
  // A plain `${n.toFixed(2)}` would put it after ("$-45.50") - a real,
  // reachable case since revenueEstimate.low and net profit can both go
  // negative.
  assert.equal(formatMoney(-45.5), '-$45.50');
});

test('formatMoney formats a positive value with no sign', () => {
  assert.equal(formatMoney(12.3), '$12.30');
});

test('formatMoney formats zero without a minus sign', () => {
  assert.equal(formatMoney(0), '$0.00');
});

test('formatMoney respects a custom decimals argument', () => {
  assert.equal(formatMoney(12.345, 0), '$12');
  assert.equal(formatMoney(-9, 0), '-$9');
});

test('actionTypeLabel translates a known action type to Hebrew', () => {
  assert.equal(actionTypeLabel('publish_product'), 'פרסום מוצר');
});

test('actionTypeLabel falls back to the raw code for an unknown type, rather than fabricating a translation', () => {
  assert.equal(actionTypeLabel('some_future_type'), 'some_future_type');
});

test('actionTypeLabel translates a login_attempt entry (a brute-force attempt against the owner\'s own login)', () => {
  assert.equal(actionTypeLabel('login_attempt'), 'ניסיון התחברות');
});

test('resultLabel translates just the leading word and keeps the free-text detail as-is', () => {
  assert.equal(resultLabel('blocked: תקציב לא מוגדר'), 'נחסם: תקציב לא מוגדר');
});

test('resultLabel translates a bare result with no detail', () => {
  assert.equal(resultLabel('success'), 'הצלחה');
});

test('resultLabel returns the raw string unchanged for an unrecognized leading word', () => {
  assert.equal(resultLabel('weird: something'), 'weird: something');
});

test('resultLabel returns non-string input unchanged instead of crashing', () => {
  assert.equal(resultLabel(null), null);
  assert.equal(resultLabel(undefined), undefined);
});

test('riskLevelLabel translates all three known levels', () => {
  assert.equal(riskLevelLabel('low'), 'נמוכה');
  assert.equal(riskLevelLabel('medium'), 'בינונית');
  assert.equal(riskLevelLabel('high'), 'גבוהה');
});

test('riskLevelLabel falls back to the raw value for an unknown level', () => {
  assert.equal(riskLevelLabel('extreme'), 'extreme');
});

test('sideLabel translates both paper-trading sides', () => {
  assert.equal(sideLabel('long'), 'לונג');
  assert.equal(sideLabel('short'), 'שורט');
});

test('sideLabel falls back to the raw value for an unknown side', () => {
  assert.equal(sideLabel('buy'), 'buy');
});

test('opportunityStatusLabel translates all three known statuses', () => {
  assert.equal(opportunityStatusLabel('draft'), 'טיוטה');
  assert.equal(opportunityStatusLabel('published'), 'פורסם');
  assert.equal(opportunityStatusLabel('rejected'), 'נדחה');
});

test('opportunityStatusLabel falls back to the raw value for an unknown status', () => {
  assert.equal(opportunityStatusLabel('archived'), 'archived');
});

test('sourceLabel translates a known source id to its Hebrew name', () => {
  assert.equal(sourceLabel('ai_digital_products'), 'מוצרים דיגיטליים מבוססי AI');
});

test('sourceLabel falls back to the raw id for an unknown source', () => {
  assert.equal(sourceLabel('some_future_source'), 'some_future_source');
});

test('missingFieldLabel translates the one known plain field', () => {
  assert.match(missingFieldLabel('revenueEstimate'), /הערכת הכנסה/);
});

test('missingFieldLabel translates a known "cost:" field to its Hebrew cost name, still marked as missing', () => {
  // Every "cost:" field reaching this function came from feasibility.js's
  // own "missing" list - the "לא ידוע עדיין" suffix is the whole point
  // (describing a field that's missing, not just naming it), so it
  // applies to a known cost key exactly as much as an unknown one.
  assert.equal(missingFieldLabel('cost:aiUsage'), 'עלות AI — לא ידוע עדיין');
  assert.equal(missingFieldLabel('cost:paymentProcessing'), 'עמלת סליקה — לא ידוע עדיין');
});

test('missingFieldLabel shows the raw key itself for an unrecognized cost field, instead of fabricating a translation', () => {
  assert.equal(missingFieldLabel('cost:futureCost'), 'futureCost — לא ידוע עדיין');
});

test('missingFieldLabel falls back to the raw field for anything else unrecognized', () => {
  assert.equal(missingFieldLabel('someOtherField'), 'someOtherField');
});

test('reasonLabel translates both known stale-approval reasons', () => {
  assert.match(reasonLabel('price changed after approval'), /המחיר השתנה/);
  assert.match(reasonLabel('opportunity was rejected'), /ההזדמנות נדחתה/);
});

test('reasonLabel falls back to the raw reason for anything unrecognized', () => {
  assert.equal(reasonLabel('some new reason'), 'some new reason');
});

test('autonomousScanSummary reports no scan has run yet when given a null action', () => {
  assert.equal(autonomousScanSummary(null), 'עדיין לא רצה סריקה אוטונומית.');
});

test('autonomousScanSummary distinguishes an auto-published success from a draft awaiting review', () => {
  assert.match(autonomousScanSummary({ result: 'success', detail: { published: true } }), /פורסמה אוטומטית/);
  assert.match(autonomousScanSummary({ result: 'success', detail: { published: false } }), /מחכה לסקירה/);
});

test('autonomousScanSummary explains the source-not-connected block in plain Hebrew', () => {
  assert.match(autonomousScanSummary({ result: 'blocked: source not connected' }), /לא מחובר/);
});

test('autonomousScanSummary builds its pending-drafts sentence from detail.pendingDrafts, not the raw English result text', () => {
  // The raw result string's own free-text detail ('N drafts already
  // awaiting review') is English - this must never leak straight into the
  // Hebrew sentence.
  const summary = autonomousScanSummary({ result: 'skipped: 5 drafts already awaiting review', detail: { pendingDrafts: 5 } });
  assert.match(summary, /5 הזדמנויות/);
  assert.doesNotMatch(summary, /drafts already awaiting/);
});

test('autonomousScanSummary shows a "?" placeholder rather than crashing when the pending-drafts cap result is missing detail.pendingDrafts', () => {
  const summary = autonomousScanSummary({ result: 'skipped: 5 drafts already awaiting review', detail: {} });
  assert.match(summary, /— \? הזדמנויות/);
});

test('autonomousScanSummary distinguishes a real concurrency conflict from the pending-drafts cap, not a nonsensical "?" count', () => {
  // services/opportunities.js's own lock logs this exact same 'skipped:'
  // prefix as the pending-drafts-cap case just below - before this branch
  // existed, a scan that lost that lock to the manual "צור טיוטת מוצר"
  // form (a real, already-tested production path - see
  // autonomousScan.test.js's own "backs off cleanly... when the manual
  // route is mid-request") fell into the generic pending-drafts branch
  // instead, which reads detail.pendingDrafts - absent here, since this
  // case's own detail is {} - producing "הסריקה הושהתה — ? הזדמנויות כבר
  // ממתינות לסקירה שלך", wrongly blaming a review backlog for what was
  // actually just a one-off timing conflict.
  const summary = autonomousScanSummary({ result: 'skipped: another draft creation was in progress', detail: {} });
  assert.match(summary, /נדחתה זמנית/);
  assert.doesNotMatch(summary, /\?/);
});

test('autonomousScanSummary gives a clean Hebrew message on failure, not the raw detail.error', () => {
  const summary = autonomousScanSummary({ result: 'failed', detail: { error: 'ECONNRESET' } });
  assert.match(summary, /בדוק את לוגי השרת/);
  assert.doesNotMatch(summary, /ECONNRESET/);
});

test('autonomousScanSummary falls back to resultLabel for any other result shape', () => {
  // This previously passed { result: 'success' } - which hits the very
  // first branch above, not this fallback at all, so this line was
  // actually uncovered despite the test's own name (node's own coverage
  // tool flagged it directly, after the Sources/Dashboard coverage work
  // earlier this session). A result autonomousScan.js never actually logs
  // today (every real 'blocked:' case there is specifically "source not
  // connected") but the same defensive-fallback pattern this app already
  // tests elsewhere (actionTypeLabel/riskLevelLabel/sourceLabel all have
  // their own "falls back for an unknown value" test) applies here too.
  assert.equal(autonomousScanSummary({ result: 'blocked: something unexpected', detail: {} }), 'נחסם: something unexpected');
});

test('saleConfirmedSummary reports a verified sale', () => {
  assert.equal(saleConfirmedSummary({ result: 'success' }), 'מכירה אומתה בפועל.');
});

test('saleConfirmedSummary explains a sandbox transaction without implying real revenue', () => {
  assert.match(saleConfirmedSummary({ result: 'skipped: sandbox transaction, not recorded as real revenue' }), /עסקת בדיקה/);
});

test('saleConfirmedSummary gives a clean Hebrew message for a malformed-amount blocked sale, not the raw engine error text', () => {
  // billing.js always includes opportunityId in detail for this specific
  // case (it's only ever logged inside the branch that already confirmed
  // opportunityId is present) - this is the real shape, not a hand-picked
  // one, and it's what distinguishes this case from the missing-
  // opportunityId one right below, which has no opportunityId in detail
  // at all.
  const summary = saleConfirmedSummary({
    result: 'blocked: transaction total is not a valid number: "N/A"',
    detail: { opportunityId: 'opp_1', transactionId: 'txn_1' },
  });
  assert.match(summary, /שגיאה בעיבוד/);
  assert.doesNotMatch(summary, /N\/A/);
});

test('saleConfirmedSummary shows billing.js\'s own specific Hebrew reason for a sale blocked by a missing opportunityId, not a generic one', () => {
  // This is a real, reachable production case (a checkout-overlay bug,
  // Paddle dropping the field, or a transaction unrelated to this app's
  // own product) - distinct from the malformed-amount case above, and
  // billing.js's own result string here is already a complete, correct
  // Hebrew sentence with no raw English to hide. Showing the generic
  // "data processing error" message for it instead would be actively
  // wrong: there's no malformed amount in this case at all.
  const reason = 'תשלום אמיתי התקבל אך לא ניתן לזהות לאיזו הזדמנות הוא משתייך — custom_data.opportunityId חסר בעסקה';
  const summary = saleConfirmedSummary({ result: `blocked: ${reason}`, detail: { transactionId: 'txn_1' } });
  assert.equal(summary, reason);
});

test('saleConfirmedSummary falls back to resultLabel for any other result', () => {
  assert.equal(saleConfirmedSummary({ result: 'failed' }), 'נכשל');
});

test('refreshAllFailuresSummary returns null when nothing failed, so the caller skips setError() entirely', () => {
  assert.equal(refreshAllFailuresSummary([]), null);
});

test('refreshAllFailuresSummary names the one symbol and its own real error when exactly one failed', () => {
  assert.equal(
    refreshAllFailuresSummary([{ symbol: 'AAPL', message: 'הבקשה למקור נתוני השוק לא קיבלה מענה בזמן' }]),
    'AAPL: הבקשה למקור נתוני השוק לא קיבלה מענה בזמן'
  );
});

test('refreshAllFailuresSummary lists every failed symbol, not just the last one, when several fail in the same run', () => {
  // This is the actual bug this function fixes - Financial.jsx's old
  // inline setError() call inside the loop overwrote earlier failures
  // with each new one, so only AAPL's message (the last of three) ever
  // reached the owner, as if MSFT and GOOG had refreshed successfully.
  const summary = refreshAllFailuresSummary([
    { symbol: 'MSFT', message: 'timeout' },
    { symbol: 'GOOG', message: 'status 502' },
    { symbol: 'AAPL', message: 'timeout' },
  ]);
  assert.equal(summary, '3 סימבולים לא התרעננו: MSFT, GOOG, AAPL');
});

test('latestSourceCheckTimestamp returns null for an empty list', () => {
  assert.equal(latestSourceCheckTimestamp([]), null);
});

test('latestSourceCheckTimestamp returns the one timestamp when there is only one source', () => {
  assert.equal(
    latestSourceCheckTimestamp([{ lastCheckedAt: '2026-01-01T00:00:00.000Z' }]),
    '2026-01-01T00:00:00.000Z'
  );
});

test('latestSourceCheckTimestamp picks the most recent timestamp regardless of list order', () => {
  // syncSources() stamps every source together on the same call in
  // practice, so these are normally identical - but this makes no such
  // assumption, and the order sources come back in is never guaranteed.
  const sources = [
    { lastCheckedAt: '2026-01-01T00:00:00.000Z' },
    { lastCheckedAt: '2026-03-01T00:00:00.000Z' },
    { lastCheckedAt: '2026-02-01T00:00:00.000Z' },
  ];
  assert.equal(latestSourceCheckTimestamp(sources), '2026-03-01T00:00:00.000Z');
});

test('pendingPublishApprovals keeps an approval whose opportunity is still a real (non-demo) draft', () => {
  const approvals = [{ id: 'appr_1', opportunityId: 'opp_1' }];
  const opportunities = [{ id: 'opp_1', status: 'draft', productDraft: { demo: false } }];
  assert.equal(pendingPublishApprovals(approvals, opportunities).length, 1);
});

test('pendingPublishApprovals drops an approval whose opportunity has already been published', () => {
  const approvals = [{ id: 'appr_1', opportunityId: 'opp_1' }];
  const opportunities = [{ id: 'opp_1', status: 'published', productDraft: { demo: false } }];
  assert.equal(pendingPublishApprovals(approvals, opportunities).length, 0);
});

test('pendingPublishApprovals drops an approval for a demo draft, which can never actually be published', () => {
  // routes/approvals.js now refuses to create this approval going
  // forward, but a stale one created before that server-side fix
  // existed must not keep inflating this count or this page's own
  // preview list indefinitely.
  const approvals = [{ id: 'appr_1', opportunityId: 'opp_1' }];
  const opportunities = [{ id: 'opp_1', status: 'draft', productDraft: { demo: true } }];
  assert.equal(pendingPublishApprovals(approvals, opportunities).length, 0);
});

test('pendingPublishApprovals drops an approval whose opportunity failed to load, rather than crashing', () => {
  const approvals = [{ id: 'appr_1', opportunityId: 'opp_missing' }];
  assert.equal(pendingPublishApprovals(approvals, []).length, 0);
});
