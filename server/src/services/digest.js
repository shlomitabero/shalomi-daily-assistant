import { db, makeId } from '../db/store.js';
import { getLedgerSummary, todayKey } from './ledger.js';
import { buildDailyDigest } from '../engine/digest.js';
import { rankOpportunities } from '../engine/ranking.js';
import { computeNetProfit } from '../engine/feasibility.js';
import { getSettings } from './settings.js';

export function generateDailyDigest(now = new Date()) {
  const today = todayKey(now);
  const ledgerSummary = getLedgerSummary();

  // a.createdAt.slice(0, 10) would read off the UTC calendar date (it's
  // always a plain new Date().toISOString()) while `today` above is now
  // Israel-local - comparing those two directly would silently exclude (or
  // wrongly include) anything logged in the ~2-hour gap between Israel
  // midnight and UTC midnight. todayKey() itself does the Israel-local
  // conversion, so reusing it on each entry's own createdAt keeps both
  // sides of the comparison speaking the same calendar.
  const actionsToday = db.actions_log.where((a) => todayKey(new Date(a.createdAt)) === today && a.result === 'success');
  const failuresToday = db.actions_log
    .where((a) => todayKey(new Date(a.createdAt)) === today && String(a.result).startsWith('failed'))
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

  // "approve" mode never auto-publishes, even once the owner has approved
  // an opportunity — a separate, manual "פרסם מוצר" click on the card
  // itself is still required (mirrors the dashboard's own definition of
  // "approved but not yet acted on"). Without surfacing this count, an
  // approved opportunity could sit unpublished indefinitely with nothing
  // in the daily digest to remind the owner it's one click away.
  const approvedAwaitingPublish = db.approvals
    .where((a) => a.status === 'approved' && a.actionType === 'publish_product')
    .filter((a) => db.opportunities.get(a.opportunityId)?.status === 'draft')
    .length;

  const settings = getSettings();
  const digest = buildDailyDigest({
    ledgerSummary, actionsToday, failuresToday, topOpportunity,
    emergencyStop: settings.emergencyStop, mode: settings.mode, approvedAwaitingPublish,
  });

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

// now.getHours() reads the server process's own local time (UTC on
// Railway, not the owner's) - server.js's '0 7 * * *' cron is scheduled
// with timezone: 'Asia/Jerusalem' for exactly this reason (this app is
// built throughout for a Hebrew-speaking, Israel-based owner), so this
// check has to use the same timezone or the two would disagree about
// when "7am" actually is.
function israelHour(now) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false }).format(now));
}

// node-cron's '0 7 * * *' job only fires while the process happens to be
// alive at the exact minute the clock hits 07:00 Israel time - it does not
// back-fill a tick it missed. This app gets redeployed roughly hourly by
// its own upgrade routine, so any given day's 7am tick has a real chance
// of landing in the middle of exactly one of those restarts and never
// firing at all. Called once at startup, this makes a missed tick
// self-heal on the very next boot instead of silently skipping that day's
// digest - generateDailyDigest() is itself idempotent per day, so calling
// it here is always safe.
export function catchUpDailyDigestIfMissed(now = new Date()) {
  if (israelHour(now) < 7) return null; // too early - the normal 7am cron tick will handle it
  const today = todayKey();
  if (db.digests.where((d) => d.date === today).length > 0) return null; // already generated today
  return generateDailyDigest();
}
