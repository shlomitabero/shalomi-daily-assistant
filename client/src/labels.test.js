import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMoney, actionTypeLabel, resultLabel, riskLevelLabel, sideLabel,
  opportunityStatusLabel, sourceLabel, missingFieldLabel, reasonLabel,
  autonomousScanSummary, saleConfirmedSummary,
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

test('autonomousScanSummary gives a clean Hebrew message on failure, not the raw detail.error', () => {
  const summary = autonomousScanSummary({ result: 'failed', detail: { error: 'ECONNRESET' } });
  assert.match(summary, /בדוק את לוגי השרת/);
  assert.doesNotMatch(summary, /ECONNRESET/);
});

test('autonomousScanSummary falls back to resultLabel for any other result shape', () => {
  assert.equal(autonomousScanSummary({ result: 'success', detail: {} }).length > 0, true);
});

test('saleConfirmedSummary reports a verified sale', () => {
  assert.equal(saleConfirmedSummary({ result: 'success' }), 'מכירה אומתה בפועל.');
});

test('saleConfirmedSummary explains a sandbox transaction without implying real revenue', () => {
  assert.match(saleConfirmedSummary({ result: 'skipped: sandbox transaction, not recorded as real revenue' }), /עסקת בדיקה/);
});

test('saleConfirmedSummary gives a clean Hebrew message for a blocked sale, not the raw engine error text', () => {
  const summary = saleConfirmedSummary({ result: 'blocked: transaction total is not a valid number: "N/A"' });
  assert.match(summary, /שגיאה בעיבוד/);
  assert.doesNotMatch(summary, /N\/A/);
});

test('saleConfirmedSummary falls back to resultLabel for any other result', () => {
  assert.equal(saleConfirmedSummary({ result: 'failed' }), 'נכשל');
});
