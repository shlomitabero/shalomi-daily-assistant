import { test } from 'node:test';
import assert from 'node:assert/strict';

// api.js references localStorage and window only inside function bodies
// (never at module load time), so these stubs just need to exist before a
// test actually calls something - plain Node has no browser globals at all
// otherwise. EventTarget, Event, fetch and Response are already real Node
// globals (the same ones server-side tests already rely on, e.g.
// marketData.test.js's `new Response(...)`), so window only needs to be a
// real EventTarget to behave exactly like AuthContext.jsx's own
// addEventListener/dispatchEvent usage in the real app.
function makeMemoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}
globalThis.localStorage = makeMemoryStorage();
globalThis.window = new EventTarget();

const { getToken, setToken, api } = await import('./api.js');

function stubFetchOnce(responseFactory) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    globalThis.__lastFetchUrl = url;
    globalThis.__lastFetchOptions = options;
    return responseFactory(url, options);
  };
  return () => { globalThis.fetch = original; };
}

test('setToken/getToken round-trip through localStorage', () => {
  setToken('abc123');
  assert.equal(getToken(), 'abc123');
});

test('setToken(null) removes the stored token rather than storing the string "null"', () => {
  setToken('abc123');
  setToken(null);
  assert.equal(getToken(), null);
});

test('a request includes an Authorization header only when a token is set', async () => {
  setToken(null);
  const restore = stubFetchOnce(() => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
  try {
    await api.health();
    assert.equal(globalThis.__lastFetchOptions.headers.authorization, undefined);

    setToken('real-token');
    await api.health();
    assert.equal(globalThis.__lastFetchOptions.headers.authorization, 'Bearer real-token');
  } finally {
    restore();
    setToken(null);
  }
});

test('a real network failure (fetch itself throws) surfaces a clean Hebrew message, not the raw browser error', async () => {
  // fetch() throws on a genuine network failure (offline, DNS, server
  // unreachable) - never on an HTTP error status, which has its own path
  // below. Uncaught, that raw error (e.g. "Failed to fetch") has an
  // English message and no .data, so every page's
  // `err.data?.error || err.message` fallback would show English text
  // dropped into this otherwise all-Hebrew app.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    await assert.rejects(
      () => api.health(),
      (err) => {
        assert.match(err.message, /בעיית תקשורת/);
        assert.equal(err.data.error, err.message);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a non-2xx response throws with the server\'s own error message and status attached', async () => {
  const restore = stubFetchOnce(() => new Response(JSON.stringify({ error: 'תקציב לא מוגדר' }), { status: 409, headers: { 'content-type': 'application/json' } }));
  try {
    await assert.rejects(
      () => api.health(),
      (err) => {
        assert.equal(err.message, 'תקציב לא מוגדר');
        assert.equal(err.status, 409);
        assert.deepEqual(err.data, { error: 'תקציב לא מוגדר' });
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('a response body that is not valid JSON falls back to an empty object instead of throwing from res.json()', async () => {
  const restore = stubFetchOnce(() => new Response('not json at all', { status: 200, headers: { 'content-type': 'text/plain' } }));
  try {
    const result = await api.health();
    assert.deepEqual(result, {});
  } finally {
    restore();
  }
});

test('a 401 on a normal endpoint clears the token and dispatches auth:expired', async () => {
  setToken('stale-token');
  let dispatched = false;
  const listener = () => { dispatched = true; };
  window.addEventListener('auth:expired', listener);
  const restore = stubFetchOnce(() => new Response(JSON.stringify({ error: 'לא מחובר — יש להתחבר מחדש' }), { status: 401, headers: { 'content-type': 'application/json' } }));
  try {
    await assert.rejects(() => api.health());
    assert.equal(getToken(), null);
    assert.equal(dispatched, true);
  } finally {
    restore();
    window.removeEventListener('auth:expired', listener);
    setToken(null);
  }
});

test('a 401 specifically from /login never dispatches auth:expired - it just means the password was wrong', () => {
  // Dispatching auth:expired here would make AuthContext show "the
  // previous login expired" on a fresh, failed login attempt where no
  // session ever existed at all.
  setToken(null);
  let dispatched = false;
  const listener = () => { dispatched = true; };
  window.addEventListener('auth:expired', listener);
  const restore = stubFetchOnce(() => new Response(JSON.stringify({ error: 'סיסמה שגויה' }), { status: 401, headers: { 'content-type': 'application/json' } }));
  return assert.rejects(() => api.login('wrong'))
    .then(() => {
      assert.equal(dispatched, false);
    })
    .finally(() => {
      restore();
      window.removeEventListener('auth:expired', listener);
    });
});
