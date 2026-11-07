import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login } from './auth.js';
import { verifyOwnerToken } from '../engine/auth.js';

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

test('login rejects a request with no password in the body instead of throwing', () => {
  withOwnerPassword('the-real-password', () => {
    const res = makeRes();
    login({ ip: uniqueIp(), body: {} }, res);
    assert.equal(res.statusCode, 401);
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
