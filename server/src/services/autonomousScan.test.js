import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests, makeId } from '../db/store.js';
import { updateSettings } from './settings.js';
import { runAutonomousScan, catchUpAutonomousScanIfMissed } from './autonomousScan.js';

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
    // Every other outcome (not connected, over the cap, an AI call failing)
    // logs its own 'autonomous_scan' entry - this is the one success case,
    // and without it the audit log would show nothing but failures/skips
    // for this type even while the scan was working perfectly.
    const logged = db.actions_log.where((a) => a.type === 'autonomous_scan' && a.result === 'success')[0];
    assert.ok(logged);
    assert.equal(logged.detail.opportunityId, result.opportunity.id);
    assert.equal(logged.detail.published, false);
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

test('runAutonomousScan reports a clean failure, with no opportunity created, when the AI topic call fails', async () => {
  // The AI returning something that doesn't parse as a valid {topic,
  // audience} idea must surface as an honest ran:false failure, not an
  // unhandled rejection that crashes the scheduler's background job.
  __resetForTests();
  const badTopicResponse = {
    id: 'msg_topic', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify({ somethingElse: true }) }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
  };
  const envVars = { ANTHROPIC_API_KEY: 'test-key', PADDLE_API_KEY: 'fake', PADDLE_CLIENT_TOKEN: 'fake', PADDLE_WEBHOOK_SECRET: 'fake' };
  const originalEnv = {};
  for (const key of Object.keys(envVars)) {
    originalEnv[key] = process.env[key];
    process.env[key] = envVars[key];
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(badTopicResponse), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await runAutonomousScan();
    assert.equal(result.ran, false);
    assert.match(result.reason, /topic\/audience/);
    assert.equal(db.opportunities.all().length, 0);
    const logged = db.actions_log.where((a) => a.type === 'autonomous_scan')[0];
    assert.equal(logged.result, 'failed');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(originalEnv)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test('runAutonomousScan reports a clean failure, with no opportunity created, when the AI draft call fails', async () => {
  // Same honest-failure requirement as above, but for the second AI call
  // (drafting the actual product) rather than the first (the topic idea).
  __resetForTests();
  const topicResponse = {
    id: 'msg_topic', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify({ topic: 'נושא', audience: 'קהל' }) }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
  };
  const badDraftResponse = {
    id: 'msg_draft', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify({ title: 'only a title, nothing else' }) }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
  };
  const envVars = { ANTHROPIC_API_KEY: 'test-key', PADDLE_API_KEY: 'fake', PADDLE_CLIENT_TOKEN: 'fake', PADDLE_WEBHOOK_SECRET: 'fake' };
  const originalEnv = {};
  for (const key of Object.keys(envVars)) {
    originalEnv[key] = process.env[key];
    process.env[key] = envVars[key];
  }
  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    call += 1;
    const body = call === 1 ? topicResponse : badDraftResponse;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await runAutonomousScan();
    assert.equal(result.ran, false);
    assert.match(result.reason, /title\/guide\/salesHeadline/);
    assert.equal(db.opportunities.all().length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(originalEnv)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test('runAutonomousScan publishes immediately in auto_limited mode when Paddle is configured', async () => {
  // Publishing costs $0 (no ad spend, no COGS) so auto_limited mode goes
  // straight to a real checkout with no per-action approval — this was
  // the one branch of the whole function never actually exercised.
  __resetForTests();
  updateSettings({ mode: 'auto_limited' });
  const topicResponse = {
    id: 'msg_topic', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify({ topic: 'נושא', audience: 'קהל' }) }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
  };
  const draftResponse = {
    id: 'msg_draft', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify({
      title: 'מדריך', guide: 'תוכן', salesHeadline: 'כותרת', salesBullets: ['א'], salesParagraph: 'פסקה',
    }) }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
  };
  const envVars = { ANTHROPIC_API_KEY: 'test-key', PADDLE_API_KEY: 'fake', PADDLE_CLIENT_TOKEN: 'fake', PADDLE_WEBHOOK_SECRET: 'fake' };
  const originalEnv = {};
  for (const key of Object.keys(envVars)) {
    originalEnv[key] = process.env[key];
    process.env[key] = envVars[key];
  }
  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) return new Response(JSON.stringify(topicResponse), { status: 200, headers: { 'content-type': 'application/json' } });
    if (call === 2) return new Response(JSON.stringify(draftResponse), { status: 200, headers: { 'content-type': 'application/json' } });
    if (call === 3) return { ok: true, json: async () => ({ data: { id: 'pro_123' } }) };
    return { ok: true, json: async () => ({ data: { id: 'pri_456' } }) };
  };
  try {
    const result = await runAutonomousScan();
    assert.equal(result.ran, true);
    assert.equal(result.opportunity.status, 'published');
    assert.equal(result.opportunity.paddlePriceId, 'pri_456');
    const logged = db.actions_log.where((a) => a.type === 'autonomous_scan' && a.result === 'success')[0];
    assert.equal(logged.detail.published, true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(originalEnv)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test('runAutonomousScan leaves the opportunity as a draft when auto-publish fails in auto_limited mode', async () => {
  // A Paddle outage during the autonomous loop's own publish attempt must
  // not lose the drafted opportunity or crash the background job — it
  // just stays a draft for the owner to retry manually, exactly like a
  // failed manual "פרסם מוצר" click would.
  __resetForTests();
  updateSettings({ mode: 'auto_limited' });
  const topicResponse = {
    id: 'msg_topic', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify({ topic: 'נושא', audience: 'קהל' }) }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
  };
  const draftResponse = {
    id: 'msg_draft', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify({
      title: 'מדריך', guide: 'תוכן', salesHeadline: 'כותרת', salesBullets: ['א'], salesParagraph: 'פסקה',
    }) }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
  };
  const envVars = { ANTHROPIC_API_KEY: 'test-key', PADDLE_API_KEY: 'fake', PADDLE_CLIENT_TOKEN: 'fake', PADDLE_WEBHOOK_SECRET: 'fake' };
  const originalEnv = {};
  for (const key of Object.keys(envVars)) {
    originalEnv[key] = process.env[key];
    process.env[key] = envVars[key];
  }
  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) return new Response(JSON.stringify(topicResponse), { status: 200, headers: { 'content-type': 'application/json' } });
    if (call === 2) return new Response(JSON.stringify(draftResponse), { status: 200, headers: { 'content-type': 'application/json' } });
    return { ok: false, text: async () => 'Paddle is down' }; // the product-creation call fails
  };
  try {
    const result = await runAutonomousScan();
    assert.equal(result.ran, true);
    assert.equal(result.opportunity.status, 'draft');
    assert.equal(result.opportunity.paddlePriceId, null);
    assert.equal(db.opportunities.get(result.opportunity.id).status, 'draft');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(originalEnv)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test('runAutonomousScan never counts demo drafts toward the pending-draft cap', async () => {
  // A demo draft can never be published (publishing.js refuses it) and
  // there's no route to delete an opportunity, so it would otherwise sit
  // there forever and permanently block every future scan once 5 piled up -
  // even after a real ANTHROPIC_API_KEY is configured.
  __resetForTests();
  const topicResponse = {
    id: 'msg_topic', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify({ topic: 'נושא', audience: 'קהל' }) }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
  };
  const draftResponse = {
    id: 'msg_draft', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify({
      title: 'מדריך חדש', guide: 'תוכן', salesHeadline: 'כותרת', salesBullets: ['א'], salesParagraph: 'פסקה',
    }) }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
  };
  for (let i = 0; i < 5; i += 1) {
    db.opportunities.insert({ id: makeId('opp'), title: `demo ${i}`, status: 'draft', productDraft: { demo: true } });
  }
  const envVars = { ANTHROPIC_API_KEY: 'test-key', PADDLE_API_KEY: 'fake', PADDLE_CLIENT_TOKEN: 'fake', PADDLE_WEBHOOK_SECRET: 'fake' };
  const originalEnv = {};
  for (const key of Object.keys(envVars)) {
    originalEnv[key] = process.env[key];
    process.env[key] = envVars[key];
  }
  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    call += 1;
    const body = call === 1 ? topicResponse : draftResponse;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await runAutonomousScan();
    assert.equal(result.ran, true);
    assert.equal(db.opportunities.all().length, 6);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(originalEnv)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test('catchUpAutonomousScanIfMissed runs a scan immediately when none has ever been logged', async () => {
  // A fresh install (or a wiped log) must not wait up to 4 hours for the
  // normal cron tick before ever looking for revenue once.
  __resetForTests();
  await withEnv(
    { ANTHROPIC_API_KEY: undefined, PADDLE_API_KEY: undefined, PADDLE_CLIENT_TOKEN: undefined, PADDLE_WEBHOOK_SECRET: undefined },
    async () => {
      const result = await catchUpAutonomousScanIfMissed(new Date());
      assert.ok(result);
      assert.equal(result.ran, false); // source not connected in this test env - still counts as "it ran"
      assert.equal(db.actions_log.where((a) => a.type === 'autonomous_scan').length, 1);
    }
  );
});

test('catchUpAutonomousScanIfMissed does nothing when the last scan was less than 4 hours ago', async () => {
  __resetForTests();
  db.actions_log.insert({
    id: makeId('act'), type: 'autonomous_scan', detail: {}, result: 'blocked: source not connected',
    createdAt: new Date('2026-01-01T10:00:00Z').toISOString(),
  });
  const result = await catchUpAutonomousScanIfMissed(new Date('2026-01-01T12:00:00Z')); // 2 hours later
  assert.equal(result, null);
  assert.equal(db.actions_log.where((a) => a.type === 'autonomous_scan').length, 1);
});

test('catchUpAutonomousScanIfMissed runs a scan when the last one was more than 4 hours ago', async () => {
  // This is the self-healing case: a restart (this app gets redeployed
  // roughly hourly) left a gap longer than the normal 4-hour cadence -
  // without this, the scan would just stay quiet until the next aligned
  // cron tick, however long that takes.
  __resetForTests();
  db.actions_log.insert({
    id: makeId('act'), type: 'autonomous_scan', detail: {}, result: 'blocked: source not connected',
    createdAt: new Date('2026-01-01T06:00:00Z').toISOString(),
  });
  await withEnv(
    { ANTHROPIC_API_KEY: undefined, PADDLE_API_KEY: undefined, PADDLE_CLIENT_TOKEN: undefined, PADDLE_WEBHOOK_SECRET: undefined },
    async () => {
      const result = await catchUpAutonomousScanIfMissed(new Date('2026-01-01T11:00:00Z')); // 5 hours later
      assert.ok(result);
      assert.equal(db.actions_log.where((a) => a.type === 'autonomous_scan').length, 2);
    }
  );
});
