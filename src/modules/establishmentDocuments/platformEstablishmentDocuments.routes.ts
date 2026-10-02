import { Router,type Response } from "express";
import { z } from "zod";
import { requireAuth,type AuthenticatedRequest } from "../../middleware/auth.js";
import { UnauthorizedPlatformAccessError } from "../../context/errors.js";
import { EstablishmentDocumentNotFoundError } from "./establishmentDocuments.service.js";
import { getPlatformEstablishmentDocumentDownload,listPlatformEstablishmentDocumentQueue,reviewPlatformEstablishmentDocument } from "./platformEstablishmentDocuments.service.js";
const router=Router(),uuid=z.string().uuid();
function fail(x:unknown,res:Response){if(x instanceof UnauthorizedPlatformAccessError){res.status(403).json({error:"PLATFORM_ACCESS_DENIED"});return;}if(x instanceof EstablishmentDocumentNotFoundError){res.status(404).json({error:"ESTABLISHMENT_DOCUMENT_NOT_FOUND"});return;}res.status(500).json({error:"INTERNAL_ERROR"});}
router.get("/platform/establishment-documents/verification-queue",requireAuth,async(req:AuthenticatedRequest,res)=>{try{res.json({documents:await listPlatformEstablishmentDocumentQueue(req.auth!.userId)});}catch(x){fail(x,res);}});
router.get("/platform/establishment-documents/:documentId/download",requireAuth,async(req:AuthenticatedRequest,res)=>{const d=uuid.safeParse(req.params.documentId);if(!d.success){res.status(400).json({error:"INVALID_ID"});return;}try{res.json({url:await getPlatformEstablishmentDocumentDownload(req.auth!.userId,d.data)});}catch(x){fail(x,res);}});
router.patch("/platform/establishment-documents/:documentId/review",requireAuth,async(req:AuthenticatedRequest,res)=>{const d=uuid.safeParse(req.params.documentId),body=z.object({status:z.enum(["approved","rejected"]),reason:z.string().trim().max(1000).optional()}).safeParse(req.body);if(!d.success||!body.success){res.status(400).json({error:"INVALID_PAYLOAD"});return;}if(body.data.status==='rejected'&&!body.data.reason){res.status(400).json({error:"REJECTION_REASON_REQUIRED"});return;}try{res.json({document:await reviewPlatformEstablishmentDocument(req.auth!.userId,d.data,body.data.status,body.data.reason)});}catch(x){fail(x,res);}});
export default router;
