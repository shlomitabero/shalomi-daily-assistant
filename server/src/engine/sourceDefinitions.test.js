import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_DEFINITIONS, isSourceConnected } from './sourceDefinitions.js';

test('every source definition declares what it needs and how to connect it', () => {
  for (const def of SOURCE_DEFINITIONS) {
    assert.ok(def.id);
    assert.ok(Array.isArray(def.requiredEnv) && def.requiredEnv.length > 0);
    assert.ok(def.howToConnect && def.howToConnect.length > 0);
  }
});

test('a source with all required env vars present is reported connected', () => {
  const def = { requiredEnv: ['FOO_KEY', 'BAR_KEY'] };
  assert.equal(isSourceConnected(def, { FOO_KEY: 'x', BAR_KEY: 'y' }), true);
});

test('a source missing even one required env var is reported not connected', () => {
  const def = { requiredEnv: ['FOO_KEY', 'BAR_KEY'] };
  assert.equal(isSourceConnected(def, { FOO_KEY: 'x' }), false);
  assert.equal(isSourceConnected(def, {}), false);
});
