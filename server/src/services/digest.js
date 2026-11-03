import { db, makeId } from '../db/store.js';
import { getLedgerSummary, todayKey } from './ledger.js';
import { buildDailyDigest } from '../engine/digest.js';
import { rankOpportunities } from '../engine/ranking.js';
import { computeNetProfit } from '../engine/feasibility.js';
import { getSettings } from './settings.js';

export function generateDailyDigest() {
  const today = todayKey();
  const ledgerSummary = getLedgerSummary();

  const actionsToday = db.actions_log.where((a) => a.createdAt.slice(0, 10) === today && a.result === 'success');
  const failuresToday = db.actions_log
    .where((a) => a.createdAt.slice(0, 10) === today && String(a.result).startsWith('failed'))
    .map((a) => ({ summary: `${a.type}: ${a.detail?.error ?? a.result}` }));

  const openOpportunities = db.opportunities.all()
    // A demo draft (no ANTHROPIC_API_KEY set when it was drafted) can never
    // actually be published for real money (publishing.js refuses it) — it
    // must never be recommended here as if it were a real next action.
    .filter((o) => o.status !== 'published' && o.status !== 'rejected' && !o.productDraft?.demo)
    .map((o) => ({ ...o, netProfitMid: computeNetProfit({ revenueEstimate: o.revenueEstimate, costs: o.costs }).netProfit?.mid ?? null }));
  const ranked = rankOpportunities(openOpportunities);
  // netProfitMid > 0, not just != null - ranking.js's risk/quality/capital/
  // speed factors are all positive multipliers, so for a losing opportunity
  // (netProfitMid < 0) a WORSE risk/quality/speed profile actually makes the
  // score less negative, not more. If every current draft happens to be a
  // net loss (a real possibility whenever costs exceed a low revenue
  // estimate), ranked[0] would then be the single worst one by every other
  // measure - and recommending it anyway as "the next action" would be
  // actively misleading, directly against this app's one promise: never
  // recommend losing money.
  const topOpportunity = ranked[0]?.netProfitMid > 0 ? ranked[0] : null;

  const settings = getSettings();
  const digest = buildDailyDigest({ ledgerSummary, actionsToday, failuresToday, topOpportunity, emergencyStop: settings.emergencyStop, mode: settings.mode });

  // The owner can click "generate now" on the Digests page any number of
  // times in a day on top of the 7am cron run — without this, each click
  // insert()ed a brand-new row, so the "daily" digest list filled up with
  // several near-duplicate entries for the same date instead of the latest
  // one replacing the earlier same-day entry.
  const existing = db.digests.where((d) => d.date === today)[0];
  if (existing) {
    return db.digests.update(existing.id, { text: digest.text, generatedAt: digest.generatedAt });
  }
  return db.digests.insert({ id: makeId('dig'), date: today, text: digest.text, generatedAt: digest.generatedAt });
}
