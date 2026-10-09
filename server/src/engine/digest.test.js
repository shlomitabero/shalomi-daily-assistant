import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyDigest } from './digest.js';

const ledgerSummary = { cashInToday: 100, cashOutToday: 20, netProfitToday: 80, outstandingReceivables: 0, pendingObligations: 0, netProfitAllTime: 80 };

test('reports net profit, cash in/out, and action count', () => {
  const digest = buildDailyDigest({ ledgerSummary, actionsToday: [{ id: 1 }, { id: 2 }] });
  assert.match(digest.text, /רווח נטו מאומת היום: 80\.00/);
  assert.match(digest.text, /נכנס בפועל: 100\.00/);
  assert.match(digest.text, /יצא בפועל: 20\.00/);
  assert.match(digest.text, /פעולות שבוצעו: 2/);
});

test('reports a negative net profit with a minus sign, not a fabricated positive', () => {
  const digest = buildDailyDigest({ ledgerSummary: { ...ledgerSummary, netProfitToday: -45.5 } });
  assert.match(digest.text, /רווח נטו מאומת היום: -45\.50/);
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
