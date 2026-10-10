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

// A malformed or incomplete draft (a missing field, salesBullets not an
// array) must never reach the database: it would store fine, but later
// crash a React render with no graceful handling — OpportunityDetail.jsx
// and, worse, the public unauthenticated sales page (ProductPage.jsx) both
// do `salesBullets.map(...)` with no guard, so a real customer landing on
// that product's page to buy it would see a blank crashed page instead.
export function isValidDraftShape(parsed) {
  return Boolean(
    parsed &&
    typeof parsed.title === 'string' && parsed.title.trim() &&
    typeof parsed.guide === 'string' && parsed.guide.trim() &&
    typeof parsed.salesHeadline === 'string' && parsed.salesHeadline.trim() &&
    Array.isArray(parsed.salesBullets) && parsed.salesBullets.length > 0 &&
    parsed.salesBullets.every((b) => typeof b === 'string' && b.trim()) &&
    typeof parsed.salesParagraph === 'string' && parsed.salesParagraph.trim()
  );
}

export async function draftProduct({ topic, audience }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return demoDraft({ topic, audience });

  const client = new Anthropic({ apiKey });
  const prompt = buildProductPrompt({ topic, audience });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const parsed = JSON.parse(extractJson(text));
  if (!isValidDraftShape(parsed)) {
    throw new Error('the AI returned a product draft missing required fields (title/guide/salesHeadline/salesBullets/salesParagraph)');
  }
  return { demo: false, ...parsed };
}

// The model sometimes wraps its JSON in a little prose or markdown fences
// despite being told not to — pull out just the {...} block rather than
// failing outright on a decorated response.
export function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}
