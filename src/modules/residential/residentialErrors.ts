/**
 * 171 · Errores de las guardas de hogares (RAISE EXCEPTION 'RESIDENTIAL_*' en la base de datos, P0001).
 * Se devuelven como 409 con su código: son reglas de negocio, no fallos del servidor.
 */
// 173–175 (F4): también los códigos ATTENDANCE_* de las guardas de ponches.
const RESIDENTIAL_CODE = /^(RESIDENTIAL_[A-Z_]+|ATTENDANCE_[A-Z_]+|MODALITY_NOT_AVAILABLE)$/;

export function residentialDbErrorCode(error: unknown): string | null {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (!e || e.code !== "P0001" || typeof e.message !== "string") return null;
  return RESIDENTIAL_CODE.test(e.message) ? e.message : null;
}

/** Códigos que significan «no existe o no es tuyo», no conflicto. */
export const RESIDENTIAL_NOT_FOUND = "RESIDENTIAL_NOT_FOUND";
export const RESIDENTIAL_MANAGER_REQUIRED = "RESIDENTIAL_MANAGER_REQUIRED";

export function residentialDbErrorStatus(code: string): number {
  if (code === RESIDENTIAL_NOT_FOUND) return 404;
  if (code === RESIDENTIAL_MANAGER_REQUIRED || code === "MODALITY_NOT_AVAILABLE" || code === "ATTENDANCE_NOT_AUTHORIZED" || code === "ATTENDANCE_SELF_REVIEW") return 403;
  return 409;
}

export class ResidentialError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}
