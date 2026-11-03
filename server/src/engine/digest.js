// Builds the daily summary: net profit, what ran, what broke, and what to
// do next. Pure text assembly so it's testable without a scheduler.
export function buildDailyDigest({ ledgerSummary, actionsToday = [], failuresToday = [], topOpportunity = null, emergencyStop = false, mode = null }) {
  const lines = [
    `רווח נטו מאומת היום: ${formatMoney(ledgerSummary.netProfitToday)}`,
    `נכנס בפועל: ${formatMoney(ledgerSummary.cashInToday)} | יצא בפועל: ${formatMoney(ledgerSummary.cashOutToday)}`,
    // Without this, "פעולות שבוצעו: 0" reads as the system having found
    // nothing worth doing — the owner has no way to tell that from this
    // text alone, unless they also happen to go check Settings.
    ...(emergencyStop ? ['⚠️ עצירת חירום הייתה פעילה — שום פעולה אמיתית לא בוצעה, בלי קשר למצב הפעולה.'] : []),
    // Same gap, more common cause: research mode is the default, and it
    // alone blocks every publish/charge just as completely as the
    // emergency stop does — without this line the owner has no way to
    // learn that from the digest text either, every single day.
    ...(!emergencyStop && mode === 'research' ? ['🔬 מצב מחקר בלבד — המערכת מצאה הזדמנויות אבל לא פרסמה ולא גבתה כסף באף אחת מהן, בכוונה.'] : []),
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
