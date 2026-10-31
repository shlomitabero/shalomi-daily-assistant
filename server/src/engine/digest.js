// Builds the daily summary: net profit, what ran, what broke, and what to
// do next. Pure text assembly so it's testable without a scheduler.
export function buildDailyDigest({ ledgerSummary, actionsToday = [], failuresToday = [], topOpportunity = null, emergencyStop = false }) {
  const lines = [
    `רווח נטו מאומת היום: ${formatMoney(ledgerSummary.netProfitToday)}`,
    `נכנס בפועל: ${formatMoney(ledgerSummary.cashInToday)} | יצא בפועל: ${formatMoney(ledgerSummary.cashOutToday)}`,
    // Without this, "פעולות שבוצעו: 0" reads as the system having found
    // nothing worth doing — the owner has no way to tell that from this
    // text alone, unless they also happen to go check Settings.
    ...(emergencyStop ? ['⚠️ עצירת חירום הייתה פעילה — שום פעולה אמיתית לא בוצעה, בלי קשר למצב הפעולה.'] : []),
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

function formatMoney(n) {
  return `${n < 0 ? '-' : ''}${Math.abs(n).toFixed(2)}`;
}
