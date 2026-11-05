/**
 * Fechas de los documentos institucionales (D4, 5-nov-2026).
 *
 * Tres situaciones distintas para el vencimiento (migración 150, sin fechas artificiales):
 *   - fecha informada (YYYY-MM-DD) ........ expires_on = fecha, expiry_not_applicable = false;
 *   - «sin vencimiento aplicable» .......... expires_on NULL, expiry_not_applicable = true
 *     (en la API se envía expiresOn = "none");
 *   - «vencimiento no informado» ........... expires_on NULL, expiry_not_applicable = false.
 *
 * Reglas: formato YYYY-MM-DD y fecha de calendario real; emisión entre 1900-01-01 y hoy
 * (Puerto Rico); vencimiento entre 1900-01-01 y 9998-12-31 y nunca anterior a la emisión.
 * Un vencimiento pasado es válido (registra un documento ya vencido).
 */
export const NO_EXPIRY_INPUT = "none";

export class InvalidDocumentDatesError extends Error {
  constructor(readonly field: "issuedOn" | "expiresOn", readonly reason: "FORMAT" | "FUTURE_ISSUE" | "OUT_OF_RANGE" | "EXPIRES_BEFORE_ISSUED") {
    super("INVALID_DOCUMENT_DATES");
  }
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function realDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Hoy en Puerto Rico (las agencias trabajan en America/Puerto_Rico). */
export function todayInPuertoRico(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Puerto_Rico", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export type ExpiryStatus = "date" | "not_applicable" | "not_informed";
export interface StoredExpiry { expiresOn: string | null; notApplicable: boolean }

/**
 * Valida y normaliza. undefined = no se envió (conservar), null/"" = no informado,
 * "none" = sin vencimiento aplicable. `expiry` es undefined si no se envió el vencimiento.
 */
export function normalizeDocumentDates(
  input: { issuedOn?: string | null; expiresOn?: string | null },
  now = new Date(),
): { issuedOn: string | null | undefined; expiry: StoredExpiry | undefined } {
  const clean = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v.trim() === "" ? null : v.trim());
  const issuedOn = clean(input.issuedOn);
  const expiresOn = clean(input.expiresOn);
  if (issuedOn) {
    if (!realDate(issuedOn)) throw new InvalidDocumentDatesError("issuedOn", "FORMAT");
    if (issuedOn < "1900-01-01") throw new InvalidDocumentDatesError("issuedOn", "OUT_OF_RANGE");
    if (issuedOn > todayInPuertoRico(now)) throw new InvalidDocumentDatesError("issuedOn", "FUTURE_ISSUE");
  }
  if (expiresOn === undefined) return { issuedOn, expiry: undefined };
  if (expiresOn === null) return { issuedOn, expiry: { expiresOn: null, notApplicable: false } };
  if (expiresOn.toLowerCase() === NO_EXPIRY_INPUT) return { issuedOn, expiry: { expiresOn: null, notApplicable: true } };
  if (!realDate(expiresOn)) throw new InvalidDocumentDatesError("expiresOn", "FORMAT");
  if (expiresOn < "1900-01-01" || expiresOn > "9998-12-31") throw new InvalidDocumentDatesError("expiresOn", "OUT_OF_RANGE");
  return { issuedOn, expiry: { expiresOn, notApplicable: false } };
}

/** Coherencia final con los valores que quedarán guardados. */
export function assertDocumentDatesCoherent(issuedOn: string | null, expiresOn: string | null) {
  if (issuedOn && expiresOn && expiresOn < issuedOn) {
    throw new InvalidDocumentDatesError("expiresOn", "EXPIRES_BEFORE_ISSUED");
  }
}

/** La base devuelve DATE como texto o Date según el controlador; siempre YYYY-MM-DD o null. */
export function dateText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
