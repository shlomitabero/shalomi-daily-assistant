// Aggregates the many tables in store.js into the views the client needs,
// and owns the cross-cutting rules that don't belong to a single route:
// net worth / rank recomputation, legacy milestones, million moments, and
// world feed writes. Nothing here trusts client-provided money figures —
// everything is recomputed server-side from stored rows.
import { db, makeId } from '../db/store.js';
import { valuation, computeNetWorth } from '../engine/economy.js';
import { rankForNetWorth, nextRank, MILLION_MOMENTS } from '../data/ranks.js';
import { inferSpecialization } from '../engine/specialization.js';

export function getBusinessValuation(business) {
  if (business.stage !== 'active') return 0;
  const financials = db.business_financials
    .where((f) => f.business_id === business.id)
    .sort((a, b) => a.period - b.period)
    .slice(-30);
  return Math.round((valuation(business, financials) * business.ownership_pct) / 100);
}

export function recomputeNetWorthAndRank(profileId) {
  const profile = db.profiles.get(profileId);
  if (!profile) return null;

  const businesses = db.businesses.where((b) => b.owner_id === profileId && b.stage === 'active');
  const businessValuations = businesses.map(getBusinessValuation);

  const crown = businesses.find((b, i) => businessValuations[i] >= 100_000_000);
  if (crown) addLegacy(profileId, 'first_100m_company', `${crown.name} became a $100M+ company.`, 100_000_000);

  const properties = db.properties.where((p) => p.owner_id === profileId);
  const propertyValues = properties.map((p) => p.value);

  const investments = db.investments.where((i) => i.investor_id === profileId);
  const investmentValues = investments.map((inv) => {
    const biz = db.businesses.get(inv.business_id);
    if (!biz || biz.stage !== 'active') return 0;
    const financials = db.business_financials.where((f) => f.business_id === biz.id).slice(-30);
    return Math.round((valuation(biz, financials) * inv.stake_pct) / 100);
  });

  const loans = db.loans.where((l) => l.profile_id === profileId && l.status === 'active');
  const loanBalances = loans.map((l) => l.balance);

  const netWorth = computeNetWorth({
    cash: profile.cash,
    businessValuations,
    propertyValues,
    loanBalances,
    investmentValues,
  });

  const rankRow = db.player_rank.get(profileId);
  const prevNetWorth = rankRow ? rankRow.net_worth_at : 10000;
  const rank = rankForNetWorth(netWorth);
  const rankedUp = rank.rank > (rankRow?.rank ?? 1);

  if (rankRow) {
    db.player_rank.update(profileId, { rank: rank.rank, net_worth_at: netWorth, updated_at: new Date().toISOString() });
  } else {
    db.player_rank.insert({ profile_id: profileId, rank: rank.rank, net_worth_at: netWorth, updated_at: new Date().toISOString() });
  }
  if (profile.rank !== rank.rank) db.profiles.update(profileId, { rank: rank.rank });

  const millionMatch = MILLION_MOMENTS.find((m) => prevNetWorth < m.amount && netWorth >= m.amount);
  let million = null;
  if (millionMatch) {
    addLegacy(profileId, `milestone_${millionMatch.amount}`, millionMatch.label, netWorth);
    pushWorldFeed(`${profile.display_name} just crossed $${formatCompact(millionMatch.amount)} net worth.`, profileId, 'milestone', netWorth);
    const firstCompany = db.legacy.where((l) => l.profile_id === profileId && l.kind === 'first_company')[0];
    million = {
      ...millionMatch,
      daysToReach: profile.age_days,
      firstBusiness: firstCompany?.headline ?? null,
      businessCount: db.businesses.where((b) => b.owner_id === profileId && b.stage === 'active').length,
    };
  }

  const othersMax = Math.max(0, ...db.player_rank.all().filter((r) => r.profile_id !== profileId).map((r) => r.net_worth_at));
  if (netWorth > 0 && netWorth >= othersMax) {
    const isFirstTime = !db.legacy.where((l) => l.profile_id === profileId && l.kind === 'reached_number_1').length;
    addLegacy(profileId, 'reached_number_1', `${profile.display_name} reached #1 in the world by net worth.`, netWorth);
    if (isFirstTime) pushWorldFeed(`${profile.display_name} is the new #1 in the world.`, profileId, 'milestone', netWorth);
  }

  return { netWorth, rank, rankedUp, nextRank: nextRank(rank.rank), million };
}

export function addLegacy(profileId, kind, headline, amount = null) {
  const existing = db.legacy.where((l) => l.profile_id === profileId && l.kind === kind);
  if (existing.length) return existing[0];
  return db.legacy.insert({
    id: makeId('legacy'),
    profile_id: profileId,
    kind,
    headline,
    amount,
    created_at: new Date().toISOString(),
  });
}

// For "biggest deal", "biggest loss", "best investment" — records that only
// get overwritten by a bigger one, never duplicated or shrunk.
export function recordIfBigger(profileId, kind, headline, amount) {
  const existing = db.legacy.where((l) => l.profile_id === profileId && l.kind === kind)[0];
  if (!existing) {
    return db.legacy.insert({ id: makeId('legacy'), profile_id: profileId, kind, headline, amount, created_at: new Date().toISOString() });
  }
  if (amount > existing.amount) {
    return db.legacy.update(existing.id, { headline, amount, created_at: new Date().toISOString() });
  }
  return existing;
}

export function pushWorldFeed(headline, profileId, kind, amount = null) {
  return db.world_feed.insert({
    id: makeId('feed'),
    headline,
    profile_id: profileId,
    kind,
    amount,
    created_at: new Date().toISOString(),
  });
}

export function formatCompact(n) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000_000) return (n / 1_000_000_000_000).toFixed(1) + 'T';
  if (abs >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function getFullPlayerState(profileId) {
  const profile = db.profiles.get(profileId);
  if (!profile) return null;
  const reputation = db.reputation.get(profileId);
  const { netWorth, rank, nextRank: nr } = recomputeNetWorthAndRank(profileId);

  const businesses = db.businesses.where((b) => b.owner_id === profileId).map((b) => ({
    ...b,
    valuation: b.stage === 'active' ? getBusinessValuation(b) : 0,
    latestFinancials: db.business_financials.where((f) => f.business_id === b.id).slice(-1)[0] ?? null,
    employeeCount: db.employees.where((e) => e.business_id === b.id && !e.terminated_at).length,
  }));

  const loans = db.loans.where((l) => l.profile_id === profileId);
  const properties = db.properties.where((p) => p.owner_id === profileId);
  const investments = db.investments.where((i) => i.investor_id === profileId);
  const unresolvedEvents = db.events.where((e) => e.profile_id === profileId && !e.resolved);

  const specialization = inferSpecialization({
    acquisitions: businesses.filter((b) => b.origin === 'acquired').length,
    organicBusinesses: businesses.filter((b) => b.origin === 'founded').length,
    investments: investments.length,
    properties: properties.length,
  });

  return {
    profile: { ...profile, netWorth, specialization },
    reputation,
    rank,
    nextRank: nr,
    businesses,
    loans,
    properties,
    investments,
    alerts: unresolvedEvents.length,
    events: unresolvedEvents,
  };
}
