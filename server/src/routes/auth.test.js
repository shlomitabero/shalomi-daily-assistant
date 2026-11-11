import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login } from './auth.js';
import { verifyOwnerToken } from '../engine/auth.js';
import { db, makeId, __resetForTests } from '../db/store.js';

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.statusCode ??= 200; return res; };
  return res;
}

function withOwnerPassword(password, fn) {
  const original = process.env.OWNER_PASSWORD;
  if (password === undefined) delete process.env.OWNER_PASSWORD;
  else process.env.OWNER_PASSWORD = password;
  try {
    return fn();
  } finally {
    if (original !== undefined) process.env.OWNER_PASSWORD = original;
    else delete process.env.OWNER_PASSWORD;
  }
}

// The login rate limiter is a single module-level instance shared across
// every call to login() (same as production, where it must persist across
// requests) - each test below uses its own distinct `ip` so its failures
// never bleed into another test's attempt count.
let nextIp = 0;
function uniqueIp() {
  nextIp += 1;
  return `10.0.0.${nextIp}`;
}

test('login returns 503 instead of a confusing 401 when OWNER_PASSWORD is not configured yet', () => {
  withOwnerPassword(undefined, () => {
    const res = makeRes();
    login({ ip: uniqueIp(), body: { password: 'anything' } }, res);
    assert.equal(res.statusCode, 503);
    // Login.jsx renders this verbatim in an otherwise all-Hebrew app - was
    // a raw English technical message ("OWNER_PASSWORD is not set on the
    // server yet") until now.
    assert.match(res.body.error, /OWNER_PASSWORD עדיין לא הוגדר/);
  });
});

test('login rejects the wrong password without issuing a token', () => {
  withOwnerPassword('the-real-password', () => {
    const res = makeRes();
    login({ ip: uniqueIp(), body: { password: 'guess' } }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.token, undefined);
    // The single most commonly-reached error in the whole app (anyone who
    // mistypes their password sees it) was the raw English string "wrong
    // password", shown verbatim on Login.jsx.
    assert.equal(res.body.error, 'סיסמה שגויה');
  });
});

test('login issues a real, verifiable owner token for the correct password', () => {
  withOwnerPassword('the-real-password', () => {
    const res = makeRes();
    login({ ip: uniqueIp(), body: { password: 'the-real-password' } }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.token);
    assert.equal(verifyOwnerToken(res.body.token), true);
  });
});

test('a wrong password logs a login_attempt entry to the activity log, with the source ip but never the password itself', () => {
  // A brute-force attempt against the owner's own login was invisible
  // anywhere in the app before this - not logged here, and console.error
  // never fired for it either, so even Railway's own log viewer showed
  // nothing.
  __resetForTests();
  withOwnerPassword('the-real-password', () => {
    const ip = uniqueIp();
    login({ ip, body: { password: 'a-wrong-guess' } }, makeRes());
    const logged = db.actions_log.where((a) => a.type === 'login_attempt' && a.detail?.ip === ip);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].result, 'failed');
    assert.equal(JSON.stringify(logged[0]).includes('a-wrong-guess'), false);
  });
});

test('a successful login does not write a login_attempt entry - only a failure/block is worth the owner\'s attention', () => {
  __resetForTests();
  withOwnerPassword('the-real-password', () => {
    login({ ip: uniqueIp(), body: { password: 'the-real-password' } }, makeRes());
    assert.equal(db.actions_log.where((a) => a.type === 'login_attempt').length, 0);
  });
});

test('login rejects a request with no password in the body instead of throwing', () => {
  withOwnerPassword('the-real-password', () => {
    const res = makeRes();
    login({ ip: uniqueIp(), body: {} }, res);
    assert.equal(res.statusCode, 401);
  });
});

test('login falls back to a shared "unknown" rate-limit key instead of throwing when req.ip is missing', () => {
  // req.ip can genuinely be undefined (a request object built by something
  // other than Express's own listener, or a proxy config that doesn't set
  // it) - every other test always supplies a real ip, so this ?? 'unknown'
  // fallback had never actually been exercised.
  withOwnerPassword('the-real-password', () => {
    const res = makeRes();
    login({ body: { password: 'the-real-password' } }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.token);
  });
});

test('login rejects a request with no body at all instead of throwing', () => {
  // req.body is undefined, not {}, when body-parser didn't run for this
  // request at all (e.g. a missing/wrong content-type) - every other test
  // always supplies a body object, even an empty one.
  withOwnerPassword('the-real-password', () => {
    const res = makeRes();
    login({ ip: uniqueIp() }, res);
    assert.equal(res.statusCode, 401);
  });
});

