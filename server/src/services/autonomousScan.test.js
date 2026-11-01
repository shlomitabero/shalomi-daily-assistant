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

test('runAutonomousScan actually creates a real honest opportunity end-to-end when connected and under the limit', async () => {
  // The two guard-clause tests above were the only coverage this ever had —
  // the actual "it works" path (source connected, under the draft limit, the
  // AI answers normally) was never exercised, even though it's the one
  // thing this whole feature exists to do.
  __resetForTests();
  const topicResponse = {
    id: 'msg_topic', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify({ topic: 'ניהול לקוחות לעצמאים', audience: 'עצמאים' }) }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
  };
  const draftResponse = {
    id: 'msg_draft', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify({
      title: 'מדריך ניהול לקוחות', guide: 'תוכן המדריך', salesHeadline: 'כותרת',
      salesBullets: ['א', 'ב', 'ג'], salesParagraph: 'פסקה',
    }) }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
  };
  // withEnv (above) restores env vars as soon as the sync portion of fn()
  // returns — fine for a single pre-await read, but this test needs
  // ANTHROPIC_API_KEY to still be set across TWO sequential awaited calls
  // (generateTopicIdea, then draftProduct inside
  // createDigitalProductOpportunity), so it's set/restored manually here
  // around the one fully-awaited call instead.
  const envVars = { ANTHROPIC_API_KEY: 'test-key', PADDLE_API_KEY: 'fake', PADDLE_CLIENT_TOKEN: 'fake', PADDLE_WEBHOOK_SECRET: 'fake' };
  const originalEnv = {};
  for (const key of Object.keys(envVars)) {
    originalEnv[key] = process.env[key];
    process.env[key] = envVars[key];
  }
  let call = 0;
  const originalFetch = globalThis.fetch;
  // generateTopicIdea's call hits the Anthropic API first, then
  // createDigitalProductOpportunity's draftProduct call hits it second —
  // same endpoint, two different real responses in sequence.
  globalThis.fetch = async () => {
    call += 1;
    const body = call === 1 ? topicResponse : draftResponse;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await runAutonomousScan();
    assert.equal(result.ran, true);
    assert.equal(result.opportunity.title, JSON.parse(draftResponse.content[0].text).title);
    assert.equal(result.opportunity.status, 'draft'); // default mode is 'research' — never auto-published
    assert.equal(result.opportunity.revenueEstimate, null); // demand is never fabricated
    assert.equal(db.opportunities.all().length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(originalEnv)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
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
