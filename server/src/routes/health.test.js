import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getHealth } from './health.js';

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

function makeRes() {
  const res = { body: null };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('getHealth reports every integration as not configured when no env vars are set', () => {
  withEnv({
    ANTHROPIC_API_KEY: undefined, PADDLE_API_KEY: undefined, PADDLE_CLIENT_TOKEN: undefined,
    MARKET_DATA_API_KEY: undefined, OWNER_PASSWORD: undefined,
  }, () => {
    const res = makeRes();
    getHealth({}, res);
    assert.deepEqual(res.body, {
      ok: true, name: 'PROFIT AI',
      aiConfigured: false, billingConfigured: false, marketDataConfigured: false, ownerPasswordConfigured: false,
    });
  });
});

test('getHealth reports billingConfigured true only once both Paddle vars are set, never on just one', () => {
  withEnv({ PADDLE_API_KEY: 'key', PADDLE_CLIENT_TOKEN: undefined }, () => {
    const res = makeRes();
    getHealth({}, res);
    assert.equal(res.body.billingConfigured, false);
  });
  withEnv({ PADDLE_API_KEY: undefined, PADDLE_CLIENT_TOKEN: 'tok' }, () => {
    const res = makeRes();
    getHealth({}, res);
    assert.equal(res.body.billingConfigured, false);
  });
  withEnv({ PADDLE_API_KEY: 'key', PADDLE_CLIENT_TOKEN: 'tok' }, () => {
    const res = makeRes();
    getHealth({}, res);
    assert.equal(res.body.billingConfigured, true);
  });
});

test('getHealth reports each independent integration as configured once its own env var is set', () => {
  withEnv({ ANTHROPIC_API_KEY: 'key' }, () => {
    const res = makeRes();
    getHealth({}, res);
    assert.equal(res.body.aiConfigured, true);
  });
  withEnv({ MARKET_DATA_API_KEY: 'key' }, () => {
    const res = makeRes();
    getHealth({}, res);
    assert.equal(res.body.marketDataConfigured, true);
  });
  withEnv({ OWNER_PASSWORD: 'secret' }, () => {
    const res = makeRes();
    getHealth({}, res);
    assert.equal(res.body.ownerPasswordConfigured, true);
  });
});
