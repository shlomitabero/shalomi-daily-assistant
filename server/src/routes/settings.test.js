import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __resetForTests } from '../db/store.js';
import { readSettings, patchSettings } from './settings.js';

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.statusCode ??= 200; return res; };
  return res;
}

test('readSettings returns the current settings row', () => {
  __resetForTests();
  const res = makeRes();
  readSettings({}, res);
  assert.equal(res.body.settings.mode, 'research');
});

test('patchSettings treats a request with no body at all as an empty patch instead of throwing', () => {
  // req.body is undefined, not {}, when body-parser didn't run for this
  // request at all - every other test here always supplies a body
  // object. An empty patch is a legitimate no-op, not an error.
  __resetForTests();
  const res = makeRes();
  patchSettings({}, res);
  assert.equal(res.statusCode, 200);
});

test('patchSettings rejects an invalid mode instead of storing it', () => {
  // The owner's mode gate (research/approve/auto_limited) is the one thing
  // deciding whether a real action is even allowed to run — a typo here
  // must never silently land as some other unrecognized mode string.
  __resetForTests();
  const res = makeRes();
  patchSettings({ body: { mode: 'auto_unlimited' } }, res);
  assert.equal(res.statusCode, 400);
  // Settings.jsx renders this verbatim in an otherwise all-Hebrew app -
  // it was a raw English technical message ("mode must be one of ...")
  // until now, the one validation error in this file that hadn't been
  // translated like every other user-facing error elsewhere.
  assert.match(res.body.error, /מצב הפעולה חייב להיות אחד מ/);
});

test('patchSettings accepts each valid mode', () => {
  __resetForTests();
  for (const mode of ['research', 'approve', 'auto_limited']) {
    const res = makeRes();
    patchSettings({ body: { mode } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.settings.mode, mode);
  }
});

test('patchSettings rejects a negative or non-numeric budget instead of storing it', () => {
  __resetForTests();
  const resNegative = makeRes();
  patchSettings({ body: { budget: -1 } }, resNegative);
  assert.equal(resNegative.statusCode, 400);
  // Was a raw English message ("budget must be a non-negative number")
  // shown verbatim on Settings.jsx, in an otherwise all-Hebrew app.
  assert.match(resNegative.body.error, /תקציב חייב להיות מספר לא שלילי/);

  const resString = makeRes();
  patchSettings({ body: { budget: 'a lot' } }, resString);
  assert.equal(resString.statusCode, 400);
});

test('patchSettings sets budgetConfigured true as soon as a real budget is set', () => {
  __resetForTests();
  const res = makeRes();
  patchSettings({ body: { budget: 500 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.settings.budget, 500);
  assert.equal(res.body.settings.budgetConfigured, true);
});

test('patchSettings does not mark budgetConfigured true for a budget of 0', () => {
  // The client's settings form always resubmits every field together
  // (country, mode, budget, ...) on every save, so `budget` is present
  // in the request body even when the owner only meant to change some
  // other field and never touched budget (still at its untouched default
  // of 0). Treating that as "a budget was configured" would dismiss the
  // dashboard's "set a budget" nudge the owner never actually acted on.
  __resetForTests();
  const res = makeRes();
  patchSettings({ body: { budget: 0, country: 'IL' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.settings.budget, 0);
  assert.equal(res.body.settings.budgetConfigured, false);
});

test('patchSettings clears budgetConfigured back to false when a real budget is later reset to 0', () => {
  // db.settings.update merges the patch - without always setting this
  // field (not just conditionally to true), resetting budget to 0 after
  // it was once real left budgetConfigured stuck at true forever, since
  // the merge then just preserved whatever was already stored.
  __resetForTests();
  patchSettings({ body: { budget: 500 } }, makeRes());
  const res = makeRes();
  patchSettings({ body: { budget: 0 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.settings.budget, 0);
  assert.equal(res.body.settings.budgetConfigured, false);
});

test('patchSettings allows maxLoss to be explicitly cleared to null (no limit)', () => {
  __resetForTests();
  patchSettings({ body: { maxLoss: 200 } }, makeRes());
  const res = makeRes();
  patchSettings({ body: { maxLoss: null } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.settings.maxLoss, null);
});

test('patchSettings rejects a negative maxLoss', () => {
  __resetForTests();
  const res = makeRes();
  patchSettings({ body: { maxLoss: -50 } }, res);
  assert.equal(res.statusCode, 400);
  // Was a raw English message ("maxLoss must be null (no limit) or a
  // non-negative number") shown verbatim on Settings.jsx.
  assert.match(res.body.error, /הפסד מרבי חייב להיות ריק/);
});

test('patchSettings rejects a non-numeric maxLoss instead of storing it', () => {
  // Mirrors the budget type-check above - typeof patch.maxLoss !== 'number'
  // was never actually exercised for maxLoss, only for budget.
  __resetForTests();
  const res = makeRes();
  patchSettings({ body: { maxLoss: 'unlimited' } }, res);
  assert.equal(res.statusCode, 400);
});

test('patchSettings rejects a non-boolean emergencyStop instead of storing it', () => {
  // mode/budget/maxLoss above all reject a malformed value - emergencyStop
  // (the one field meant for "use the moment something looks wrong") was
  // the sole field in ALLOWED_FIELDS with no type check at all. A string
  // like "false" is truthy in JS, so storing it as-is would make the gate
  // (`if (emergencyStop) ...`) read a stop the owner never actually set.
  __resetForTests();
  const res = makeRes();
  patchSettings({ body: { emergencyStop: 'false' } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /עצירת חירום חייבת להיות/);
});

test('patchSettings accepts a real boolean emergencyStop in both directions', () => {
  __resetForTests();
  const resOn = makeRes();
  patchSettings({ body: { emergencyStop: true } }, resOn);
  assert.equal(resOn.statusCode, 200);
  assert.equal(resOn.body.settings.emergencyStop, true);

  const resOff = makeRes();
  patchSettings({ body: { emergencyStop: false } }, resOff);
  assert.equal(resOff.statusCode, 200);
  assert.equal(resOff.body.settings.emergencyStop, false);
});

test('patchSettings ignores fields outside the allowed list, e.g. OWNER_PASSWORD, instead of storing them', () => {
  // The hard rule that an owner-only field can never be set through this
  // endpoint depends entirely on ALLOWED_FIELDS staying an allow-list.
  __resetForTests();
  const res = makeRes();
  patchSettings({ body: { OWNER_PASSWORD: 'hacked', mode: 'research' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.settings.OWNER_PASSWORD, undefined);
});

test('patchSettings merges a patch without dropping fields it did not touch', () => {
  __resetForTests();
  patchSettings({ body: { budget: 300, country: 'IL' } }, makeRes());
  const res = makeRes();
  patchSettings({ body: { mode: 'approve' } }, res);
  assert.equal(res.body.settings.mode, 'approve');
  assert.equal(res.body.settings.budget, 300);
  assert.equal(res.body.settings.country, 'IL');
});
