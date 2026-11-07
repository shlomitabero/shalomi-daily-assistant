import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTopicPrompt, generateTopicIdea, isValidTopicIdea, extractJson } from './topicIdeation.js';

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

test('extractJson pulls the {...} block out of prose or markdown fences the model added despite being told not to', () => {
  assert.equal(extractJson('Sure, here you go:\n```json\n{"topic":"x"}\n```'), '{"topic":"x"}');
});

test('extractJson returns the text as-is when it contains no {...} block at all', () => {
  // generateTopicIdea's own 500-token response could, in principle, come
  // back as plain prose with no JSON object anywhere in it at all (a
  // refusal, a truncated response cut off before the opening brace) -
  // every other test here always has at least an opening/closing brace
  // somewhere, so this fallback had never actually been taken. JSON.parse
  // on the result still throws as expected - it was never meant to make
  // non-JSON parseable, only to strip surrounding decoration.
  assert.equal(extractJson('sorry, I cannot help with that'), 'sorry, I cannot help with that');
});

test('isValidTopicIdea accepts a complete idea', () => {
  assert.equal(isValidTopicIdea({ topic: 'ניהול תקציב', audience: 'עצמאים' }), true);
});

test('isValidTopicIdea rejects a missing topic or audience', () => {
  // This is the one path with no human reviewing the input before it's
  // used — a missing field here would silently create a real stored
  // opportunity literally built around "undefined".
  assert.equal(isValidTopicIdea({ audience: 'עצמאים' }), false);
  assert.equal(isValidTopicIdea({ topic: 'ניהול תקציב' }), false);
});

test('isValidTopicIdea rejects a blank topic or audience', () => {
  assert.equal(isValidTopicIdea({ topic: '   ', audience: 'עצמאים' }), false);
  assert.equal(isValidTopicIdea({ topic: 'ניהול תקציב', audience: '' }), false);
});

test('isValidTopicIdea rejects null/undefined input', () => {
  assert.equal(isValidTopicIdea(null), false);
  assert.equal(isValidTopicIdea(undefined), false);
});

test('buildTopicPrompt asks for raw JSON with topic and audience', () => {
  const prompt = buildTopicPrompt({});
  assert.match(prompt, /topic/);
  assert.match(prompt, /audience/);
  assert.match(prompt, /raw JSON only/);
});

test('buildTopicPrompt tells the model to avoid already-tried topics', () => {
  const prompt = buildTopicPrompt({ avoidTitles: ['Topic A', 'Topic B'] });
  assert.match(prompt, /Avoid repeating/);
  assert.match(prompt, /Topic A/);
  assert.match(prompt, /Topic B/);
});

test('generateTopicIdea falls back to a demo idea with no ANTHROPIC_API_KEY, never repeating an avoided title', async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const first = await generateTopicIdea({});
    assert.equal(first.demo, true);
    assert.ok(first.topic);
    assert.ok(first.audience);

    const second = await generateTopicIdea({ avoidTitles: [first.topic] });
    assert.notEqual(second.topic, first.topic);
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

test('generateTopicIdea parses a real successful Anthropic API response', async () => {
  // Same gap as productDraft.test.js: the demo-mode and timeout tests here
  // never exercised the actual "a real API key is set and the API answers
  // normally" path that every real autonomous scan goes through.
  const apiResponse = {
    id: 'msg_test456', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify({ topic: 'תכנון פרישה לעצמאים', audience: 'עצמאים מעל גיל 40' }) }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 30, output_tokens: 20 },
  };
  await withEnv({ ANTHROPIC_API_KEY: 'test-key' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(apiResponse), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    try {
      const result = await generateTopicIdea({});
      assert.equal(result.demo, false);
      assert.equal(result.topic, 'תכנון פרישה לעצמאים');
      assert.equal(result.audience, 'עצמאים מעל גיל 40');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('generateTopicIdea times out instead of hanging for the SDK default of ~10 minutes (retried) when the API never responds', async () => {
  // Without an explicit timeout, a hung connection would block the
  // autonomous scan's background cron job (or a manual "סרוק עכשיו" click)
  // for roughly half an hour with zero feedback.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, { signal } = {}) => new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  try {
    await withEnv({ ANTHROPIC_API_KEY: 'test-key' }, () =>
      assert.rejects(() => generateTopicIdea({ timeoutMs: 5 }))
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateTopicIdea avoids a demo topic given the full stored opportunity title, not just the bare topic', async () => {
  // The real caller (autonomousScan.js) passes db.opportunities' stored
  // titles, and a demo opportunity's title is "[דמו] מדריך: <topic>"
  // (productDraft.js's demoDraft()) — never the bare topic string alone.
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const first = await generateTopicIdea({});
    const second = await generateTopicIdea({ avoidTitles: [`[דמו] מדריך: ${first.topic}`] });
    assert.notEqual(second.topic, first.topic);
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

test('generateTopicIdea cycles back to the first demo idea once all are avoided', async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const allTopics = ['ניהול תזרים מזומנים לעצמאים', 'איך לכתוב הצעת מחיר שמנצחת', 'יסודות תזונה למתאמני כושר חובבים', 'מדריך למעבר דירה ללא לחץ'];
    const result = await generateTopicIdea({ avoidTitles: allTopics });
    assert.equal(result.topic, allTopics[0]);
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});
