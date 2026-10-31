import { Router } from 'express';
import { db, makeId } from '../db/store.js';
import { verifyPaddleSignature } from '../engine/paddleSignature.js';
import { extractTransactionAmount, extractTransactionFee } from '../engine/paddleTransaction.js';
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
        let amount, fee;
        try {
          amount = extractTransactionAmount(txn);
          fee = extractTransactionFee(txn);
        } catch (err) {
          // Never write a NaN/invalid amount to the ledger — every future
          // totalSpentSoFar()/summarizeLedger() sum would then be
          // permanently corrupted, not just this one transaction.
          console.error('Paddle webhook: refusing to record a malformed transaction amount', err);
          logAction({ type: 'sale_confirmed', detail: { opportunityId, transactionId: txn.id, error: err.message }, result: `blocked: ${err.message}` });
          res.json({ received: true });
          return;
        }
        const today = new Date().toISOString().slice(0, 10);
        const now = new Date().toISOString();
        db.ledger.insert({
          id: makeId('led'),
          type: 'revenue',
          amount,
          verified: true,
          description: `מכירת מוצר (Paddle transaction ${txn.id})`,
          opportunityId,
          externalId: txn.id,
          date: today,
          createdAt: now,
        });
        // Paddle's real platform fee for this sale — until now,
        // costs.paymentProcessing stayed null forever (an honest "unknown
        // until a real sale happens", per createDigitalProductOpportunity),
        // so totalSpentSoFar()/the budget gate only ever saw gross revenue
        // and the owner had to guess a number before feasibility math would
        // run at all. A separate externalId (":fee") keeps this from ever
        // being mistaken for the revenue entry by the replay-guard above.
        if (fee > 0) {
          db.ledger.insert({
            id: makeId('led'),
            type: 'cost',
            amount: fee,
            verified: true,
            description: `עמלת Paddle (Paddle transaction ${txn.id})`,
            opportunityId,
            externalId: `${txn.id}:fee`,
            date: today,
            createdAt: now,
          });
        }
        const opportunity = db.opportunities.get(opportunityId);
        if (opportunity) {
          db.opportunities.update(opportunityId, {
            salesCount: (opportunity.salesCount ?? 0) + 1,
            costs: fee > 0 ? { ...opportunity.costs, paymentProcessing: fee } : opportunity.costs,
          });
        }
        logAction({ type: 'sale_confirmed', detail: { opportunityId, amount, fee, transactionId: txn.id }, result: 'success' });
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Paddle webhook handling failed', err);
    res.status(400).json({ error: 'could not process webhook payload' });
  }
}
