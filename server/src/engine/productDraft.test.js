import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProductPrompt, draftProduct } from './productDraft.js';

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
