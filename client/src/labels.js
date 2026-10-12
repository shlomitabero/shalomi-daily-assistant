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
