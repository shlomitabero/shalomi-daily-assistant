import { db } from '../db/store.js';
import { generateTopicIdea } from '../engine/topicIdeation.js';
import { SOURCE_DEFINITIONS, isSourceConnected } from '../engine/sourceDefinitions.js';
import { createDigitalProductOpportunity, pendingDraftCount, MAX_PENDING_DRAFTS } from './opportunities.js';
import { publishOpportunity } from './publishing.js';
import { isPaddleConfigured } from './paddle.js';
import { getSettings } from './settings.js';
import { logAction } from './execution.js';

// The autonomous "keep looking for revenue" loop: runs on a schedule (and
// can be triggered manually). Only operates on sources that are actually
// connected — there is only one real scanner right now (AI digital
// products); more get added here as more sources get wired up. Publishing
// costs $0 (no ad spend, no COGS), so in auto_limited mode it goes straight
// to a real checkout with no per-action approval — only a real money spend
// ever needs that. In research/approve mode it stops at a draft for the
// owner to review.
// server.js calls catchUpAutonomousScanIfMissed() once at startup AND
// registers the '0 */4 * * *' cron tick in the same process - a redeploy
// landing within a few seconds of one of those 4-hour boundaries (this app
// redeploys roughly hourly, so this isn't a hypothetical over enough
// deploys) could have both fire a real scan nearly simultaneously before
// either call's pendingDraftCount() read reflects the other's write,
// doubling a real, billed AI call and drafting two opportunities where
// MAX_PENDING_DRAFTS meant to allow one. This in-process flag is enough to
// close that specific race (both triggers run in the same Node process;
// there is no multi-instance deployment here to coordinate across).
let scanInProgress = false;

export async function runAutonomousScan() {
  if (scanInProgress) {
    return { ran: false, reason: 'סריקה אחרת כבר רצה באותו רגע בדיוק — נסה שוב בעוד רגע' };
  }
  scanInProgress = true;
  try {
    return await runAutonomousScanOnce();
  } finally {
    scanInProgress = false;
  }
}

async function runAutonomousScanOnce() {
  const digitalProductsDef = SOURCE_DEFINITIONS.find((d) => d.id === 'ai_digital_products');
  if (!isSourceConnected(digitalProductsDef)) {
    logAction({ type: 'autonomous_scan', detail: { source: 'ai_digital_products' }, result: 'blocked: source not connected' });
    // This reason string (unlike the logAction result above, which
    // autonomousScanSummary() in the client already translates) reaches
    // the owner directly as scanResult.reason on Opportunities.jsx's
    // manual "סרוק עכשיו" button, with no translation layer of its own -
    // was raw English dropped straight into that page's Hebrew feedback.
    return { ran: false, reason: 'המקור "מוצרים דיגיטליים מבוססי AI" לא מחובר' };
  }

  const pendingDrafts = pendingDraftCount();
  if (pendingDrafts >= MAX_PENDING_DRAFTS) {
    logAction({ type: 'autonomous_scan', detail: { pendingDrafts }, result: `skipped: ${pendingDrafts} drafts already awaiting review` });
    return { ran: false, reason: `${pendingDrafts} הזדמנויות כבר ממתינות לסקירה שלך` };
  }

  // Every opportunity ever created (published, rejected, and demo alike)
  // stays in this list forever - after months of real use, sending the
  // ENTIRE lifetime history as "avoid these" on every single scan call
  // would make the prompt (and so the real AI cost) grow without bound,
  // and eventually risk hitting a token limit that turns into a plain
  // 'failed' scan with no indication why. The AI only needs recent history
  // to dodge a near-term repeat, not everything the app has ever tried -
  // capped at the 50 most recently created, newest first so the actual
  // near-duplicates (not whatever happened to load first) are the ones
  // that survive the cap.
  const MAX_AVOID_TITLES = 50;
  const existingTitles = db.opportunities.all()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, MAX_AVOID_TITLES)
    .map((o) => o.title);
  let idea;
  try {
    idea = await generateTopicIdea({ avoidTitles: existingTitles });
  } catch (err) {
    // logAction alone only ever reached the in-app activity log - a real
    // failure here (an invalid/expired ANTHROPIC_API_KEY, a rate limit, a
    // network error) would otherwise be completely invisible in Railway's
    // own log viewer, the first place anyone actually debugging "the scan
    // isn't producing anything" would look, long before logging into the
    // app itself to check the activity log.
    console.error('autonomous scan: generateTopicIdea failed', err);
    logAction({ type: 'autonomous_scan', detail: { error: err.message }, result: 'failed' });
    return { ran: false, reason: err.message };
  }

  let opportunity;
  try {
    opportunity = await createDigitalProductOpportunity({ topic: idea.topic, audience: idea.audience, createdBy: 'autonomous_scan' });
  } catch (err) {
    console.error('autonomous scan: createDigitalProductOpportunity failed', err);
    logAction({ type: 'autonomous_scan', detail: { error: err.message }, result: 'failed' });
    return { ran: false, reason: err.message };
  }

  const settings = getSettings();
  if (settings.mode === 'auto_limited' && isPaddleConfigured()) {
    try {
      await publishOpportunity(opportunity);
      opportunity = db.opportunities.get(opportunity.id);
    } catch (err) {
      // publishOpportunity already logs the failure to the in-app activity
      // log — this is a background job, not an HTTP request, so there's
      // nothing to respond with; the opportunity just stays a draft for
      // the owner to retry manually. Still worth a console.error though:
      // a real Paddle outage here would otherwise be invisible in
      // Railway's own log viewer, the first place anyone debugging
      // "auto_limited isn't publishing anything" would actually look.
      console.error('autonomous scan: auto-publish failed, opportunity remains a draft', err);
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
