import { PUERTO_RICO_MUNICIPALITIES } from "./smartmatch.municipalities.js";

/**
 * Privacy guardrails for the public metadata of a SmartMatch opportunity.
 * An opportunity may only say WHERE (a municipality) and WHAT ROLE, never
 * WHO (patient names) or the exact address. The frontend mirrors these rules
 * for immediate feedback; the server is authoritative.
 */
export const SMARTMATCH_ROLE_OPTIONS = [
  "Cuidador/a",
  "Acompañante",
  "Asistente de cuidado personal",
  "Cuidado nocturno",
  "Relevo (respiro familiar)",
] as const;

const MUNICIPALITIES = new Set<string>(PUERTO_RICO_MUNICIPALITIES);

export function isPuertoRicoMunicipality(value: string): boolean {
  return MUNICIPALITIES.has(value);
}

/**
 * Free-text role ("Otro") must look like a job title: letters, spaces and a
 * few separators only. Digits, e-mail/phone characters, honorifics and
 * address or patient words are rejected because they usually mean someone
 * typed a name, a phone number or an address.
 */
const FORBIDDEN_ROLE_PATTERNS: RegExp[] = [
  /\d/,                                   // phone numbers, house numbers, ages
  /[@#:;<>{}[\]\\|_=+*$%^~`"]/,           // e-mail, address and markup characters
  /\b(sr|sra|srta|don|doña|dona)\b\.?/i,  // honorifics before a name
  /\b(paciente|residente|participante|diagn[oó]stico|demencia|alzheimer|c[aá]ncer|di[aá]lisis)\b/i,
  /\b(calle|ave|avenida|urb|urbanizaci[oó]n|carr|carretera|apt|apartamento|edif|edificio|barrio|bo|km|cond|condominio)\b\.?/i,
];

export function isSafeRoleLabel(value: string): boolean {
  const role = value.trim();
  if (role.length < 1 || role.length > 60) return false;
  if ((SMARTMATCH_ROLE_OPTIONS as readonly string[]).includes(role)) return true;
  if (!/^[\p{L} /().,'-]+$/u.test(role)) return false;
  return !FORBIDDEN_ROLE_PATTERNS.some((pattern) => pattern.test(role));
}
