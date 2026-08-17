import { Router, type Response } from "express";
import {
  listMyNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  listNotificationsQuerySchema,
  NotificationNotFoundError,
} from "./notifications.service.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { InvalidTenantContextError } from "../../context/errors.js";

const router = Router();

router.get("/me/notifications", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const queryParsed = listNotificationsQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    res.status(400).json({ error: "INVALID_QUERY" });
    return;
  }
  try {
    const result = await listMyNotifications(req.auth!.userId, queryParsed.data);
    res.status(200).json(result);
  } catch {
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

router.patch("/me/notifications/:notificationId/read", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const notification = await markNotificationRead(req.auth!.userId, String(req.params.notificationId));
    res.status(200).json({ notification });
  } catch (err) {
    if (err instanceof InvalidTenantContextError) {
      res.status(400).json({ error: "INVALID_ID" });
      return;
    }
    if (err instanceof NotificationNotFoundError) {
      res.status(404).json({ error: "NOTIFICATION_NOT_FOUND" });
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

router.post("/me/notifications/read-all", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const count = await markAllNotificationsRead(req.auth!.userId);
    res.status(200).json({ markedRead: count });
  } catch {
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

export default router;
