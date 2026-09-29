import { Router, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { UnauthorizedPlatformAccessError } from "../../context/errors.js";
import { createPlatformOrganization, createPlatformOrganizationSchema, inviteOrganizationAdmin, inviteOrganizationAdminSchema, listPlatformOrganizations } from "./platformOrganizations.service.js";

const router=Router();
function handle(error:unknown,res:Response){if(error instanceof UnauthorizedPlatformAccessError){res.status(403).json({error:"PLATFORM_ADMIN_REQUIRED"});return;}if(error instanceof Error&&error.message==="ORGANIZATION_NOT_FOUND"){res.status(404).json({error:"ORGANIZATION_NOT_FOUND"});return;}if(error instanceof Error&&error.message==="INVITATION_ALREADY_PENDING"){res.status(409).json({error:"INVITATION_ALREADY_PENDING"});return;}console.error("Unexpected platform organization failure",error instanceof Error?{name:error.name,message:error.message}:{});res.status(500).json({error:"INTERNAL_ERROR"});}
router.get("/platform/organizations",requireAuth,async(req:AuthenticatedRequest,res)=>{try{res.json({organizations:await listPlatformOrganizations(req.auth!.userId)});}catch(error){handle(error,res);}});
router.post("/platform/organizations",requireAuth,async(req:AuthenticatedRequest,res)=>{const parsed=createPlatformOrganizationSchema.safeParse(req.body);if(!parsed.success)return void res.status(400).json({error:"INVALID_ORGANIZATION"});try{res.status(201).json({organization:await createPlatformOrganization(req.auth!.userId,parsed.data)});}catch(error){handle(error,res);}});
router.post("/platform/organizations/:organizationId/admin-invitations",requireAuth,async(req:AuthenticatedRequest,res)=>{const parsed=inviteOrganizationAdminSchema.safeParse(req.body);if(!parsed.success)return void res.status(400).json({error:"INVALID_INVITATION"});try{const result=await inviteOrganizationAdmin(req.auth!.userId,req.params.organizationId,parsed.data.email);res.status(201).json({invitation:result.invitation,activationToken:result.rawToken});}catch(error){handle(error,res);}});
export default router;
