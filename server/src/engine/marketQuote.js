// Parses TwelveData's /price response into a finite price, or throws. A
// truthy-but-non-numeric price (e.g. a stray "N/A" from the provider)
// would otherwise silently become NaN — and that NaN would save to the
// watchlist as lastPrice and render as "$NaN" on the dashboard instead of
// either a real price or the honest "not connected" state.
export function parseQuotePrice(data) {
  if (data?.code || !data?.price) throw new Error(data?.message || 'תגובה לא צפויה ממקור נתוני השוק');
  const price = Number(data.price);
  if (!Number.isFinite(price)) throw new Error(`מקור נתוני השוק החזיר מחיר שאינו מספר: ${JSON.stringify(data.price)}`);
  return price;
}
