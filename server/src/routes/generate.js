import { Router } from 'express';
import { db, makeId } from '../db/store.js';
import { requireAuth } from '../middleware/auth.js';
import { canGenerate, consumeGeneration, todayKey } from '../engine/usage.js';
import { computeStreakUpdate } from '../engine/streak.js';
import { generateCopy, PROMPT_TYPES, TONES } from '../engine/copy.js';
import { getFullUserState, isUserPaid } from '../services/userState.js';

export const generateRouter = Router();

generateRouter.get('/options', (req, res) => {
  res.json({ promptTypes: Object.keys(PROMPT_TYPES), tones: TONES });
});

generateRouter.post('/generate', requireAuth, async (req, res) => {
  const { promptType, tone, brief } = req.body ?? {};
  if (!PROMPT_TYPES[promptType]) return res.status(400).json({ error: 'unknown promptType' });
  if (!TONES.includes(tone)) return res.status(400).json({ error: 'unknown tone' });
  if (!brief || !brief.trim()) return res.status(400).json({ error: 'brief is required' });

  const user = req.user;
  const today = todayKey();
  const generationsToday = db.generations.where((g) => g.user_id === user.id && g.created_at.slice(0, 10) === today).length;
  const paid = isUserPaid(user.id);

  if (!canGenerate({ isPaid: paid, generationsToday, bonusGenerations: user.bonus_generations })) {
    return res.status(402).json({ error: 'out of free generations today', upgrade: true });
  }

  let result;
  try {
    result = await generateCopy({ promptType, tone, brief: brief.trim() });
  } catch (err) {
    console.error('generateCopy failed', err);
    return res.status(502).json({ error: 'generation failed, try again' });
  }

  const { bonusGenerationsUsed } = consumeGeneration({ isPaid: paid, generationsToday, bonusGenerations: user.bonus_generations });
  if (bonusGenerationsUsed) db.users.update(user.id, { bonus_generations: user.bonus_generations - bonusGenerationsUsed });

  const { streak } = computeStreakUpdate({ lastDate: user.last_generation_date, today, currentStreak: user.streak ?? 0 });
  db.users.update(user.id, { streak, last_generation_date: today });

  const row = db.generations.insert({
    id: makeId('gen'), user_id: user.id, prompt_type: promptType, tone, brief: brief.trim(),
    output: result.text, demo: result.demo, created_at: new Date().toISOString(),
  });

  res.status(201).json({ generation: row, user: getFullUserState(user.id) });
});

generateRouter.get('/history', requireAuth, (req, res) => {
  const items = db.generations
    .where((g) => g.user_id === req.user.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50);
  res.json({ items });
});
