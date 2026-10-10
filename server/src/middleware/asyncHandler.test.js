import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asyncHandler } from './asyncHandler.js';

test('forwards a rejected promise to next(err) instead of letting it go unhandled', async () => {
  const err = new Error('boom');
  const handler = asyncHandler(async () => {
    throw err;
  });
  let caught = null;
  await handler({}, {}, (e) => { caught = e; });
  assert.equal(caught, err);
});

test('does not call next() at all when the handler resolves normally', async () => {
  const handler = asyncHandler(async (req, res) => {
    res.sent = true;
  });
  let nextCalled = false;
  const res = {};
  await handler({}, res, () => { nextCalled = true; });
  assert.equal(res.sent, true);
  assert.equal(nextCalled, false);
});

test('also catches a synchronous throw inside the wrapped handler', async () => {
  const err = new Error('sync boom');
  const handler = asyncHandler(() => {
    throw err;
  });
  let caught = null;
  await handler({}, {}, (e) => { caught = e; });
  assert.equal(caught, err);
});
