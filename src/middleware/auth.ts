import type { Request, Response, NextFunction } from "express";
import { validateSessionToken } from "../modules/auth/auth.service.js";

export interface AuthenticatedRequest extends Request {
  auth?: { userId: string; sessionId: string };
}

/**
 * Authenticates identity only. Does NOT determine organization/tenant
 * context (that is organizationContext's job) and does NOT attach roles,
 * permissions, or an isSuperadmin flag from anywhere client-controlled --
 * those responsibilities stay deliberately separate.
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "NOT_AUTHENTICATED" });
    return;
  }
  const rawToken = header.slice("Bearer ".length).trim();
  if (!rawToken) {
    res.status(401).json({ error: "NOT_AUTHENTICATED" });
    return;
  }
  try {
    const { userId, sessionId } = await validateSessionToken(rawToken);
    req.auth = { userId, sessionId };
    next();
  } catch {
    res.status(401).json({ error: "INVALID_SESSION" });
  }
}
