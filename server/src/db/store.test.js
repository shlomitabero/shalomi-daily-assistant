import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDataDir } from './store.js';

test('resolveDataDir uses the env override when set', () => {
  assert.equal(resolveDataDir('/data', '/app/server/data'), '/data');
});

test('resolveDataDir falls back to the default when unset', () => {
  assert.equal(resolveDataDir(undefined, '/app/server/data'), '/app/server/data');
  assert.equal(resolveDataDir('', '/app/server/data'), '/app/server/data');
});
