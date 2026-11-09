// Drafts an actual sellable digital product (a short guide/template) plus
// its sales copy. Falls back to a clearly-labeled demo draft with no
// ANTHROPIC_API_KEY so the whole pipeline is testable without credentials —
// demo output must never be counted as a real product or real revenue.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-5-5';

// The SDK's own default is 10 minutes, retried up to 2 more times on a
// timeout — so a hung connection to the API could otherwise leave this
// pending for roughly half an hour with zero feedback, whether it's the
// owner's manual "new digital product" click or the autonomous scan's
// background job. 30s is generous for an actual generation call while
// still failing with a clear error instead of hanging indefinitely.
const API_TIMEOUT_MS = 30_000;

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

export async function draftProduct({ topic, audience, timeoutMs = API_TIMEOUT_MS }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return demoDraft({ topic, audience });

  const client = new Anthropic({ apiKey, timeout: timeoutMs });
  const prompt = buildProductPrompt({ topic, audience });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  let parsed;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    // extractJson falls back to the raw text verbatim when it finds no
    // {...} block at all (e.g. the model ignores the "raw JSON only"
    // instruction and answers in plain prose) - JSON.parse on that throws
    // its own raw English SyntaxError. Unlike the isValidDraftShape
    // failure right below, which routes/opportunities.js's manual "new
    // digital product" form already shows translated, this one reached
    // the owner as untranslated English dropped into that same
    // otherwise all-Hebrew error line.
    throw new Error('ה-AI החזיר תשובה שאינה JSON תקין — טיוטת מוצר לא נוצרה');
  }
  if (!isValidDraftShape(parsed)) {
    // Reaches the owner verbatim: routes/opportunities.js's manual
    // "new digital product" form shows this exact err.message, and
    // autonomousScan.js's own 'failed' entries point the owner at the
    // server logs instead of showing this directly - but the manual
    // route had no such wrapper, so this was raw English dropped
    // straight into that otherwise all-Hebrew form's error line.
    throw new Error('ה-AI החזיר טיוטת מוצר עם שדות חסרים (כותרת/מדריך/כותרת מכירה/יתרונות/פסקת מכירה)');
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
