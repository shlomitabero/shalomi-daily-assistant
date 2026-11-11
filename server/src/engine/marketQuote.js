// Parses TwelveData's /price response into a finite price, or throws. A
// truthy-but-non-numeric price (e.g. a stray "N/A" from the provider)
// would otherwise silently become NaN — and that NaN would save to the
// watchlist as lastPrice and render as "$NaN" on the dashboard instead of
// either a real price or the honest "not connected" state.
export function parseQuotePrice(data) {
  if (data?.code) {
    // TwelveData's own data.message here (e.g. "**symbol** not found:
    // AAPLX" for a typo'd/delisted ticker, or a rate-limit/auth message) is
    // raw English straight from the provider, with no Hebrew translation of
    // its own - until now it was thrown verbatim and reached the owner
    // unchanged via routes/financial.js's `לא ניתן היה לקבל מחיר: ${err.message}`
    // on both "add to watchlist" and "refresh", dropped into an otherwise
    // all-Hebrew error line. console.error here gives Railway's own log
    // viewer the real detail, same split as every other service-level
    // failure in this app.
    console.error('parseQuotePrice: market data provider rejected the request', data);
    throw new Error('מקור נתוני השוק דחה את הבקשה — ייתכן שהסימבול שגוי או לא קיים');
  }
  if (!data?.price) throw new Error('תגובה לא צפויה ממקור נתוני השוק');
  const price = Number(data.price);
  if (!Number.isFinite(price)) throw new Error(`מקור נתוני השוק החזיר מחיר שאינו מספר: ${JSON.stringify(data.price)}`);
  return price;
}
