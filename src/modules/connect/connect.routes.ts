import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { db } from "../../config/db.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { isTenantAccessDenied, TENANT_ACCESS_DENIED_BODY } from "../../security/tenantAccessDenied.js";
import { respondInternalError } from "../../observability/internalError.js";
import { connectConfig, serviceTokenMatches } from "./connect.config.js";
import { publicKeyPem, signMessage } from "./connect.signing.js";
import { decideTransfer, Decide, InboundTransfer, listTransfers, receiveTransfer, Withdraw, withdrawTransfer } from "./connect.transfers.js";
import { ConnectError, createLinkCode, linkStatus, loginFacts, redeemLinkCode, statusByRef, unlink } from "./connect.service.js";

/**
 * 181 · Rutas de la integración con ETNARA Connect. Con CONNECT_INTEGRATION apagado (o incompleto), todas responden 404.
 *   Organización (administración, sesión de Care):
 *     GET  /organizations/:organizationId/connect             estado del vínculo
 *     POST /organizations/:organizationId/connect/link-code   código de un solo uso (10 min), visible una vez
 *     POST /organizations/:organizationId/connect/unlink      desvincular (avisa a Connect al instante)
 *   Servidor a servidor (Connect, token de servicio):
 *     POST /integrations/connect/redeem                       canjea el código y devuelve el estado FIRMADO
 *     GET  /integrations/connect/status/:connectProviderRef   estado FIRMADO vigente (respaldo)
 *     POST /organizations/:organizationId/connect/login     C-1: aserción firmada (2 min, un solo uso) para entrar en Connect
 *     GET  /organizations/:organizationId/connect/transfers               C-4: servicios que familias autorizaron pasar a Care
 *     POST /organizations/:organizationId/connect/transfers/:id/decision  aceptar (persona nueva o existente) o rechazar
 *   Servidor a servidor: POST /integrations/connect/transfers y /integrations/connect/transfers/withdraw (C-4)
 *   Pública: GET /integrations/connect/public-key (llave pública para verificar las firmas).
 * El inicio de sesión de Care no cambia.
 */
const router = Router();
const uuid = z.string().uuid();
const Redeem = z.object({ code: z.string().min(10).max(20), connectProviderRef: uuid }).strict();

router.use(["/integrations/connect", "/organizations/:organizationId/connect"], (_req: Request, res: Response, next: NextFunction) => {
  if (!connectConfig()) { res.status(404).json({ error: "NOT_FOUND" }); return; }
  next();
});

function fail(res: Response, err: unknown, req: Request) {
  if (err instanceof ConnectError) { res.status(err.status).json({ error: err.code }); return; }
  if (isTenantAccessDenied(err)) { res.status(403).json(TENANT_ACCESS_DENIED_BODY); return; }
  respondInternalError(res, "connect", err, req);
}
const orgId = (req: Request) => { const p = uuid.safeParse(req.params.organizationId); return p.success ? p.data : null; };

router.get("/organizations/:organizationId/connect", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = orgId(req); if (!o) { res.status(400).json({ error: "INVALID_ORGANIZATION_ID" }); return; }
  try { res.json(await linkStatus(req.auth!.userId, o)); } catch (e) { fail(res, e, req); }
});
router.post("/organizations/:organizationId/connect/link-code", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = orgId(req); if (!o) { res.status(400).json({ error: "INVALID_ORGANIZATION_ID" }); return; }
  try { res.setHeader("Cache-Control", "no-store"); res.status(201).json(await createLinkCode(req.auth!.userId, o)); } catch (e) { fail(res, e, req); }
});
router.post("/organizations/:organizationId/connect/unlink", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = orgId(req); if (!o) { res.status(400).json({ error: "INVALID_ORGANIZATION_ID" }); return; }
  try { await unlink(req.auth!.userId, o); const { kickConnectOutbox } = await import("./connect.worker.js"); kickConnectOutbox(); res.status(204).end(); } catch (e) { fail(res, e, req); }
});

