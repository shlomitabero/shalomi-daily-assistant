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

test('catchUpDailyDigestIfMissed does nothing before 7am, leaving the 7am cron tick to handle it normally', () => {
  __resetForTests();
  const result = catchUpDailyDigestIfMissed(new Date('2026-01-01T06:59:00'));
  assert.equal(result, null);
  assert.equal(db.digests.all().length, 0);
});

test('catchUpDailyDigestIfMissed generates today\'s digest when called after 7am and none exists yet', () => {
  // This is the self-healing case: the process restarted (this app gets
  // redeployed roughly hourly) at, say, 9am, missing the exact 7:00 cron
  // tick entirely - without this, that day's digest would simply never be
  // generated, with no error or indication anything was skipped.
  __resetForTests();
  const result = catchUpDailyDigestIfMissed(new Date('2026-01-01T09:00:00'));
  assert.ok(result);
  assert.equal(db.digests.all().length, 1);
});

test('catchUpDailyDigestIfMissed does nothing when today\'s digest already exists, even after 7am', () => {
  // Must never silently overwrite a digest the owner already generated
  // today (via the normal cron tick or their own manual "generate now"
  // click) just because the server happened to restart again later.
  __resetForTests();
  const first = generateDailyDigest();
  const result = catchUpDailyDigestIfMissed(new Date('2026-01-01T10:00:00'));
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
