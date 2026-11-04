import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyDigest } from './digest.js';

const ledgerSummary = { cashInToday: 100, cashOutToday: 20, netProfitToday: 80, outstandingReceivables: 0, pendingObligations: 0, netProfitAllTime: 80 };

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