// C-1 · «Abrir ETNARA Connect»: cualquier miembro activo de una organización vinculada. La aserción solo sustituye la
// contraseña de Connect: allí se sigue pidiendo el segundo factor. Viaja en el fragmento (#), que no llega a servidores.
router.post("/organizations/:organizationId/connect/login", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = orgId(req); if (!o) { res.status(400).json({ error: "INVALID_ORGANIZATION_ID" }); return; }
  try {
    const cfg = connectConfig()!;
    const f = await loginFacts(req.auth!.userId, o);
    const token = signMessage(cfg.key, "care.user.assertion", f, Date.now(), 120);
    res.setHeader("Cache-Control", "no-store");
    res.json({ url: `${new URL(cfg.webhookUrl).origin}/care/entrar#a=${token}` });
  } catch (e) { fail(res, e, req); }
});

function service(req: Request, res: Response, next: NextFunction) {
  const cfg = connectConfig();
  if (!cfg || !serviceTokenMatches(cfg, req.headers.authorization)) { res.status(401).json({ error: "NOT_AUTHENTICATED" }); return; }
  next();
}
router.post("/integrations/connect/redeem", service, async (req, res) => {
  const p = Redeem.safeParse(req.body); if (!p.success) { res.status(400).json({ error: "INVALID_REQUEST" }); return; }
  try {
    const facts = await redeemLinkCode(p.data.code, p.data.connectProviderRef);
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: signMessage(connectConfig()!.key, "care.org.status", facts) });
  } catch (e) { fail(res, e, req); }
});
router.get("/integrations/connect/status/:ref", service, async (req, res) => {
  const p = uuid.safeParse(req.params.ref); if (!p.success) { res.status(400).json({ error: "INVALID_REQUEST" }); return; }
  try {
    const facts = await statusByRef(p.data);
    if (!facts) { res.status(404).json({ error: "CONNECT_NOT_LINKED" }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: signMessage(connectConfig()!.key, "care.org.status", facts) });
  } catch (e) { fail(res, e, req); }
});
router.get("/organizations/:organizationId/connect/transfers", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = orgId(req); if (!o) { res.status(400).json({ error: "INVALID_ORGANIZATION_ID" }); return; }
  try { res.setHeader("Cache-Control", "no-store"); res.json({ transfers: await listTransfers(req.auth!.userId, o) }); } catch (e) { fail(res, e, req); }
});
router.post("/organizations/:organizationId/connect/transfers/:transferId/decision", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = orgId(req); const t = uuid.safeParse(req.params.transferId); const b = Decide.safeParse(req.body);
  if (!o || !t.success || !b.success) { res.status(400).json({ error: "INVALID_REQUEST" }); return; }
  try { res.json(await decideTransfer(req.auth!.userId, o, t.data, b.data)); } catch (e) { fail(res, e, req); }
});
// C-5 · Connect avisa hasta cuándo está pagado su plan (para que Premium empiece cuando termine, sin superposición).
const PlanNotice = z.object({ connectProviderRef: uuid, connectPlanUntil: z.string().datetime({ offset: true }).nullable() }).strict();
router.post("/integrations/connect/plan", service, async (req, res) => {
  const p = PlanNotice.safeParse(req.body); if (!p.success) { res.status(400).json({ error: "INVALID_REQUEST" }); return; }
  try {
    const r = (await sql<{ r: string }>`SELECT public.app_connect_plan_notice(${p.data.connectProviderRef}::uuid, ${p.data.connectPlanUntil}::timestamptz) AS r`.execute(db)).rows[0].r;
    res.status(r === "ok" ? 200 : r === "invalid" ? 400 : 404).json({ result: r });
  } catch (e) { fail(res, e, req); }
});
router.post("/integrations/connect/transfers", service, async (req, res) => {
  const p = InboundTransfer.safeParse(req.body); if (!p.success) { res.status(400).json({ error: "INVALID_REQUEST" }); return; }
  try {
    const r = await receiveTransfer(p.data);
    res.status(r === "received" || r === "duplicate" ? 200 : r === "not_linked" ? 404 : 400).json({ result: r });
  } catch (e) { fail(res, e, req); }
});
router.post("/integrations/connect/transfers/withdraw", service, async (req, res) => {
  const p = Withdraw.safeParse(req.body); if (!p.success) { res.status(400).json({ error: "INVALID_REQUEST" }); return; }
  try { const r = await withdrawTransfer(p.data); res.status(r === "unknown" ? 404 : r === "already_decided" ? 409 : 200).json({ result: r }); } catch (e) { fail(res, e, req); }
});
router.get("/integrations/connect/public-key", (_req, res) => {
  res.type("application/x-pem-file").send(publicKeyPem(connectConfig()!.key));
});

export default router;
