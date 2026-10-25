import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPaddleConfigured, paddleClientConfig, createOneTimePrice } from './paddle.js';

function withEnv(vars, fn) {
  const originals = {};
  for (const key of Object.keys(vars)) {
    originals[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  }
}

test('isPaddleConfigured is false when either the API key or client token is missing', () => {
  // This is what gates the real "פרסם מוצר" checkout button — it must
  // never read as configured on a half-set-up environment, or the owner
  // could be shown a checkout that silently can't actually charge anyone.
  withEnv({ PADDLE_API_KEY: undefined, PADDLE_CLIENT_TOKEN: 'tok' }, () => {
    assert.equal(isPaddleConfigured(), false);
  });
  withEnv({ PADDLE_API_KEY: 'key', PADDLE_CLIENT_TOKEN: undefined }, () => {
    assert.equal(isPaddleConfigured(), false);
  });
});

test('isPaddleConfigured is true only once both the API key and client token are set', () => {
  withEnv({ PADDLE_API_KEY: 'key', PADDLE_CLIENT_TOKEN: 'tok' }, () => {
    assert.equal(isPaddleConfigured(), true);
  });
});

test('paddleClientConfig never fabricates a clientToken when none is configured', () => {
  withEnv({ PADDLE_CLIENT_TOKEN: undefined, PADDLE_ENV: undefined }, () => {
    assert.deepEqual(paddleClientConfig(), { clientToken: null, sandbox: false });
  });
});

test('paddleClientConfig reports sandbox mode honestly', () => {
  withEnv({ PADDLE_CLIENT_TOKEN: 'tok', PADDLE_ENV: 'sandbox' }, () => {
    assert.deepEqual(paddleClientConfig(), { clientToken: 'tok', sandbox: true });
  });
});

test('createOneTimePrice times out instead of hanging forever when Paddle never responds', async () => {
  // Without an explicit timeout, a hung connection to Paddle would leave
  // the owner's "פרסם מוצר" click pending indefinitely — worse than a
  // clear error, since this is the one path that moves toward real money.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, { signal } = {}) => new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  try {
    await withEnv({ PADDLE_API_KEY: 'key', PADDLE_ENV: 'sandbox' }, () =>
      assert.rejects(
        () => createOneTimePrice({ name: 'test', amountCents: 900, timeoutMs: 5 }),
        /timed out/
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
