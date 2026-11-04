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

test('isPaddleConfigured is false when any one of the three required vars is missing', () => {
  // This is what gates the real "פרסם מוצר" checkout button — it must
  // never read as configured on a half-set-up environment, or the owner
  // could be shown a checkout that silently can't actually charge anyone.
  withEnv({ PADDLE_API_KEY: undefined, PADDLE_CLIENT_TOKEN: 'tok', PADDLE_WEBHOOK_SECRET: 'whsec' }, () => {
    assert.equal(isPaddleConfigured(), false);
  });
  withEnv({ PADDLE_API_KEY: 'key', PADDLE_CLIENT_TOKEN: undefined, PADDLE_WEBHOOK_SECRET: 'whsec' }, () => {
    assert.equal(isPaddleConfigured(), false);
  });
  // Without this, a real customer could pay through a real checkout and
  // the webhook that confirms it would be silently rejected for a missing
  // signature secret — the sale recorded nowhere, the customer given
  // nothing, with no error anyone would ever see.
  withEnv({ PADDLE_API_KEY: 'key', PADDLE_CLIENT_TOKEN: 'tok', PADDLE_WEBHOOK_SECRET: undefined }, () => {
    assert.equal(isPaddleConfigured(), false);
  });
});

test('isPaddleConfigured is true only once all three required vars are set', () => {
  withEnv({ PADDLE_API_KEY: 'key', PADDLE_CLIENT_TOKEN: 'tok', PADDLE_WEBHOOK_SECRET: 'whsec' }, () => {
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

test('createOneTimePrice creates a real product then a real price and returns both ids', async () => {
  // The timeout test above was the only coverage this function had — the
  // actual "Paddle answers normally" path, which every real publish goes
  // through, was never exercised anywhere.
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith('/products')) {
      return new Response(JSON.stringify({ data: { id: 'pro_123' } }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: { id: 'pri_456' } }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  // withEnv (above) restores env vars as soon as the sync portion of fn()
  // returns — fine for a single pre-await env read, but createOneTimePrice
  // makes TWO sequential awaited fetch calls (products, then prices), each
  // reading PADDLE_ENV fresh via paddleApiBase() — so it's set/restored
  // manually here around the one fully-awaited call instead.
  const original = process.env.PADDLE_ENV;
  process.env.PADDLE_API_KEY = 'key';
  process.env.PADDLE_ENV = 'sandbox';
  try {
    const result = await createOneTimePrice({ name: 'מדריך תקציב', amountCents: 900, currencyCode: 'USD' });
    assert.deepEqual(result, { productId: 'pro_123', priceId: 'pri_456' });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://sandbox-api.paddle.com/products');
    assert.equal(calls[0].body.name, 'מדריך תקציב');
    assert.equal(calls[1].url, 'https://sandbox-api.paddle.com/prices');
    assert.equal(calls[1].body.product_id, 'pro_123');
    assert.equal(calls[1].body.unit_price.amount, '900');
  } finally {
    globalThis.fetch = originalFetch;
    if (original === undefined) delete process.env.PADDLE_ENV;
    else process.env.PADDLE_ENV = original;
  }
});

test('createOneTimePrice throws a clear error instead of a crash when Paddle rejects the product creation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('vendor account not approved', { status: 403 });
  try {
    await withEnv({ PADDLE_API_KEY: 'key', PADDLE_ENV: 'sandbox' }, () =>
      assert.rejects(
        () => createOneTimePrice({ name: 'test', amountCents: 900 }),
        /Paddle product creation failed.*vendor account not approved/s
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createOneTimePrice throws a clear error instead of a crash when Paddle rejects the price creation', async () => {
  // The product call can succeed while the price call still fails (e.g. a
  // bad currency code) — this must surface as its own distinct error, not
  // be swallowed or confused with a product-creation failure.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/products')) {
      return new Response(JSON.stringify({ data: { id: 'pro_123' } }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return new Response('invalid currency_code', { status: 400 });
  };
  try {
    await withEnv({ PADDLE_API_KEY: 'key', PADDLE_ENV: 'sandbox' }, () =>
      assert.rejects(
        () => createOneTimePrice({ name: 'test', amountCents: 900 }),
        /Paddle price creation failed.*invalid currency_code/s
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createOneTimePrice propagates a real network failure as-is, not mislabeled as a timeout', async () => {
  // A DNS failure or connection refused rejects fetch() itself with a
  // non-AbortError (e.g. a plain TypeError) - this must surface as that
  // real error, not get misreported as "Paddle request timed out" (which
  // would send the owner chasing the wrong problem).
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND api.paddle.com'); };
  try {
    await withEnv({ PADDLE_API_KEY: 'key', PADDLE_ENV: 'sandbox' }, () =>
      assert.rejects(
        () => createOneTimePrice({ name: 'test', amountCents: 900 }),
        /ENOTFOUND/
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
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
