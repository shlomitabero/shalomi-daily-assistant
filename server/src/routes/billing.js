import { Router } from 'express';
import { db, makeId } from '../db/store.js';
import { verifyPaddleSignature } from '../engine/paddleSignature.js';
import { extractTransactionAmount, extractTransactionFee } from '../engine/paddleTransaction.js';
import { logAction } from '../services/execution.js';
import { isPaddleConfigured, paddleClientConfig } from '../services/paddle.js';
import { todayKey } from '../services/ledger.js';

export const billingRouter = Router();

// Lets the client show an honest "billing isn't set up yet" state instead
// of a checkout button that would silently fail — unlike every other route
// handler in this app, this one was defined as an inline, unexported arrow
// function, which meant it had no test coverage at all.
export function getBillingConfigured(req, res) {
  res.json({ configured: isPaddleConfigured(), ...paddleClientConfig() });
}

billingRouter.get('/billing/configured', getBillingConfigured);

const MAX_WEBHOOK_SIGNATURE_FAILURE_ENTRIES = 500;

// Mirrors routes/auth.js's own logLoginAttempt exactly, same reason: a
// sustained attack against this public, unauthenticated endpoint can log
// far faster than normal activity, and execution.js's own isUnprunable
// now exempts this type from the shared MAX_ACTIONS_LOG_ENTRIES pool
// specifically so it needs its own dedicated, tighter cap here instead -
// without one, nothing would ever bound its growth at all.
function logWebhookSignatureFailure(detail, result) {
  logAction({ type: 'webhook_signature_failed', detail, result });
  const entries = db.actions_log.where((a) => a.type === 'webhook_signature_failed');
  const excess = entries.length - MAX_WEBHOOK_SIGNATURE_FAILURE_ENTRIES;
  if (excess > 0) {
    entries
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .slice(0, excess)
      .forEach((entry) => db.actions_log.delete(entry.id));
  }
}

// Mounted separately in server.js with express.raw() — signature
// verification needs the exact raw request body. Never crashes the process
// on a malformed/unexpected payload — always responds, even on failure,
// since a crash here would take down the entire app for every other request.
export function paddleWebhookHandler(req, res) {
  // Mirrors routes/auth.js's own identical early-return for a missing
  // OWNER_PASSWORD: before Paddle is ever configured (the owner hasn't set
  // PADDLE_WEBHOOK_SECRET yet), verifyPaddleSignature below returns false
  // unconditionally for every request (its own first line treats a missing
  // secret the same as a missing signature) - without this check first,
  // every request here during that normal pre-setup window (a scanner/bot
  // probing common paths, routine before the owner ever finishes setup)
  // would get logged as webhook_signature_failed, the same real-attack
  // signal a genuinely forged request triggers once Paddle IS configured.
  // That's not a security event - it's just "billing isn't set up yet" -
  // the same reason login() never logs a login_attempt for this case either.
  if (!process.env.PADDLE_WEBHOOK_SECRET) {
    return res.status(503).send('billing not configured');
  }
  let rawBody;
  try {
    rawBody = req.body.toString('utf8');
    const valid = verifyPaddleSignature({
      rawBody,
      signatureHeader: req.headers['paddle-signature'],
      secret: process.env.PADDLE_WEBHOOK_SECRET,
    });
    if (!valid) {
      // console.error alone only ever reached Railway's own log viewer -
      // routes/auth.js already treats a failed login attempt as a real
      // security signal worth the owner's own in-app activity log (this is
      // a personal console, reachable on the open internet), and this
      // endpoint is exactly as public and unauthenticated - a forged or
      // malformed request trying to fake a "payment confirmed" webhook is
      // the same kind of signal, just against this one public route
      // instead of /login. req.ip, not the Paddle-Signature header's own
      // claimed source - same reasoning as login's own req.ip capture.
      console.error('Paddle webhook signature check failed');
      logWebhookSignatureFailure({ ip: req.ip }, 'blocked: חתימת ה-webhook אינה תקינה');
      return res.status(400).send('invalid signature');
    }

    const event = JSON.parse(rawBody);

    if (event.event_type === 'transaction.completed') {
      const txn = event.data;
      const opportunityId = txn?.custom_data?.opportunityId;
      const alreadyRecorded = opportunityId && db.ledger.where((e) => e.externalId === txn.id).length > 0;

      if (!opportunityId) {
        // ProductPage.jsx always sets custom_data.opportunityId on this
        // app's own checkout (the only way a real customer ever reaches
        // Paddle here) - a transaction.completed arriving without it is
        // anomalous: a checkout-overlay bug, Paddle dropping the field, or
        // a transaction unrelated to this app's own product. Until now
        // this fell straight through both branches below with absolutely
        // no trace - no ledger entry, no audit log row, and (unlike the
        // malformed-amount case right below) not even counted by
        // countUnrecordedSales(), the one metric this app built
        // specifically so a real payment can never go missing silently.
        console.error('Paddle webhook: transaction.completed had no opportunityId in custom_data', txn?.id);
        logAction({
          type: 'sale_confirmed',
          detail: { transactionId: txn?.id },
          result: 'blocked: תשלום אמיתי התקבל אך לא ניתן לזהות לאיזו הזדמנות הוא משתייך — custom_data.opportunityId חסר בעסקה',
        });
      } else if (!alreadyRecorded) {
        // A sandbox transaction (PADDLE_ENV=sandbox — the README's own
        // documented default while testing) still signs and sends a real
        // webhook once its own sandbox secret is configured, indistinguishable
        // from this handler's point of view from a real sale. Without this,
        // every test purchase made while trying out the checkout would get
        // recorded as verified: true real revenue, inflating the dashboard's
        // actual cash-in/net-profit numbers with fake test money — the one
        // thing this ledger exists to never do. PADDLE_ENV is the same
        // signal paddleClientConfig()/ProductPage.jsx's sandbox banner
        // already treat as authoritative, not a guess at Paddle's payload.
        if (process.env.PADDLE_ENV === 'sandbox') {
          logAction({ type: 'sale_confirmed', detail: { opportunityId, transactionId: txn.id }, result: 'skipped: sandbox transaction, not recorded as real revenue' });
          res.json({ received: true });
          return;
        }
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
        const today = todayKey();
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
