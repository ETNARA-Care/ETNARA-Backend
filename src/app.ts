import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { env } from "./config/env.js";
import authRoutes from "./modules/auth/auth.routes.js";
import organizationContextRoutes from "./modules/organizationContext/organizationContext.routes.js";
import careRecipientsRoutes from "./modules/careRecipients/careRecipients.routes.js";
import familyRoutes from "./modules/family/family.routes.js";
import workforceRoutes from "./modules/workforce/workforce.routes.js";
import credentialingRoutes from "./modules/credentialing/credentialing.routes.js";
import eligibilityRoutes from "./modules/eligibility/eligibility.routes.js";
import schedulingRoutes from "./modules/scheduling/scheduling.routes.js";
import assignmentsRoutes from "./modules/assignments/assignments.routes.js";
import verificationRoutes from "./modules/verification/verification.routes.js";
import careEventsRoutes from "./modules/careEvents/careEvents.routes.js";
import observationsRoutes from "./modules/observations/observations.routes.js";
import incidentsRoutes from "./modules/incidents/incidents.routes.js";
import familyTimelineRoutes from "./modules/familyTimeline/familyTimeline.routes.js";
import messagingRoutes from "./modules/messaging/messaging.routes.js";
import notificationsRoutes from "./modules/notifications/notifications.routes.js";

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  // CORS: explicit allowlist only -- never "*". The frontend authenticates
  // via a Bearer token in the Authorization header (never cookies), so
  // credentials:true / Access-Control-Allow-Credentials is deliberately
  // NOT set -- there is no cookie-based session to protect or leak here,
  // and omitting it keeps the surface smaller than it needs to be.
  const allowedOrigins = env.ALLOWED_ORIGIN.split(",").map((o) => o.trim());
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Health check: intentionally reveals nothing beyond liveness -- no DB
  // version, no env values, no internal state.
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.use(authRoutes);
  app.use(organizationContextRoutes);
  app.use(careRecipientsRoutes);
  app.use(familyRoutes);
  app.use(workforceRoutes);
  app.use(credentialingRoutes);
  app.use(eligibilityRoutes);
  app.use(schedulingRoutes);
  app.use(assignmentsRoutes);
  app.use(verificationRoutes);
  app.use(careEventsRoutes);
  app.use(observationsRoutes);
  app.use(incidentsRoutes);
  app.use(familyTimelineRoutes);
  app.use(messagingRoutes);
  app.use(notificationsRoutes);

  // Safety-net error handler: never leak stack traces, SQL, or internal
  // details to the client.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "INTERNAL_ERROR" });
  });

  return app;
}
