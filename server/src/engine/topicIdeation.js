// Proposes a candidate digital-product topic to try, for the autonomous
// scan loop. This is an experiment to run, not a demand claim — the
// resulting opportunity still carries revenueEstimate: null until real
// sales data exists, so nothing here counts as fabricated demand.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-5-5';

export function buildTopicPrompt({ avoidTitles = [] }) {
  const avoid = avoidTitles.length ? ` Avoid repeating these already-tried topics: ${avoidTitles.join('; ')}.` : '';
  return `Propose ONE specific, practical topic for a short paid digital guide (a how-to or reference) that people commonly search for and would plausibly pay a few dollars for.${avoid} ` +
    `Respond as JSON only: {"topic": "...", "audience": "..."}. No preamble, no markdown fences — raw JSON only.`;
}

const DEMO_IDEAS = [
  { topic: 'ניהול תזרים מזומנים לעצמאים', audience: 'עצמאים ופרילנסרים' },
  { topic: 'איך לכתוב הצעת מחיר שמנצחת', audience: 'בעלי עסקים קטנים' },
  { topic: 'יסודות תזונה למתאמני כושר חובבים', audience: 'מתאמנים חובבים' },
  { topic: 'מדריך למעבר דירה ללא לחץ', audience: 'משפחות צעירות' },
];

function demoTopicIdea(avoidTitles) {
  const unused = DEMO_IDEAS.find((i) => !avoidTitles.includes(i.topic)) ?? DEMO_IDEAS[0];
  return { ...unused, demo: true };
}

// An empty/missing topic or audience here wouldn't crash anything — it
// would silently flow into createDigitalProductOpportunity() and produce a
// real, stored opportunity literally built around "undefined" (the prompt
// to the next AI call would read "...guide on: undefined, aimed at:
// undefined"). This is the one path with no human reviewing the input
// before it's used (the manual /opportunities/digital-product route
// validates topic/audience; this autonomous one previously didn't), so a
// malformed idea here is the one most likely to go completely unnoticed.
export function isValidTopicIdea(parsed) {
  return Boolean(
    parsed &&
    typeof parsed.topic === 'string' && parsed.topic.trim() &&
    typeof parsed.audience === 'string' && parsed.audience.trim()
  );
}

export async function generateTopicIdea({ avoidTitles = [] } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return demoTopicIdea(avoidTitles);

  const client = new Anthropic({ apiKey });
  const prompt = buildTopicPrompt({ avoidTitles });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const parsed = JSON.parse(extractJson(text));
  if (!isValidTopicIdea(parsed)) {
    throw new Error('the AI returned a topic idea missing topic/audience');
  }
  return { ...parsed, demo: false };
}

// The model sometimes wraps its JSON in a little prose or markdown fences
// despite being told not to — pull out just the {...} block rather than
// failing outright on a truncated or decorated response.
export function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}
