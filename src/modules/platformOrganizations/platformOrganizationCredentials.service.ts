import { withPlatformContext } from "../../context/tenantContext.js";

/**
 * 149 (5-nov-2026): ETNARA Central no revisa, aprueba ni supervisa las credenciales del personal de
 * las agencias; cada agencia es responsable. Esta ruta queda solo para que un portal de Central
 * antiguo (en caché) no falle durante la transición: exige un superadministrador real y responde
 * `summary: null` sin consultar ninguna tabla. La base lo impone también (platform_phi_deny en
 * credentials, credential_platform_verifications, organization_credential_reviews y
 * organization_document_version_reviews).
 */
export const PLATFORM_CREDENTIAL_ACCESS_MODEL = "AGENCY_RESPONSIBILITY" as const;

export async function getPlatformOrganizationCredentialSummary(userId: string, _organizationId: string): Promise<null> {
  await withPlatformContext(userId, async () => undefined);
  return null;
}
