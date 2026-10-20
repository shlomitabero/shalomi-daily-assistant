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

test('patchSettings rejects an invalid mode instead of storing it', () => {
  // The owner's mode gate (research/approve/auto_limited) is the one thing
  // deciding whether a real action is even allowed to run — a typo here
  // must never silently land as some other unrecognized mode string.
  __resetForTests();
  const res = makeRes();
  patchSettings({ body: { mode: 'auto_unlimited' } }, res);
  assert.equal(res.statusCode, 400);
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