test('login_attempt entries are pruned once they exceed the retention cap, oldest first', () => {
  // A sustained brute-force attack now writes a real, permanent
  // actions_log row per attempt (routes/auth.js's logLoginAttempt) -
  // without pruning, that row count grows unbounded, and db/store.js's
  // persist() rewrites the ENTIRE db.json file on every single write (to
  // every table, not just this one), so that growth would progressively
  // slow down every future write in the whole app. Pre-seeds directly at
  // the real 500-entry cap (not via 500 real login() calls, which would
  // just be a much slower way to set up the exact same starting state)
  // with increasing timestamps, so the oldest one is unambiguous.
  __resetForTests();
  withOwnerPassword('the-real-password', () => {
    const base = Date.parse('2020-01-01T00:00:00.000Z');
    for (let i = 0; i < 500; i += 1) {
      db.actions_log.insert({
        id: makeId('act'), type: 'login_attempt', detail: { ip: `seed-${i}` },
        result: 'failed', createdAt: new Date(base + i * 1000).toISOString(),
      });
    }
    assert.equal(db.actions_log.where((a) => a.type === 'login_attempt').length, 500);

    login({ ip: uniqueIp(), body: { password: 'wrong' } }, makeRes());

    const logged = db.actions_log.where((a) => a.type === 'login_attempt');
    assert.equal(logged.length, 500); // stayed at the cap, not 501
    assert.equal(logged.some((a) => a.detail?.ip === 'seed-0'), false); // the oldest was pruned
    assert.equal(logged.some((a) => a.detail?.ip === 'seed-499'), true); // a newer seed entry survives
  });
});

test('login_attempt pruning never touches a different action type\'s entries', () => {
  __resetForTests();
  withOwnerPassword('the-real-password', () => {
    const base = Date.parse('2020-01-01T00:00:00.000Z');
    db.actions_log.insert({
      id: makeId('act'), type: 'draft_product', detail: {}, result: 'success',
      createdAt: new Date(base).toISOString(),
    });
    for (let i = 0; i < 500; i += 1) {
      db.actions_log.insert({
        id: makeId('act'), type: 'login_attempt', detail: { ip: `seed-${i}` },
        result: 'failed', createdAt: new Date(base + i * 1000).toISOString(),
      });
    }
    login({ ip: uniqueIp(), body: { password: 'wrong' } }, makeRes());
    assert.equal(db.actions_log.where((a) => a.type === 'draft_product').length, 1);
  });
});

test('login blocks further attempts from the same source after too many wrong passwords', () => {
  withOwnerPassword('the-real-password', () => {
    const ip = uniqueIp();
    // The real limit is 10 - exhaust it with wrong passwords from this one
    // source before trying an 11th, which must be refused even before
    // checking the password at all.
    for (let i = 0; i < 10; i += 1) {
      login({ ip, body: { password: 'wrong' } }, makeRes());
    }
    const res = makeRes();
    login({ ip, body: { password: 'wrong' } }, res);
    assert.equal(res.statusCode, 429);
  });
});

test('a rate-limited block logs its own login_attempt entry, distinguishable from an ordinary wrong-password failure', () => {
  __resetForTests();
  withOwnerPassword('the-real-password', () => {
    const ip = uniqueIp();
    for (let i = 0; i < 10; i += 1) {
      login({ ip, body: { password: 'wrong' } }, makeRes());
    }
    login({ ip, body: { password: 'wrong' } }, makeRes()); // the 11th attempt - rate-limited, not re-checked against the password at all
    const logged = db.actions_log.where((a) => a.type === 'login_attempt' && a.detail?.ip === ip);
    assert.equal(logged.length, 11);
    assert.equal(logged.filter((a) => a.result === 'failed').length, 10);
    assert.equal(logged.filter((a) => a.result.startsWith('blocked:')).length, 1);
  });
});

test('login blocks even the correct password once a source is rate-limited', () => {
  // The block protects against an attacker who eventually stumbles on the
  // real password too, not just continued wrong guesses - it must not
  // quietly let the 11th attempt through just because it happens to be
  // right.
  withOwnerPassword('the-real-password', () => {
    const ip = uniqueIp();
    for (let i = 0; i < 10; i += 1) {
      login({ ip, body: { password: 'wrong' } }, makeRes());
    }
    const res = makeRes();
    login({ ip, body: { password: 'the-real-password' } }, res);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.token, undefined);
  });
});

test('login never blocks a different source because another one was rate-limited', () => {
  withOwnerPassword('the-real-password', () => {
    const attackerIp = uniqueIp();
    for (let i = 0; i < 10; i += 1) {
      login({ ip: attackerIp, body: { password: 'wrong' } }, makeRes());
    }
    const res = makeRes();
    login({ ip: uniqueIp(), body: { password: 'the-real-password' } }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.token);
  });
});

test('a successful login resets that source\'s failure count', () => {
  withOwnerPassword('the-real-password', () => {
    const ip = uniqueIp();
    login({ ip, body: { password: 'wrong' } }, makeRes());
    login({ ip, body: { password: 'wrong' } }, makeRes());
    login({ ip, body: { password: 'the-real-password' } }, makeRes());
    // Those two earlier wrong guesses must not still count toward the
    // limit after a real login succeeded in between.
    for (let i = 0; i < 9; i += 1) {
      login({ ip, body: { password: 'wrong' } }, makeRes());
    }
    const res = makeRes();
    login({ ip, body: { password: 'the-real-password' } }, res);
    assert.equal(res.statusCode, 200);
  });
});
