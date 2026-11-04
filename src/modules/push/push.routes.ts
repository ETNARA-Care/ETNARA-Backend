import { Router, type Response } from "express";
import { ZodError } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { InvalidTenantContextError } from "../../context/errors.js";
import { respondInternalError } from "../../observability/internalError.js";
import { pushPublicConfig } from "./push.config.js";
import {
  PushError, deleteMySubscription, getNotificationTarget, getPreferences, listMySubscriptions, preferencesSchema,
  registerSubscription, registerSubscriptionSchema, sendTestNotification, setPreferences, unregisterSchema, unregisterSubscription,
} from "./push.service.js";

/**
 * Web Push (146). Every route is the signed-in person's own: her phones, her preferences,
 * where her own notification opens. Nothing here is per agency, so no feature gate; whether
 * an agency's notices are SENT is decided per notice (PUSH_NOTIFICATIONS, role, relationship).
 * Endpoints are never logged and never returned.
 */
const router = Router();
type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const handle = (fn: Handler) => async (req: AuthenticatedRequest, res: Response) => {
  try { await fn(req, res); }
  catch (error) {
    if (error instanceof ZodError) { res.status(400).json({ error: "INVALID_PAYLOAD" }); return; }
    if (error instanceof InvalidTenantContextError) { res.status(400).json({ error: "INVALID_ID" }); return; }
    if (error instanceof PushError) { res.status(error.status).json({ error: error.code }); return; }
    respondInternalError(res, "push", error, req);
  }
};

router.get("/me/push/config", requireAuth, handle(async (_req, res) => { res.status(200).json(pushPublicConfig()); }));

router.get("/me/push/subscriptions", requireAuth, handle(async (req, res) => {
  res.status(200).json({ items: await listMySubscriptions(req.auth!.userId, req.auth!.sessionId) });
}));

router.post("/me/push/subscriptions", requireAuth, handle(async (req, res) => {
  const input = registerSubscriptionSchema.parse(req.body);
  res.status(201).json(await registerSubscription(req.auth!.userId, req.auth!.sessionId, input));
}));

/** Removal by endpoint (this phone): POST so the endpoint never appears in a URL or access log. */
router.post("/me/push/subscriptions/unsubscribe", requireAuth, handle(async (req, res) => {
  const { endpoint } = unregisterSchema.parse(req.body);
  res.status(200).json({ removed: await unregisterSubscription(req.auth!.userId, endpoint) });
}));

router.delete("/me/push/subscriptions/:subscriptionId", requireAuth, handle(async (req, res) => {
  const removed = await deleteMySubscription(req.auth!.userId, String(req.params.subscriptionId));
  if (!removed) { res.status(404).json({ error: "PUSH_SUBSCRIPTION_NOT_FOUND" }); return; }
  res.status(204).end();
}));

router.get("/me/push/preferences", requireAuth, handle(async (req, res) => {
  res.status(200).json(await getPreferences(req.auth!.userId));
}));

router.put("/me/push/preferences", requireAuth, handle(async (req, res) => {
  res.status(200).json(await setPreferences(req.auth!.userId, preferencesSchema.parse(req.body)));
}));

router.post("/me/push/test", requireAuth, handle(async (req, res) => {
  res.status(202).json(await sendTestNotification(req.auth!.userId));
}));

router.get("/me/notifications/:notificationId/target", requireAuth, handle(async (req, res) => {
  const target = await getNotificationTarget(req.auth!.userId, String(req.params.notificationId));
  if (!target) { res.status(404).json({ error: "NOTIFICATION_NOT_FOUND" }); return; }
  res.status(200).json(target);
}));

export default router;
