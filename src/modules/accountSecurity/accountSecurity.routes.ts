import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { respondInternalError } from "../../observability/internalError.js";
import { checkLimit, recordAttempt } from "../auth/auth.rateLimit.js";
import {
  AccountSecurityError, beginSmsReset, confirmPhoneVerification, getAccountSecurity, phoneFeature, reauthenticate,
  startPhoneVerification, verifySmsReset,
} from "./accountSecurity.service.js";

/**
 * Account security (migration 117). Phone routes answer 404 FEATURE_NOT_ENABLED
 * until PHONE_VERIFICATION_ENABLED=true and an SMS provider is configured.
 * Responses never contain a full number, a code, or whether an account exists.
 */
const router = Router();
const noStore = (res: Response) => res.setHeader("Cache-Control", "no-store");

function fail(err: unknown, req: Request, res: Response) {
  if (err instanceof AccountSecurityError) { res.status(err.status).json({ error: err.code }); return; }
  respondInternalError(res, "account-security", err, req);
}

router.get("/me/account-security", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  noStore(res);
  try { res.json({ security: await getAccountSecurity(req.auth!.userId) }); } catch (err) { fail(err, req, res); }
});

// Password again before changing the phone (valid 10 minutes, this session only).
router.post("/me/reauthenticate", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const body = z.object({ password: z.string().min(1).max(128) }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  const key = `reauth:${req.auth!.userId}`;
  if (!checkLimit(req, res, key)) return;
  try {
    await reauthenticate(req.auth!.userId, req.auth!.sessionId, body.data.password);
    recordAttempt(req, key, false);
    res.json({ ok: true, validForSeconds: 600 });
  } catch (err) {
    if (err instanceof AccountSecurityError && err.code === "INVALID_CREDENTIALS") recordAttempt(req, key);
    fail(err, req, res);
  }
});

router.post("/me/phone/verification", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const body = z.object({ phone: z.string().min(7).max(32) }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  try {
    await startPhoneVerification(req.auth!.userId, req.auth!.sessionId, body.data.phone, req.ip);
    res.status(202).json({ sent: true, expiresInSeconds: 600, resendAfterSeconds: 60 });
  } catch (err) { fail(err, req, res); }
});

router.post("/me/phone/verification/confirm", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const body = z.object({ code: z.string().min(1).max(12) }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  try {
    const done = await confirmPhoneVerification(req.auth!.userId, body.data.code.trim());
    res.json({ phone: `•••-•••-${done.last4}`, phoneVerified: true, changed: done.result === "CHANGED" });
  } catch (err) { fail(err, req, res); }
});

// ------------------------------------------------------------------ signed out: SMS recovery
router.post("/auth/password-reset/sms/request", async (req: Request, res: Response) => {
  const body = z.object({ phone: z.string().min(7).max(32) }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  try { phoneFeature(); } catch (err) { return void fail(err, req, res); }
  if (!checkLimit(req, res, `sms-reset:${body.data.phone}`)) return;
  recordAttempt(req, `sms-reset:${body.data.phone}`);
  let work: (() => Promise<void>) | null;
  try { work = await beginSmsReset(body.data.phone, req.ip); } catch (err) { return void fail(err, req, res); }
  // Same answer, same timing, account or not; the code (if any) is created and sent afterwards.
  res.status(200).json({ ok: true });
  setImmediate(() => { void work?.().catch((e: unknown) => console.error("SMS reset failed", { name: (e as Error)?.name ?? "Error" })); });
});

router.post("/auth/password-reset/sms/verify", async (req: Request, res: Response) => {
  const body = z.object({ phone: z.string().min(7).max(32), code: z.string().min(1).max(12) }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  try { phoneFeature(); } catch (err) { return void fail(err, req, res); }
  const key = `sms-verify:${body.data.phone}`;
  if (!checkLimit(req, res, key)) return;
  try {
    const resetToken = await verifySmsReset(body.data.phone, body.data.code.trim());
    recordAttempt(req, key, false);
    noStore(res);
    // Used with the existing POST /auth/password-reset/confirm (single use, 10 min, closes every session).
    res.json({ resetToken, expiresInSeconds: 600 });
  } catch (err) {
    recordAttempt(req, key);
    fail(err, req, res);
  }
});

export default router;
