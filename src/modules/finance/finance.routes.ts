import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { MembershipNotActiveError, InvalidTenantContextError } from "../../context/errors.js";
import { respondInternalError } from "../../observability/internalError.js";
import {
  FinanceError, addHoliday, cancelRate, deactivateHoliday, holidayDateSchema, holidayDeactivateSchema, rateCancelSchema, clientRecipientSchema, clientSchema, clientUpdateSchema, createClient, createRate, createService,
  endRate, getShiftFinance, holidaySchema, linkClientRecipient, listCaregiverRates, listClients, listHolidays, listRates,
  listServices, rateCreateSchema, rateEndSchema, recipientDefaultsSchema, resolveRates, resolveSchema, serviceCreateSchema,
  serviceUpdateSchema, setRecipientDefaults, setShiftFinance, shiftTermsSchema, updateClient, updateService,
} from "./finance.service.js";

/**
 * ETNARA Finanzas F1 routes. All of them sit behind FINANZAS (orgFeatureGate:
 * 404 FEATURE_NOT_ENABLED while the agency has it off) and answer only to the
 * agency's ORGANIZATION_ADMIN. A 500 never carries internal detail.
 */
const router = Router();
const uuid = z.string().uuid();
const base = "/organizations/:organizationId/finance";

type Handler = (req: AuthenticatedRequest, organizationId: string) => Promise<unknown>;

function handle(status: number, work: Handler) {
  return async (req: Request, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    if (!org.success) { res.status(400).json({ error: "INVALID_ORGANIZATION_ID" }); return; }
    try {
      res.status(status).json(await work(req as AuthenticatedRequest, org.data));
    } catch (error) {
      if (error instanceof FinanceError) { res.status(error.status).json({ error: error.code }); return; }
      if (error instanceof z.ZodError) { res.status(400).json({ error: "INVALID_PAYLOAD" }); return; }
      if (error instanceof MembershipNotActiveError) { res.status(403).json({ error: "FINANCE_FORBIDDEN" }); return; }
      if (error instanceof InvalidTenantContextError) { res.status(400).json({ error: "INVALID_ID" }); return; }
      respondInternalError(res, "finance", error, req);
    }
  };
}

const id = (req: Request, name: string) => uuid.parse(req.params[name]);
const user = (req: AuthenticatedRequest) => req.auth!.userId;

router.get(`${base}/services`, requireAuth, handle(200, (req, org) => listServices(user(req), org)));
router.post(`${base}/services`, requireAuth, handle(201, async (req, org) => ({ service: await createService(user(req), org, serviceCreateSchema.parse(req.body)) })));
router.patch(`${base}/services/:serviceId`, requireAuth, handle(200, async (req, org) => ({ service: await updateService(user(req), org, id(req, "serviceId"), serviceUpdateSchema.parse(req.body)) })));

router.get(`${base}/services/:serviceId/rates`, requireAuth, handle(200, (req, org) => listRates(user(req), org, id(req, "serviceId"))));
router.post(`${base}/services/:serviceId/rates`, requireAuth, handle(201, (req, org) => createRate(user(req), org, id(req, "serviceId"), rateCreateSchema.parse(req.body))));
router.post(`${base}/rates/:rateId/end`, requireAuth, handle(200, async (req, org) => ({ rate: await endRate(user(req), org, id(req, "rateId"), rateEndSchema.parse(req.body)) })));
router.post(`${base}/rates/:rateId/cancel`, requireAuth, handle(200, (req, org) => cancelRate(user(req), org, id(req, "rateId"), rateCancelSchema.parse(req.body))));
router.get(`${base}/rates/resolve`, requireAuth, handle(200, (req, org) => resolveRates(user(req), org, resolveSchema.parse(req.query))));

router.get(`${base}/caregivers`, requireAuth, handle(200, (req, org) => listCaregiverRates(user(req), org)));

router.get(`${base}/clients`, requireAuth, handle(200, (req, org) => listClients(user(req), org)));
router.post(`${base}/clients`, requireAuth, handle(201, async (req, org) => ({ client: await createClient(user(req), org, clientSchema.parse(req.body)) })));
router.patch(`${base}/clients/:clientId`, requireAuth, handle(200, async (req, org) => ({ client: await updateClient(user(req), org, id(req, "clientId"), clientUpdateSchema.parse(req.body)) })));
router.post(`${base}/clients/:clientId/recipients`, requireAuth, handle(201, async (req, org) => ({ link: await linkClientRecipient(user(req), org, id(req, "clientId"), clientRecipientSchema.parse(req.body)) })));

router.get(`${base}/holidays`, requireAuth, handle(200, (req, org) => listHolidays(user(req), org)));
router.post(`${base}/holidays`, requireAuth, handle(201, async (req, org) => ({ holiday: await addHoliday(user(req), org, holidaySchema.parse(req.body)) })));
router.post(`${base}/holidays/:date/deactivate`, requireAuth, handle(200, async (req, org) => ({ holiday: await deactivateHoliday(user(req), org, holidayDateSchema.parse(req.params.date), holidayDeactivateSchema.parse(req.body)) })));

router.put(`${base}/recipients/:recipientId/defaults`, requireAuth, handle(200, async (req, org) => ({ defaults: await setRecipientDefaults(user(req), org, id(req, "recipientId"), recipientDefaultsSchema.parse(req.body)) })));

router.get("/organizations/:organizationId/shifts/:shiftId/finance", requireAuth, handle(200, (req, org) => getShiftFinance(user(req), org, id(req, "shiftId"))));
router.put("/organizations/:organizationId/shifts/:shiftId/finance", requireAuth, handle(200, (req, org) => setShiftFinance(user(req), org, id(req, "shiftId"), shiftTermsSchema.parse(req.body))));

export default router;
