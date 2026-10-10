import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProductPrompt, draftProduct, extractJson, isValidDraftShape } from './productDraft.js';

const VALID_DRAFT = {
  title: 'מדריך תקציב', guide: 'תוכן המדריך כאן', salesHeadline: 'כותרת מכירה',
  salesBullets: ['יתרון 1', 'יתרון 2', 'יתרון 3'], salesParagraph: 'פסקת מכירה',
};

test('isValidDraftShape accepts a complete draft', () => {
  assert.equal(isValidDraftShape(VALID_DRAFT), true);
});

test('isValidDraftShape rejects a draft missing salesBullets entirely', () => {
  // ProductPage.jsx (the public, unauthenticated sales page) does
  // salesBullets.map(...) with no guard — a missing field here would crash
  // that page for a real customer trying to buy, not just log an error.
  const { salesBullets, ...withoutBullets } = VALID_DRAFT;
  assert.equal(isValidDraftShape(withoutBullets), false);
});

test('isValidDraftShape rejects salesBullets that is not an array', () => {
  assert.equal(isValidDraftShape({ ...VALID_DRAFT, salesBullets: 'not an array' }), false);
});

test('isValidDraftShape rejects an empty salesBullets array', () => {
  assert.equal(isValidDraftShape({ ...VALID_DRAFT, salesBullets: [] }), false);
});

test('isValidDraftShape rejects a blank title', () => {
  assert.equal(isValidDraftShape({ ...VALID_DRAFT, title: '   ' }), false);
});

test('isValidDraftShape rejects null/undefined input', () => {
  assert.equal(isValidDraftShape(null), false);
  assert.equal(isValidDraftShape(undefined), false);
});

test('buildProductPrompt includes the topic and audience and asks for raw JSON', () => {
  const prompt = buildProductPrompt({ topic: 'personal budgeting', audience: 'freelancers' });
  assert.match(prompt, /personal budgeting/);
  assert.match(prompt, /freelancers/);
  assert.match(prompt, /raw JSON only/);
});

test('draftProduct falls back to a clearly-labeled demo draft with no ANTHROPIC_API_KEY', async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await draftProduct({ topic: 'עבודה מהבית', audience: 'הורים טריים' });
    assert.equal(result.demo, true);
    assert.match(result.title, /\[דמו\]/);
    assert.match(result.guide, /עבודה מהבית/);
    assert.ok(Array.isArray(result.salesBullets) && result.salesBullets.length === 3);
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

test('extractJson strips prose the model adds despite being told not to', () => {
  const text = 'Sure, here is the JSON:\n{"title": "x"}\nLet me know if you need anything else!';
  assert.equal(extractJson(text), '{"title": "x"}');
});

test('extractJson strips markdown code fences around the JSON', () => {
  const text = '```json\n{"title": "x"}\n```';
  assert.equal(extractJson(text), '{"title": "x"}');
});

test('extractJson returns the raw text unchanged when there is no JSON object to find', () => {
  assert.equal(extractJson('not json at all'), 'not json at all');
});
