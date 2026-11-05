import { withPlatformContext } from "../../context/tenantContext.js";

/**
 * ETNARA Central NO revisa, aprueba, certifica ni descarga los documentos institucionales de las
 * agencias (decisión de producto del 5-nov-2026; cierre tomado del #247). Cada agencia es
 * responsable de su documentación.
 *
 * - Ninguna de estas funciones consulta `establishment_documents` ni firma URL de descarga.
 * - La migración 149 lo impone también en la base: política RESTRICTIVA `platform_phi_deny`
 *   (0 filas para un superadministrador), sin las políticas de revisión de Central de la 125, y las
 *   columnas de revisión congeladas como historial.
 * - Se sigue exigiendo un superadministrador real (`withPlatformContext`): los demás usuarios
 *   reciben el mismo 403 de siempre.
 *
 * La cola responde 200 con una lista vacía para que un portal de Central antiguo (en caché) no
 * falle durante la transición. Abrir o decidir sobre un documento responde 403.
 */
export class PlatformDocumentAccessClosedError extends Error {
  constructor() { super("PLATFORM_PRIVATE_DOCUMENT_ACCESS_DENIED"); this.name = "PlatformDocumentAccessClosedError"; }
}

export const PLATFORM_DOCUMENT_ACCESS_MODEL = "AGENCY_RESPONSIBILITY" as const;

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
