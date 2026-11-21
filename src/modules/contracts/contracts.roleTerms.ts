// Términos individuales por función (156): reglas puras, sin acceso a la base (se prueban sin servidor).
export type RoleTermsRole = "ADMINISTRATION" | "CAREGIVER" | "FAMILY";
export const ROLE_TERMS_ROLES: RoleTermsRole[] = ["ADMINISTRATION", "CAREGIVER", "FAMILY"];

/** Referencia de aprobación jurídica con los datos que escribe Central (la base exige esta forma). */
export const legalReference = (approverName: string, approvedOn: string, documentReference: string) =>
  `Aprobado por: ${approverName.trim()} | Fecha: ${approvedOn} | Referencia: ${documentReference.trim()}`;

const ROLE_LINE: Record<RoleTermsRole, string> = { ADMINISTRATION: "E.2.", CAREGIVER: "E.3.", FAMILY: "E.4." };
export const ROLE_TITLE: Record<RoleTermsRole, string> = {
  ADMINISTRATION: "Términos individuales por función — Administración",
  CAREGIVER: "Términos individuales por función — Cuidadores",
  FAMILY: "Términos individuales por función — Familiares",
};
/**
 * Arma, con líneas ÍNTEGRAS del contrato fuente, el texto de cada función: el encabezado del Anexo E,
 * E.1, la línea de la función (E.2, E.3 o E.4), E.5, E.6, E.7 y E.8. Si el contrato es de prueba, la
 * primera línea (marca de prueba) también se copia. No redacta nada: la base vuelve a comprobarlo.
 */
export function roleTermsFromAnnex(sourceBody: string, role: RoleTermsRole): string {
  const lines = sourceBody.split("\n").map((l) => l.trim());
  const start = lines.findIndex((l) => /^ANEXO E\b/.test(l));
  if (start < 0) throw new Error("ROLE_TERMS_ANNEX_NOT_FOUND");
  const annex: string[] = [];
  for (const l of lines.slice(start + 1)) { if (/^ANEXO [A-Z]\b/.test(l) || l.startsWith("[")) break; if (/^E\.\d+\./.test(l)) annex.push(l); }
  const pick = (p: string) => { const l = annex.find((x) => x.startsWith(p)); if (!l) throw new Error("ROLE_TERMS_ANNEX_NOT_FOUND"); return l; };
  const out = [lines[start], pick("E.1."), pick(ROLE_LINE[role]), pick("E.5."), pick("E.6."), pick("E.7."), pick("E.8.")];
  if (lines[0].startsWith("DOCUMENTO FICTICIO DE PRUEBA")) out.unshift(lines[0]);
  return out.join("\n\n") + "\n";
}

