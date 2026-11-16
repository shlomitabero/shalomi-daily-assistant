// The owner's configured default product price, read once at startup from
// DEFAULT_PRODUCT_PRICE_USD. An unset/empty env var must fall back to the
// hard-coded default — but so must a misconfigured one (a typo, a stray
// "$9" or "9 USD", an accidentally-empty value in a deploy config), because
// the alternative is silent and expensive: Number("") is 0 (every new
// product would be created free), and Number("abc") is NaN, which later
// gets sent to Paddle as the literal string "NaN" and fails publish with a
// cryptic Paddle API error instead of a clear one here.
const FALLBACK_PRICE_USD = 9;

export function resolveDefaultPriceUSD(envValue) {
  if (envValue === undefined || envValue === null || envValue === '') return FALLBACK_PRICE_USD;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return FALLBACK_PRICE_USD;
  // A real purchase is always charged in whole cents
  // (services/paddle.js's own Math.round(priceUSD * 100) for the real
  // Paddle charge) - routes/opportunities.js's patchOpportunity already
  // rounds the same way for an owner-edited price, but a newly drafted
  // opportunity gets its priceUSD straight from here, at creation time,
  // never through that route at all. A misconfigured DEFAULT_PRODUCT_PRICE_USD
  // (e.g. "9.999", a typo) would otherwise seed every new opportunity with
  // a price that silently diverges from what a customer is ever actually
  // charged, until the owner happened to open and re-save that one card.
  return Math.round(parsed * 100) / 100;
}
