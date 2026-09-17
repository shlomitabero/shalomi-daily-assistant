import { Router } from "express";
import { getProject, getWhatsAppSettings, insertWhatsAppMessage, type ForgeDatabase } from "@forge/db";
import { findMatchingRecord, parseIncomingWebhookPayload, verifyWebhookChallenge } from "../whatsapp.js";

/**
 * Meta calls these endpoints directly (not the browser), so they can't sit
 * behind requireAuth the way the rest of the API does -- there's no
 * Forge-issued session token to send. The project id in the path is a
 * random UUID (unguessable in practice), and the GET handshake below
 * additionally requires the project owner's own verify token to complete
 * setup, which is the access control this endpoint actually has. A
 * hardened v2 would also check Meta's `X-Hub-Signature-256` HMAC on the
 * POST body against the app's Meta App Secret; that's a real, documented
 * gap, not something silently skipped -- see docs/roadmap.md.
 */
export function createWhatsAppWebhookRouter(db: ForgeDatabase): Router {
  const router = Router();

  router.get("/webhooks/whatsapp/:projectId", (req, res) => {
    const settings = getWhatsAppSettings(db, req.params.projectId);
    const challenge = verifyWebhookChallenge(settings, req.query as Record<string, unknown>);
    if (challenge === null) {
      res.status(403).send("Verification failed");
      return;
    }
    res.status(200).type("text/plain").send(challenge);
  });

  router.post("/webhooks/whatsapp/:projectId", (req, res) => {
    const project = getProject(db, req.params.projectId);
    if (project && project.status === "built") {
      const messages = parseIncomingWebhookPayload(req.body);
      for (const message of messages) {
        const match = findMatchingRecord(db, project, message.from);
        insertWhatsAppMessage(db, {
          projectId: project.id,
          direction: "in",
          fromNumber: message.from,
          toNumber: message.to,
          body: message.body,
          matchedEntityName: match?.entityName ?? null,
          matchedRecordId: match?.recordId ?? null,
          matchedLabel: match?.label ?? message.contactName,
          status: "received",
        });
      }
    }
    // Meta expects a fast, plain 200 acknowledgement regardless of what
    // this app did with the payload -- anything else and Meta will retry
    // (and eventually disable) the webhook subscription.
    res.status(200).json({ received: true });
  });

  return router;
}
