import { Router } from 'express';
import { db, makeId } from '../db/store.js';
import { verifyPaddleSignature } from '../engine/paddleSignature.js';
import { logAction } from '../services/execution.js';
import { isPaddleConfigured, paddleClientConfig } from '../services/paddle.js';

export const billingRouter = Router();

billingRouter.get('/billing/configured', (req, res) => {
  res.json({ configured: isPaddleConfigured(), ...paddleClientConfig() });
});

// Mounted separately in server.js with express.raw() — signature
// verification needs the exact raw request body. Never crashes the process
// on a malformed/unexpected payload — always responds, even on failure,
// since a crash here would take down the entire app for every other request.
export function paddleWebhookHandler(req, res) {
  let rawBody;
  try {
    rawBody = req.body.toString('utf8');
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

    if (event.event_type === 'transaction.completed') {
      const txn = event.data;
      const opportunityId = txn?.custom_data?.opportunityId;
      const alreadyRecorded = opportunityId && db.ledger.where((e) => e.externalId === txn.id).length > 0;

      if (opportunityId && !alreadyRecorded) {
        const amount = Number(txn.details?.totals?.total ?? 0) / 100;
        db.ledger.insert({
          id: makeId('led'),
          type: 'revenue',
          amount,
          verified: true,
          description: `מכירת מוצר (Paddle transaction ${txn.id})`,
          opportunityId,
          externalId: txn.id,
          date: new Date().toISOString().slice(0, 10),
          createdAt: new Date().toISOString(),
        });
        const opportunity = db.opportunities.get(opportunityId);
        if (opportunity) db.opportunities.update(opportunityId, { salesCount: (opportunity.salesCount ?? 0) + 1 });
        logAction({ type: 'sale_confirmed', detail: { opportunityId, amount, transactionId: txn.id }, result: 'success' });
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Paddle webhook handling failed', err);
    res.status(400).json({ error: 'could not process webhook payload' });
  }
}
