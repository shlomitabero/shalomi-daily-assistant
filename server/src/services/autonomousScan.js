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

  const pendingDrafts = db.opportunities.where((o) => o.status === 'draft').length;
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

  return { ran: true, opportunity };
}
