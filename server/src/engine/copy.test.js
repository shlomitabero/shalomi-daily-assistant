import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, generateCopy, PROMPT_TYPES, TONES } from './copy.js';

test('buildPrompt includes the brief and tone and asks for exactly 3 variations', () => {
  const prompt = buildPrompt({ promptType: 'ad_copy', tone: 'bold', brief: 'eco-friendly water bottles' });
  assert.match(prompt, /eco-friendly water bottles/);
  assert.match(prompt, /Tone: bold/);
  assert.match(prompt, /3 distinct variations/);
});

test('buildPrompt falls back to ad_copy wording for an unknown promptType', () => {
  const prompt = buildPrompt({ promptType: 'nonsense', tone: 'friendly', brief: 'x' });
  assert.match(prompt, /ad headline/);
});

test('every declared prompt type and tone is usable in buildPrompt', () => {
  for (const promptType of Object.keys(PROMPT_TYPES)) {
    for (const tone of TONES) {
      const prompt = buildPrompt({ promptType, tone, brief: 'test brief' });
      assert.equal(typeof prompt, 'string');
      assert.ok(prompt.length > 0);
    }
  }
});

test('generateCopy falls back to demo mode with no ANTHROPIC_API_KEY, labeled as demo', async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await generateCopy({ promptType: 'social_caption', tone: 'playful', brief: 'a new coffee shop' });
    assert.equal(result.demo, true);
    assert.match(result.text, /1\./);
    assert.match(result.text, /2\./);
    assert.match(result.text, /3\./);
    assert.match(result.text, /coffee shop/);
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});
