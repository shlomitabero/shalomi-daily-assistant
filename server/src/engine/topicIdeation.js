// Proposes a candidate digital-product topic to try, for the autonomous
// scan loop. This is an experiment to run, not a demand claim — the
// resulting opportunity still carries revenueEstimate: null until real
// sales data exists, so nothing here counts as fabricated demand.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-5-5';

// Same gap as productDraft.js's draftProduct(): the SDK's own default is
// 10 minutes, retried up to 2 more times on a timeout — so a hung
// connection here could block the autonomous scan's background cron job
// (or the owner's manual "סרוק עכשיו" click) for roughly half an hour
// with zero feedback.
const API_TIMEOUT_MS = 30_000;

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
  // avoidTitles holds full opportunity titles, not bare topics — the real
  // autonomousScan.js caller passes db.opportunities' stored titles, and a
  // demo opportunity's title is "[דמו] מדריך: <topic>" (productDraft.js's
  // demoDraft()), never the bare topic itself. An exact-match .includes(topic)
  // against that never hits, so this always picked DEMO_IDEAS[0] no matter
  // what was already tried — a substring check still finds the topic
  // embedded in the full title, so demo mode actually cycles through all 4.
  const unused = DEMO_IDEAS.find((i) => !avoidTitles.some((title) => title.includes(i.topic))) ?? DEMO_IDEAS[0];
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

export async function generateTopicIdea({ avoidTitles = [], timeoutMs = API_TIMEOUT_MS } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return demoTopicIdea(avoidTitles);

  const client = new Anthropic({ apiKey, timeout: timeoutMs });
  const prompt = buildTopicPrompt({ avoidTitles });
  let msg;
  try {
    msg = await client.messages.create({
      model: MODEL,
      // Same real risk as productDraft.js's equivalent call: claude-sonnet-5-5
      // runs adaptive thinking by default whenever `thinking` is omitted, and
      // that reasoning draws from this same max_tokens budget. 500 was sized
      // only for the tiny visible output ({"topic": "...", "audience": "..."})
      // with zero margin for any reasoning pass at all - on a model that
      // thinks by default, that's a real risk of this call (the autonomous
      // scan's own topic-ideation step, run every 4 hours) silently
      // truncating before it ever reaches the visible JSON, for no reason
      // other than an undersized ceiling. 16000 costs nothing extra unless
      // actually used (billing is by tokens generated, not this ceiling).
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    // The call itself had no guard at all - a raw Anthropic SDK/API error
    // (a timeout, a rate limit, an auth failure, a network error, an
    // overloaded-model error) propagated straight up. autonomousScan.js's
    // own catch around this call returns `{ ran: false, reason: err.message }`
    // verbatim, which Opportunities.jsx shows directly on its manual "סרוק
    // עכשיו" button - untranslated English, inline, in an otherwise
    // all-Hebrew card. Same leak class already fixed for the JSON.parse
    // failure below, and for productDraft.js's equivalent call.
    // console.error here would just duplicate autonomousScan.js's own
    // console.error of this same err right after catching it.
    throw new Error('הבקשה ל-AI נכשלה — בדוק את לוגי השרת לפרטים');
  }
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  let parsed;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    // extractJson falls back to the raw text verbatim when it finds no
    // {...} block at all (a refusal, a truncated response cut off before
    // the opening brace) - JSON.parse on that throws its own raw English
    // SyntaxError. This reaches the owner verbatim as scanResult.reason on
    // Opportunities.jsx's manual "סרוק עכשיו" button (runAutonomousScan's
    // own catch block returns { ran: false, reason: err.message } with no
    // translation layer of its own) - same leak already fixed for
    // productDraft.js's own equivalent JSON.parse call.
    throw new Error('ה-AI החזיר תשובה שאינה JSON תקין — לא הוצע רעיון לנושא');
  }
  if (!isValidTopicIdea(parsed)) {
    // Reaches the owner verbatim as scanResult.reason on Opportunities.jsx's
    // manual "סרוק עכשיו" button (runAutonomousScan's own catch block
    // returns { ran: false, reason: err.message } with no translation
    // layer of its own) - same leak already fixed for productDraft.js's
    // own equivalent error.
    throw new Error('ה-AI החזיר רעיון לנושא עם שדות חסרים (נושא/קהל מטרה)');
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
