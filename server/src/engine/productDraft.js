// Drafts an actual sellable digital product (a short guide/template) plus
// its sales copy. Falls back to a clearly-labeled demo draft with no
// ANTHROPIC_API_KEY so the whole pipeline is testable without credentials —
// demo output must never be counted as a real product or real revenue.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-5-5';

export function buildProductPrompt({ topic, audience }) {
  return `Write a short, genuinely useful digital guide (600-900 words) on: ${topic}, aimed at: ${audience}. ` +
    `Then write a short sales page for it (headline + 3 bullet benefits + 1 paragraph). ` +
    `Respond as JSON: {"title": "...", "guide": "...", "salesHeadline": "...", "salesBullets": ["...","...","..."], "salesParagraph": "..."}. ` +
    `No preamble, no markdown fences — raw JSON only.`;
}

function demoDraft({ topic, audience }) {
  return {
    demo: true,
    title: `[דמו] מדריך: ${topic}`,
    guide: `זהו תוכן דמו למדריך בנושא "${topic}" עבור ${audience}. חבר ANTHROPIC_API_KEY כדי לקבל תוכן אמיתי שנכתב על ידי AI.`,
    salesHeadline: `[דמו] כל מה שצריך לדעת על ${topic}`,
    salesBullets: ['[דמו] יתרון 1', '[דמו] יתרון 2', '[דמו] יתרון 3'],
    salesParagraph: `[דמו] זהו טקסט מכירה לדוגמה בלבד — לא תוכן אמיתי.`,
  };
}

export async function draftProduct({ topic, audience }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return demoDraft({ topic, audience });

  const client = new Anthropic({ apiKey });
  const prompt = buildProductPrompt({ topic, audience });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const parsed = JSON.parse(text);
  return { demo: false, ...parsed };
}
