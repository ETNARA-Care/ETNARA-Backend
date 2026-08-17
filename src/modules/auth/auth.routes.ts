import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { login, logout, InvalidCredentialsError } from "./auth.service.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";

const router = Router();

const loginSchema = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().min(3).optional(),
    password: z.string().min(1),
  })
  .refine((d) => d.email || d.phone, { message: "email or phone required" });

router.post("/auth/login", async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_PAYLOAD" });
    return;
  }
  const identifier = (parsed.data.email ?? parsed.data.phone) as string;
  try {
    const result = await login(identifier, parsed.data.password, { ipAddress: req.ip });
    // Never echo back password_hash, token_hash, or any other internal
    // field -- only the one-time raw token and its expiration.
    res.status(200).json({ token: result.token, expiresAt: result.expiresAt.toISOString() });
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      res.status(401).json({ error: "INVALID_CREDENTIALS" });
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

router.post("/auth/logout", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  await logout(req.auth!.sessionId, req.auth!.userId);
  res.status(200).json({ ok: true });
});

export default router;
