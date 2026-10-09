// Thin wrapper around Paddle's REST API for one-time digital-product sales
// (not a subscription — the owner's product is bought once per customer).
function paddleApiBase() {
  return process.env.PADDLE_ENV === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
}

function paddleHeaders() {
  return { authorization: `Bearer ${process.env.PADDLE_API_KEY}`, 'content-type': 'application/json' };
}

export function isPaddleConfigured() {
  return Boolean(process.env.PADDLE_API_KEY && process.env.PADDLE_CLIENT_TOKEN);
}

export function paddleClientConfig() {
  return {
    clientToken: process.env.PADDLE_CLIENT_TOKEN || null,
    sandbox: process.env.PADDLE_ENV === 'sandbox',
  };
}

export async function createOneTimePrice({ name, amountCents, currencyCode = 'USD' }) {
  const productRes = await fetch(`${paddleApiBase()}/products`, {
    method: 'POST',
    headers: paddleHeaders(),
    body: JSON.stringify({ name, tax_category: 'standard' }),
  });
  if (!productRes.ok) throw new Error(`Paddle product creation failed: ${await productRes.text()}`);
  const { data: product } = await productRes.json();

  const priceRes = await fetch(`${paddleApiBase()}/prices`, {
    method: 'POST',
    headers: paddleHeaders(),
    body: JSON.stringify({
      product_id: product.id,
      description: name,
      unit_price: { amount: String(amountCents), currency_code: currencyCode },
    }),
  });
  if (!priceRes.ok) throw new Error(`Paddle price creation failed: ${await priceRes.text()}`);
  const { data: price } = await priceRes.json();
  return { productId: product.id, priceId: price.id };
}
