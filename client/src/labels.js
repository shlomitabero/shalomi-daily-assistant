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
  publish_product: 'פרסום מוצר',
  sale_confirmed: 'מכירה אומתה',
  paper_trade: 'עסקה מדומה',
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
