import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTopicPrompt, generateTopicIdea, isValidTopicIdea } from './topicIdeation.js';

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
