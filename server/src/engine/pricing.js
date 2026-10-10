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
  return parsed;
}
