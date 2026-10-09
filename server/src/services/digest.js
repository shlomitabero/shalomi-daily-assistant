import { db, makeId } from '../db/store.js';
import { getLedgerSummary, todayKey } from './ledger.js';
import { buildDailyDigest } from '../engine/digest.js';
import { rankOpportunities } from '../engine/ranking.js';
import { computeNetProfit } from '../engine/feasibility.js';

export function generateDailyDigest() {
  const today = todayKey();
  const ledgerSummary = getLedgerSummary();

  const actionsToday = db.actions_log.where((a) => a.createdAt.slice(0, 10) === today && a.result === 'success');
  const failuresToday = db.actions_log
    .where((a) => a.createdAt.slice(0, 10) === today && String(a.result).startsWith('failed'))
    .map((a) => ({ summary: `${a.type}: ${a.detail?.error ?? a.result}` }));

  const openOpportunities = db.opportunities.all()
    .filter((o) => o.status !== 'published' && o.status !== 'rejected')
    .map((o) => ({ ...o, netProfitMid: computeNetProfit({ revenueEstimate: o.revenueEstimate, costs: o.costs }).netProfit?.mid ?? null }));
  const ranked = rankOpportunities(openOpportunities);
  const topOpportunity = ranked[0]?.netProfitMid != null ? ranked[0] : null;

  const digest = buildDailyDigest({ ledgerSummary, actionsToday, failuresToday, topOpportunity });
  return db.digests.insert({ id: makeId('dig'), date: today, text: digest.text, generatedAt: digest.generatedAt });
}
