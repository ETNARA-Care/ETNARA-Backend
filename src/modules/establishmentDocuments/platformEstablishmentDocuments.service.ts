import { withPlatformContext } from "../../context/tenantContext.js";

/**
 * ETNARA Central NO tiene acceso permanente a los documentos institucionales de las agencias
 * (decisión de producto del 1-nov-2026, PR 1 de ETNARA Verified).
 *
 * - Ninguna de estas funciones consulta la tabla `establishment_documents` ni firma URL de descarga.
 * - La migración 140 lo impone también en la base: política RESTRICTIVA `platform_phi_deny`
 *   (0 filas para un superadministrador) y se retiran las políticas de revisión de Central de la 125.
 * - Se sigue exigiendo un superadministrador real (`withPlatformContext`) para que los demás
 *   usuarios reciban el mismo 403 de siempre.
 *
 * La cola responde 200 con una lista vacía para no romper el portal de Central, que la usa en
 * su resumen. Abrir o revisar un documento responde 403. El acceso futuro será solo por
 * autorización expresa y temporal de la agencia, documento por documento (PR 2, no incluido aquí).
 */
export class PlatformDocumentAccessClosedError extends Error {
  constructor() { super("PLATFORM_PRIVATE_DOCUMENT_ACCESS_DENIED"); this.name = "PlatformDocumentAccessClosedError"; }
}

export const PLATFORM_DOCUMENT_ACCESS_MODEL = "AGENCY_AUTHORIZATION_REQUIRED" as const;

export async function listPlatformEstablishmentDocumentQueue(userId: string): Promise<never[]> {
  await withPlatformContext(userId, async () => undefined);
  return [];
}

export async function getPlatformEstablishmentDocumentDownload(userId: string, _documentId: string): Promise<never> {
  await withPlatformContext(userId, async () => undefined);
  throw new PlatformDocumentAccessClosedError();
}

export async function reviewPlatformEstablishmentDocument(
  userId: string, _documentId: string, _status: "approved" | "rejected", _reason?: string,
): Promise<never> {
  await withPlatformContext(userId, async () => undefined);
  throw new PlatformDocumentAccessClosedError();
}
