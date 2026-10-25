import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { allowResolve, resolveShortMapLink } from "./mapLinkResolver.js";

/**
 * POST /maps/resolve-link { url } — signed-in users only (agency managers and relatives
 * use it from «Pegar ubicación»). Answers a point inside Puerto Rico or a reason; it
 * never echoes the link and never logs it.
 */
const router = Router();
const bodySchema = z.object({ url: z.string().trim().min(10).max(300) }).strict();

router.post("/maps/resolve-link", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const body = bodySchema.safeParse(req.body ?? {});
  if (!body.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  if (!allowResolve(req.auth!.userId)) return void res.status(429).json({ error: "TOO_MANY_REQUESTS" });
  try {
    const r = await resolveShortMapLink(body.data.url);
    if (r.status === "point") return void res.json({ status: "point", point: r.point, placeHint: r.placeHint });
    res.json({ status: r.status });
  } catch {
    res.json({ status: "unreachable" });
  }
});

export default router;
