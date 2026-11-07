// Builds the daily summary: net profit, what ran, what broke, and what to
// do next. Pure text assembly so it's testable without a scheduler.
export function buildDailyDigest({
  ledgerSummary, actionsToday = [], failuresToday = [], topOpportunity = null, emergencyStop = false, mode = null,
  approvedAwaitingPublish = 0, budget = null, budgetConfigured = false, maxLoss = null,
  scanPaused = false, pendingDrafts = 0, unrecordedSales = 0,
}) {
  // Dashboard.jsx warns the owner in the app itself once spentSoFar/
  // lossSoFar reaches 80% of budget/maxLoss - but the whole point of a
  // daily digest is reaching the owner without them having to go check,
  // so without this an owner who only reads the digest (not the
  // dashboard) would have no warning at all until a real action actually
  // got blocked by canSpend()'s gate.
  const budgetRatio = budgetConfigured && budget > 0 ? ledgerSummary.spentSoFar / budget : null;
  const maxLossRatio = maxLoss > 0 ? ledgerSummary.lossSoFar / maxLoss : null;
  const lines = [
    `רווח נטו מאומת היום: ${formatMoney(ledgerSummary.netProfitToday)}`,
    `נכנס בפועל: ${formatMoney(ledgerSummary.cashInToday)} | יצא בפועל: ${formatMoney(ledgerSummary.cashOutToday)}`,
    ...(budgetRatio != null && budgetRatio >= 0.8
      ? [`⚠️ מתקרב לתקציב שהוגדר: ${formatMoney(ledgerSummary.spentSoFar)} מתוך ${formatMoney(budget)} (${Math.round(budgetRatio * 100)}%).`]
      : []),
    ...(maxLossRatio != null && maxLossRatio >= 0.8
      ? [`⚠️ מתקרב להפסד המרבי שהוגדר: ${formatMoney(ledgerSummary.lossSoFar)} מתוך ${formatMoney(maxLoss)} (${Math.round(maxLossRatio * 100)}%).`]
      : []),
    // Without this, "פעולות שבוצעו: 0" reads as the system having found
    // nothing worth doing — the owner has no way to tell that from this
    // text alone, unless they also happen to go check Settings.
    ...(emergencyStop ? ['⚠️ עצירת חירום הייתה פעילה — שום פעולה אמיתית לא בוצעה, בלי קשר למצב הפעולה.'] : []),
    // Same gap, more common cause: research mode is the default, and it
    // alone blocks every publish/charge just as completely as the
    // emergency stop does — without this line the owner has no way to
    // learn that from the digest text either, every single day.
    ...(!emergencyStop && mode === 'research' ? ['🔬 מצב מחקר בלבד — המערכת מצאה הזדמנויות אבל לא פרסמה ולא גבתה כסף באף אחת מהן, בכוונה.'] : []),
    // "approve" mode never auto-publishes even after the owner clicks "אשר
    // פרסום" — a separate, manual "פרסם מוצר" click is still required. Until
    // now the digest said nothing about this, so an opportunity could sit
    // approved-but-unpublished indefinitely with no daily reminder that real
    // money is one click away from actually starting to come in.
    ...(approvedAwaitingPublish > 0 ? [`✅ ${approvedAwaitingPublish} הזדמנויות מאושרות ומחכות לפרסום בפועל שלך.`] : []),
    // The scanner logs its own skip as 'skipped: N drafts already awaiting
    // review' - a result that matches neither "success" nor "failed"
    // below, so without this line the scan could quietly stop producing
    // anything new, every single cycle, with absolutely nothing in this
    // digest explaining why.
    ...(scanPaused ? [`⏸️ הסריקה האוטומטית מושהית — ${pendingDrafts} הזדמנויות ממתינות לסקירה שלך. סקור או דחה חלק מהן כדי שהסריקה תמשיך לחפש.`] : []),
    // billing.js refuses to record a real transaction.completed webhook
    // whose amount/fee it couldn't parse, logging 'blocked: ...' so it
    // never corrupts the ledger with a NaN - but that result matches
    // neither "success" nor "failed" below, so a real customer's real
    // payment could go completely unrecorded with nothing in this digest
    // ever telling the owner it happened. console.error already reaches
    // Railway's own log viewer, but this is the one place an owner who
    // only reads the digest would ever see it.
    ...(unrecordedSales > 0
      ? [`🚨 ${unrecordedSales} תשלומים אמיתיים התקבלו אך לא נרשמו ביומן בגלל שגיאה בעיבוד — בדוק ביומן הפעולות ואת לוגי השרת.`]
      : []),
    `פעולות שבוצעו: ${actionsToday.length}`,
    failuresToday.length
      ? `בעיות: ${failuresToday.map((f) => f.summary).join('; ')}`
      : 'בעיות: אין',
    topOpportunity
      ? `הפעולה המומלצת הבאה: ${topOpportunity.title}`
      : 'הפעולה המומלצת הבאה: אין הזדמנות מספקת כרגע — להמתין',
  ];
  return { text: lines.join('\n'), generatedAt: new Date().toISOString() };
}

// Every other money display in the app shows USD with a "$" sign (the
// dashboard, opportunity cards, product price) - this digest text was the
// one place still showing a bare number with no currency unit at all,
// left behind when the rest of the app moved off a stale "₪" label to "$".
function formatMoney(n) {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
}
