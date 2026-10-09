import Stripe from 'stripe';
import { Router } from 'express';
import { db, makeId } from '../db/store.js';
import { requireAuth } from '../middleware/auth.js';

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? new Stripe(key) : null;
}

function originOf(req) {
  return req.headers.origin || `${req.protocol}://${req.get('host')}`;
}

function upsertSubscription({ userId, customerId, subscriptionId, status }) {
  const existing = db.subscriptions.where((s) => s.user_id === userId)[0];
  if (existing) {
    db.subscriptions.update(existing.id, { stripe_customer_id: customerId, stripe_subscription_id: subscriptionId, status });
  } else {
    db.subscriptions.insert({
      id: makeId('sub'), user_id: userId, stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId, status, created_at: new Date().toISOString(),
    });
  }
}

export const billingRouter = Router();

billingRouter.get('/billing/configured', (req, res) => {
  res.json({ configured: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID) });
});

billingRouter.post('/billing/checkout', requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe || !process.env.STRIPE_PRICE_ID) {
    return res.status(503).json({ error: 'billing is not configured yet' });
  }
  const user = req.user;
  const existingSub = db.subscriptions.where((s) => s.user_id === user.id)[0];
  let customerId = existingSub?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: user.email, metadata: { userId: user.id } });
    customerId = customer.id;
  }
  const origin = originOf(req);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${origin}/?checkout=success`,
    cancel_url: `${origin}/?checkout=cancelled`,
    metadata: { userId: user.id },
  });
  res.json({ url: session.url });
});

billingRouter.post('/billing/portal', requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: 'billing is not configured yet' });
  const sub = db.subscriptions.where((s) => s.user_id === req.user.id)[0];
  if (!sub?.stripe_customer_id) return res.status(400).json({ error: 'no billing account yet — subscribe first' });
  const session = await stripe.billingPortal.sessions.create({ customer: sub.stripe_customer_id, return_url: originOf(req) });
  res.json({ url: session.url });
});

// Mounted separately in server.js with express.raw() — Stripe signature
// verification needs the exact raw request body, not the parsed JSON the
// rest of the app uses.
export function stripeWebhookHandler(req, res) {
  const stripe = getStripe();
  if (!stripe) return res.status(503).end();

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature check failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    if (userId) {
      upsertSubscription({ userId, customerId: session.customer, subscriptionId: session.subscription, status: 'active' });
    }
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const existing = db.subscriptions.where((s) => s.stripe_subscription_id === subscription.id)[0];
    if (existing) db.subscriptions.update(existing.id, { status: subscription.status });
  }

  res.json({ received: true });
}
