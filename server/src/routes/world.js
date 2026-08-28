import { Router } from 'express';
import { db, getMarketState } from '../db/store.js';
import { RANKS } from '../data/ranks.js';
import { ACQUISITION_TARGETS } from '../data/industries.js';
import { getBusinessValuation } from '../services/playerState.js';

export const worldRouter = Router();

worldRouter.get('/ranks', (req, res) => {
  res.json({ ranks: RANKS });
});

worldRouter.get('/feed', (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 40);
  const items = db.world_feed
    .all()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit)
    .map((f) => ({ ...f, playerName: f.profile_id ? db.profiles.get(f.profile_id)?.display_name : null }));
  res.json({ items, market: getMarketState() });
});

const LEADERBOARD_CATEGORIES = ['net_worth', 'best_operator', 'best_investor', 'real_estate'];

worldRouter.get('/leaderboard', (req, res) => {
  const category = LEADERBOARD_CATEGORIES.includes(req.query.category) ? req.query.category : 'net_worth';
  const profiles = db.profiles.all();

  const scored = profiles.map((p) => {
    const rankRow = db.player_rank.get(p.id);
    const businesses = db.businesses.where((b) => b.owner_id === p.id && b.stage === 'active');
    const properties = db.properties.where((pr) => pr.owner_id === p.id);
    let value;
    if (category === 'best_operator') value = businesses.reduce((s, b) => s + getBusinessValuation(b), 0);
    else if (category === 'best_investor') value = db.investments.where((i) => i.investor_id === p.id).length * 1;
    else if (category === 'real_estate') value = properties.reduce((s, pr) => s + pr.value, 0);
    else value = rankRow?.net_worth_at ?? 10000;
    return { profileId: p.id, displayName: p.display_name, avatar: p.avatar, city: p.city, rank: p.rank, value };
  });

  scored.sort((a, b) => b.value - a.value);
  const top = scored.slice(0, 50).map((row, i) => ({ ...row, position: i + 1 }));
  res.json({ category, categories: LEADERBOARD_CATEGORIES, items: top });
});

worldRouter.get('/players/:id/daily-opportunity', (req, res) => {
  const profile = db.profiles.get(req.params.id);
  if (!profile) return res.status(404).json({ error: 'player not found' });
  const ownedTargetIds = new Set(
    db.offers.where((o) => o.buyer_id === profile.id && o.status === 'accepted').map((o) => o.business_id),
  );
  const pool = ACQUISITION_TARGETS.filter((t) => !ownedTargetIds.has(t.id));
  if (!pool.length) return res.json({ opportunity: null });
  const idx = (profile.age_days + hashCode(profile.id)) % pool.length;
  res.json({ opportunity: pool[idx], dayIndex: profile.age_days });
});

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

worldRouter.get('/admin/state', (req, res) => {
  res.json({
    market: getMarketState(),
    counts: {
      profiles: db.profiles.all().length,
      businesses: db.businesses.all().length,
      loans: db.loans.all().length,
      properties: db.properties.all().length,
      worldFeed: db.world_feed.all().length,
    },
    profiles: db.profiles.all(),
  });
});
