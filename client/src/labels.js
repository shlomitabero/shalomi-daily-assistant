// A plain `${n.toFixed(2)}` puts the minus sign AFTER the dollar sign for a
// negative value ("$-45.50" instead of "-$45.50") - a real, reachable case
// now that revenueEstimate.low is explicitly allowed to be negative (a
// coherent worst-case loss scenario), and net profit (today, all-time, or
// per-opportunity) can go negative any time costs exceed revenue. Mirrors
// engine/digest.js's formatMoney on the server for the exact same reason.
export function formatMoney(n, decimals = 2) {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(decimals)}`;
}

// Shared Hebrew labels for the raw action-type codes the server logs
// (services/execution.js logAction calls) — without this, the activity
// log and the approvals page showed codes like "publish_product" or
// "autonomous_scan" verbatim, English snake_case dropped into an
// otherwise all-Hebrew app.
export const ACTION_TYPE_LABEL = {
  draft_product: 'יצירת טיוטת מוצר',
  autonomous_scan: 'סריקה אוטונומית',
  approve: 'אישור פעולה',
  reject: 'ביטול אישור',
  reject_opportunity: 'דחיית הזדמנות',
  publish_product: 'פרסום מוצר',
  sale_confirmed: 'מכירה אומתה',
  paper_trade: 'עסקה מדומה',
  client_error: 'תקלה במסך',
};

export function actionTypeLabel(type) {
  return ACTION_TYPE_LABEL[type] ?? type;
}

// logAction's `result` field is always a string that starts with one of
// these English words, sometimes followed by a free-text detail (which may
// itself already be Hebrew, e.g. the gate/budget block reasons). Only the
// leading word is translated here — rewriting every ad-hoc detail string
// across the codebase is a bigger change than this touches.
const RESULT_PREFIX_LABEL = { success: 'הצלחה', failed: 'נכשל', blocked: 'נחסם', skipped: 'הודלג' };

export function resultLabel(result) {
  if (typeof result !== 'string') return result;
  const [prefix, ...rest] = result.split(': ');
  const label = RESULT_PREFIX_LABEL[prefix];
  if (!label) return result;
  return rest.length ? `${label}: ${rest.join(': ')}` : label;
}

// riskLevel ('low'/'medium'/'high') already had a Hebrew <select> in
// OpportunityDetail's edit form, but the opportunities list rendered the
// same raw English value as plain text right next to it.
const RISK_LEVEL_LABEL = { low: 'נמוכה', medium: 'בינונית', high: 'גבוהה' };

export function riskLevelLabel(level) {
  return RISK_LEVEL_LABEL[level] ?? level;
}

// Paper-trade side ('long'/'short') already had a Hebrew <select> on the
// Financial page's trade form, but the trade history list below it showed
// the same raw English value next to the symbol.
const SIDE_LABEL = { long: 'לונג', short: 'שורט' };

export function sideLabel(side) {
  return SIDE_LABEL[side] ?? side;
}

// opportunity.status ('draft'/'published'/'rejected') already had a Hebrew
// badge on the opportunities list, but the opportunity detail page showed
// the raw English value in its own header line.
const OPPORTUNITY_STATUS_LABEL = { draft: 'טיוטה', published: 'פורסם', rejected: 'נדחה' };

export function opportunityStatusLabel(status) {
  return OPPORTUNITY_STATUS_LABEL[status] ?? status;
}

// opportunity.source is a SOURCE_DEFINITIONS id (server/src/engine/
// sourceDefinitions.js) — the opportunity detail page showed this raw
// snake_case id instead of the source's real Hebrew name.
const SOURCE_LABEL = {
  ai_digital_products: 'מוצרים דיגיטליים מבוססי AI',
  financial_markets: 'שווקים פיננסיים',
  affiliate_programs: 'שיווק שותפים ותוכניות תגמול',
  supplier_price_gaps: 'פערי מחירים בין ספקים',
  tenders_rfps: 'מכרזים ובקשות הצעות מחיר',
};

export function sourceLabel(source) {
  return SOURCE_LABEL[source] ?? source;
}

// opportunity.feasibility.missing (engine/feasibility.js) is a list of raw
// field keys ('revenueEstimate', 'cost:paymentProcessing') — OpportunityDetail
// showed this verbatim ("חסר מידע: revenueEstimate, cost:paymentProcessing"),
// English technical keys dropped into an otherwise all-Hebrew explanation
// with no indication of what they mean or what to do about them.
const MISSING_FIELD_LABEL = {
  revenueEstimate: 'הערכת הכנסה — אין ביקוש אמיתי מחובר, יש להזין הערכה משלך',
};
const MISSING_COST_LABEL = {
  aiUsage: 'עלות AI',
  paymentProcessing: 'עמלת סליקה',
};

// logAction's detail.reason is a free-text technical reason, written in
// English in the one place that currently populates it (opportunities.js's
// stale-approval invalidation) — the activity log showed only the action
// type and "success", with no way to tell an automatic price-change
// rejection apart from the owner manually clicking reject on the same
// opportunity, which logs identically with no reason at all.
const REASON_LABEL = {
  'price changed after approval': 'האישור בוטל אוטומטית — המחיר השתנה אחרי שאושר',
  'opportunity was rejected': 'האישור בוטל אוטומטית — ההזדמנות נדחתה',
};

export function reasonLabel(reason) {
  return REASON_LABEL[reason] ?? reason;
}

// Turns one 'autonomous_scan' actions_log entry (server/src/services/
// autonomousScan.js's logAction calls) into a plain Hebrew sentence. The
// raw result strings ('success', 'blocked: source not connected',
// 'skipped: N drafts already awaiting review', 'failed') are exactly what
// the activity log already shows via resultLabel, but that owner would
// have to go dig through the full (unrelated-actions-mixed-in) activity
// log to find the one entry that actually answers "is my scanner
// working" - this gives the Opportunities page's own scan card the same
// answer directly, in the one place someone asking that question would
// actually look.
export function autonomousScanSummary(action) {
  if (!action) return 'עדיין לא רצה סריקה אוטונומית.';
  const { result, detail } = action;
  if (result === 'success') {
    return detail?.published ? 'נוצרה הזדמנות חדשה ופורסמה אוטומטית.' : 'נוצרה הזדמנות חדשה (טיוטה, מחכה לסקירה שלך).';
  }
  if (typeof result === 'string' && result.startsWith('blocked: source not connected')) {
    return 'המקור "מוצרים דיגיטליים מבוססי AI" לא מחובר — ראה עמוד "מקורות הכנסה".';
  }
  if (typeof result === 'string' && result.startsWith('skipped:')) {
    return `הסריקה הושהתה — ${result.slice('skipped: '.length)}.`;
  }
  if (typeof result === 'string' && result.startsWith('failed')) {
    return `נכשלה: ${detail?.error ?? result}.`;
  }
  return resultLabel(result);
}

export function missingFieldLabel(field) {
  if (MISSING_FIELD_LABEL[field]) return MISSING_FIELD_LABEL[field];
  if (field.startsWith('cost:')) {
    const costKey = field.slice('cost:'.length);
    // A cost field this mapping doesn't know about yet (future addition)
    // still shows its real key rather than a fabricated Hebrew phrase —
    // honest and ungraceful beats a wrong-sounding translation.
    return `${MISSING_COST_LABEL[costKey] ?? costKey} — לא ידוע עדיין`;
  }
  return field;
}
