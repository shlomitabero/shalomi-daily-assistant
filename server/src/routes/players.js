import { Router } from 'express';
import { db, makeId } from '../db/store.js';
import { getFullPlayerState, recomputeNetWorthAndRank, addLegacy, pushWorldFeed } from '../services/playerState.js';

export const playersRouter = Router();

const STARTING_CASH = 10_000;
const ARCHETYPES = ['operator', 'investor', 'negotiator', 'builder', 'marketer', 'real_estate_king', 'tech_founder', 'shark'];

playersRouter.post('/players', (req, res) => {
  const { displayName, avatar, city, archetype } = req.body ?? {};
  if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
    return res.status(400).json({ error: 'displayName is required' });
  }
  const userId = makeId('user');
  const profileId = makeId('profile');
  db.users.insert({ id: userId, email: null, created_at: new Date().toISOString(), last_login_at: new Date().toISOString() });
  db.profiles.insert({
    id: profileId,
    user_id: userId,
    display_name: displayName.trim().slice(0, 40),
    avatar: avatar || '🧑‍💼',
    city: city || 'Zero City',
    archetype: ARCHETYPES.includes(archetype) ? archetype : null,
    cash: STARTING_CASH,
    rank: 1,
    age_days: 0,
    created_at: new Date().toISOString(),
  });
  db.reputation.insert({
    profile_id: profileId,
    trust: 50, dealmaking: 50, leadership: 50, execution: 50, innovation: 50, risk: 50, social_impact: 50,
  });
  db.player_rank.insert({ profile_id: profileId, rank: 1, net_worth_at: STARTING_CASH, updated_at: new Date().toISOString() });
  addLegacy(profileId, 'account_created', `${displayName.trim()} started with $10,000 and ambition.`, STARTING_CASH);

  res.status(201).json(getFullPlayerState(profileId));
});

playersRouter.get('/players/:id', (req, res) => {
  const state = getFullPlayerState(req.params.id);
  if (!state) return res.status(404).json({ error: 'player not found' });
  res.json(state);
});

// Trimmed, read-only view for looking at ANOTHER player (world feed, rival
// card) — no cash/loans/reputation detail, just what a rival profile card
// should show.
playersRouter.get('/players/:id/public', (req, res) => {
  const state = getFullPlayerState(req.params.id);
  if (!state) return res.status(404).json({ error: 'player not found' });
  const active = state.businesses.filter((b) => b.stage === 'active');
  res.json({
    displayName: state.profile.display_name,
    avatar: state.profile.avatar,
    city: state.profile.city,
    netWorth: state.profile.netWorth,
    specialization: state.profile.specialization,
    rank: state.rank,
    businessCount: active.length,
    realEstateCount: state.properties.length,
    biggestDeal: db.legacy.where((l) => l.profile_id === req.params.id && l.kind === 'biggest_deal')[0] ?? null,
  });
});

playersRouter.get('/players/:id/legacy', (req, res) => {
  const profile = db.profiles.get(req.params.id);
  if (!profile) return res.status(404).json({ error: 'player not found' });
  const items = db.legacy.where((l) => l.profile_id === req.params.id).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  res.json({ items });
});
