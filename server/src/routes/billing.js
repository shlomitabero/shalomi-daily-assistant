import { Router } from 'express';
import { db, makeId } from '../db/store.js';
import { requireAuth } from '../middleware/auth.js';
import { verifyPaddleSignature } from '../engine/paddleSignature.js';

// Paddle is the merchant of record: it is the seller, handles tax/VAT
// compliance worldwide, and pays the account holder out directly — unlike
// Stripe, which doesn't support payouts to Israeli merchant accounts.
function paddleApiBase() {
  return process.env.PADDLE_ENV === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
}

function isConfigured() {
  return Boolean(process.env.PADDLE_API_KEY && process.env.PADDLE_CLIENT_TOKEN && process.env.PADDLE_PRICE_ID);
}

function upsertSubscription({ userId, customerId, subscriptionId, status }) {
  const existing = db.subscriptions.where((s) => s.user_id === userId)[0];
  if (existing) {
    db.subscriptions.update(existing.id, { paddle_customer_id: customerId, paddle_subscription_id: subscriptionId, status });
  } else {
    db.subscriptions.insert({
      id: makeId('sub'), user_id: userId, paddle_customer_id: customerId,
      paddle_subscription_id: subscriptionId, status, created_at: new Date().toISOString(),
    });
  }
}

export const billingRouter = Router();

// The client-side token and price ID are not secrets — Paddle.js needs them
// in the browser to open its own checkout overlay directly, so the frontend
// never has to ask our server to start a checkout session.
billingRouter.get('/billing/configured', (req, res) => {
  res.json({
    configured: isConfigured(),
    clientToken: process.env.PADDLE_CLIENT_TOKEN || null,
    priceId: process.env.PADDLE_PRICE_ID || null,
    sandbox: process.env.PADDLE_ENV === 'sandbox',
  });
});

billingRouter.post('/billing/portal', requireAuth, async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: 'billing is not configured yet' });
  const sub = db.subscriptions.where((s) => s.user_id === req.user.id)[0];
  if (!sub?.paddle_customer_id) return res.status(400).json({ error: 'no billing account yet — subscribe first' });

  let response;
  try {
    response = await fetch(`${paddleApiBase()}/customers/${sub.paddle_customer_id}/portal-sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.PADDLE_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(sub.paddle_subscription_id ? { subscription_ids: [sub.paddle_subscription_id] } : {}),
    });
  } catch (err) {
    console.error('Paddle portal session request failed', err.message);
    return res.status(502).json({ error: 'could not reach the billing provider, try again' });
  }
  if (!response.ok) {
    console.error('Paddle portal session request failed', response.status, await response.text());
    return res.status(502).json({ error: 'could not open the billing portal, try again' });
  }
  const { data } = await response.json();
  res.json({ url: data.urls.general.overview });
});

// Mounted separately in server.js with express.raw() — signature
// verification needs the exact raw request body, not the parsed JSON the
// rest of the app uses.
export function paddleWebhookHandler(req, res) {
  const rawBody = req.body.toString('utf8');
  const valid = verifyPaddleSignature({
    rawBody,
    signatureHeader: req.headers['paddle-signature'],
    secret: process.env.PADDLE_WEBHOOK_SECRET,
  });
  if (!valid) {
    console.error('Paddle webhook signature check failed');
    return res.status(400).send('invalid signature');
  }

  const event = JSON.parse(rawBody);
  const subscription = event.data;

  if (['subscription.created', 'subscription.updated', 'subscription.canceled'].includes(event.event_type)) {
    // custom_data is set during checkout (see Account.jsx's Paddle.Checkout.open
    // call) and Paddle copies it onto the resulting subscription, which is how
    // we tie a Paddle subscription back to one of our own user accounts.
    const userId = subscription.custom_data?.userId;
    if (userId) {
      upsertSubscription({
        userId,
        customerId: subscription.customer_id,
        subscriptionId: subscription.id,
        status: subscription.status,
      });
    }
  }

  res.json({ received: true });
}
