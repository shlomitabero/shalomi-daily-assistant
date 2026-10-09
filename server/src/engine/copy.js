// The actual product: AI-generated marketing copy. Calls the Claude API
// when ANTHROPIC_API_KEY is configured; falls back to a deterministic
// template generator otherwise so the whole app — signup, paywall,
// referrals, billing — is fully testable and demoable with zero external
// credentials. The fallback is clearly labeled to the user, never silently
// passed off as real AI output.
import Anthropic from '@anthropic-ai/sdk';

export const PROMPT_TYPES = {
  ad_copy: 'a short, punchy ad headline + body (for Facebook/Instagram/Google ads)',
  product_description: 'a persuasive e-commerce product description',
  social_caption: 'a social media caption with relevant hashtags',
  email_subject: '5 email subject line options designed for a high open rate',
};

export const TONES = ['professional', 'playful', 'bold', 'luxury', 'friendly'];

export function buildPrompt({ promptType, tone, brief }) {
  const typeDesc = PROMPT_TYPES[promptType] ?? PROMPT_TYPES.ad_copy;
  return `Write ${typeDesc}. Tone: ${tone}. Give exactly 3 distinct variations, numbered 1-3, no preamble or explanation — just the copy itself.\n\nWhat this is for:\n${brief}`;
}

function generateDemoCopy({ promptType, tone, brief }) {
  const subject = brief.trim().slice(0, 60) || 'your product';
  const toneWord = { professional: 'Reliable.', playful: 'Fun, finally.', bold: 'No compromises.', luxury: 'Effortlessly refined.', friendly: 'Made for you.' }[tone] ?? 'Simple. Done right.';
  const variants = [
    `1. ${subject} — ${toneWord}`,
    `2. Meet ${subject}. ${toneWord} Try it today.`,
    `3. Why settle? ${subject} delivers. ${toneWord}`,
  ];
  return {
    text: variants.join('\n\n'),
    demo: true,
  };
}

const MODEL = 'claude-sonnet-5-5';

export async function generateCopy({ promptType, tone, brief }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return generateDemoCopy({ promptType, tone, brief });

  const client = new Anthropic({ apiKey });
  const prompt = buildPrompt({ promptType, tone, brief });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return { text, demo: false };
}
