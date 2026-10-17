import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests, makeId } from '../db/store.js';
import { runAutonomousScan } from './autonomousScan.js';

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

test('runAutonomousScan refuses to run when the ai_digital_products source is not connected', async () => {
  // The scan loop must never silently try to fabricate an opportunity on a
  // source it has no real credentials for — this is the one guard that
  // keeps it honest when the owner hasn't set up ANTHROPIC_API_KEY/Paddle yet.
  __resetForTests();
  await withEnv(
    { ANTHROPIC_API_KEY: undefined, PADDLE_API_KEY: undefined, PADDLE_CLIENT_TOKEN: undefined, PADDLE_WEBHOOK_SECRET: undefined },
    async () => {
      const result = await runAutonomousScan();
      assert.equal(result.ran, false);
      assert.match(result.reason, /not connected/);
      assert.equal(db.opportunities.all().length, 0);
    }
  );
});

test('runAutonomousScan backs off once too many drafts are already awaiting review, without calling the AI', async () => {
  // This must short-circuit BEFORE any AI call — piling up a 6th draft on
  // top of 5 unreviewed ones wastes a real API call for no reason the
  // owner would ever see acted on.
  __resetForTests();
  await withEnv(
    { ANTHROPIC_API_KEY: 'fake-key-never-used', PADDLE_API_KEY: 'fake', PADDLE_CLIENT_TOKEN: 'fake', PADDLE_WEBHOOK_SECRET: 'fake' },
    async () => {
      for (let i = 0; i < 5; i += 1) {
        db.opportunities.insert({ id: makeId('opp'), title: `draft ${i}`, status: 'draft' });
      }
      const result = await runAutonomousScan();
      assert.equal(result.ran, false);
      assert.match(result.reason, /5/);
      assert.equal(db.opportunities.all().length, 5);
    }
  );
});
