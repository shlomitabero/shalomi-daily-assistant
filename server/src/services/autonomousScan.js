import { db } from '../db/store.js';
import { generateTopicIdea } from '../engine/topicIdeation.js';
import { SOURCE_DEFINITIONS, isSourceConnected } from '../engine/sourceDefinitions.js';
import { createDigitalProductOpportunity } from './opportunities.js';
import { publishOpportunity } from './publishing.js';
import { isPaddleConfigured } from './paddle.js';
import { getSettings } from './settings.js';
import { logAction } from './execution.js';

// Caps how many unpublished drafts can pile up before the scan backs off —
// the owner still has to look at them eventually, so this avoids churning
// out drafts nobody will ever review.
const MAX_PENDING_DRAFTS = 5;

// The autonomous "keep looking for revenue" loop: runs on a schedule (and
// can be triggered manually). Only operates on sources that are actually
// connected — there is only one real scanner right now (AI digital
// products); more get added here as more sources get wired up. Publishing
// costs $0 (no ad spend, no COGS), so in auto_limited mode it goes straight
// to a real checkout with no per-action approval — only a real money spend
// ever needs that. In research/approve mode it stops at a draft for the
// owner to review.
export async function runAutonomousScan() {
  const digitalProductsDef = SOURCE_DEFINITIONS.find((d) => d.id === 'ai_digital_products');
  if (!isSourceConnected(digitalProductsDef)) {
    logAction({ type: 'autonomous_scan', detail: { source: 'ai_digital_products' }, result: 'blocked: source not connected' });
    return { ran: false, reason: 'ai_digital_products source is not connected' };
  }

  // A demo draft (created by the owner's manual "new product" form while
  // ANTHROPIC_API_KEY wasn't set) can never be published - publishing.js
  // refuses it - and there's no route to delete an opportunity, so it sits
  // as 'draft' forever. The scan itself can never produce one: this
  // function already can't get past the isSourceConnected check above
  // without ANTHROPIC_API_KEY, so excluding demo drafts here only ever
  // drops old manual-form litter, never anything this loop could pile up
  // on its own.
  const pendingDrafts = db.opportunities.where((o) => o.status === 'draft' && !o.productDraft?.demo).length;
  if (pendingDrafts >= MAX_PENDING_DRAFTS) {
    logAction({ type: 'autonomous_scan', detail: { pendingDrafts }, result: `skipped: ${pendingDrafts} drafts already awaiting review` });
    return { ran: false, reason: `${pendingDrafts} drafts are already awaiting review` };
  }

  const existingTitles = db.opportunities.all().map((o) => o.title);
  let idea;
  try {
    idea = await generateTopicIdea({ avoidTitles: existingTitles });
  } catch (err) {
    logAction({ type: 'autonomous_scan', detail: { error: err.message }, result: 'failed' });
    return { ran: false, reason: err.message };
  }

  let opportunity;
  try {
    opportunity = await createDigitalProductOpportunity({ topic: idea.topic, audience: idea.audience, createdBy: 'autonomous_scan' });
  } catch (err) {
    logAction({ type: 'autonomous_scan', detail: { error: err.message }, result: 'failed' });
    return { ran: false, reason: err.message };
  }

  const settings = getSettings();
  if (settings.mode === 'auto_limited' && isPaddleConfigured()) {
    try {
      await publishOpportunity(opportunity);
      opportunity = db.opportunities.get(opportunity.id);
    } catch (err) {
      // publishOpportunity already logs the failure — this is a background
      // job, not an HTTP request, so there's nothing to respond with; the
      // opportunity just stays a draft for the owner to retry manually.
    }
  }

  // Every other outcome above (not connected, over the draft cap, an AI
  // call failing) logs its own 'autonomous_scan' entry - this success path
  // was the one exception. Filtering the audit log by type 'autonomous_scan'
  // to check "is the scheduled scan actually running" would otherwise show
  // nothing but failures and skips forever, even while it was working
  // perfectly and creating opportunities on every run.
  logAction({ type: 'autonomous_scan', detail: { opportunityId: opportunity.id, published: opportunity.status === 'published' }, result: 'success' });
  return { ran: true, opportunity };
}

const SCAN_INTERVAL_MS = 4 * 60 * 60 * 1000;

// node-cron's '0 */4 * * *' job only fires while the process happens to be
// alive at the exact minute the clock hits one of those hours - it does not
// back-fill a tick it missed. This app gets redeployed roughly hourly by
// its own upgrade routine, so a scan could go well past its normal 4-hour
// cadence if a restart keeps landing near that exact minute. Called once at
// startup: if the last logged 'autonomous_scan' entry (now logged on every
// outcome, including success) is more than 4 hours old or there is none at
// all, run a scan immediately instead of waiting out the rest of the gap.
export async function catchUpAutonomousScanIfMissed(now = new Date()) {
  const lastScan = db.actions_log
    .where((a) => a.type === 'autonomous_scan')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (lastScan && now - new Date(lastScan.createdAt) < SCAN_INTERVAL_MS) return null;
  return runAutonomousScan();
}
