// Orden de Suscripción (153): condiciones individuales por agencia, SIEMPRE como propuesta.
// Reglas puras, sin acceso a la base (se prueban sin servidor).

/**
 * Programa Agencias Fundadoras: CONFIGURACIÓN COMERCIAL PENDIENTE DE APROBACIÓN DEFINITIVA.
 * Describe la oferta propuesta; no fija precios, no crea cobros ni suscripciones. Las condiciones que
 * reciba cada agencia se escriben en SU Orden y requieren aprobación comercial, jurídica y su aceptación.
 */
export const FOUNDING_PROGRAM = {
  code: "AGENCIAS_FUNDADORAS",
  status: "pending_definitive_approval" as const,
  maxAgencies: 10,
  proposedBenefits: [
    "Primer mes sin costo desde la activación efectiva (propuesta).",
    "Acceso temporal a las funcionalidades premium habilitadas durante ese mes (propuesta).",
  ],
  note: "Configuración comercial pendiente de aprobación definitiva. No establece tarifas ni activa cobros.",
};
export const FOUNDING_PROGRAM_LIMIT = FOUNDING_PROGRAM.maxAgencies;

/** Condiciones individuales que Central propone para UNA agencia. Todo es propuesta. */
export interface OrderTermsInput {
  planName: string;
  features: string[];
  limits?: string | null;
  /** Precio mensual PROPUESTO; ausente o null = «por definir y aceptar». Nunca hay precio predeterminado. */
  proposedMonthlyPriceUsd?: number | null;
  promotions?: Array<{ description: string; durationDays?: number | null }>;
  addOns?: Array<{ name: string; proposedMonthlyPriceUsd?: number | null }>;
  conditions?: string[];
  foundingProgram?: boolean;
}
export interface OrderTerms {
  schema: 2; status: "proposal"; planName: string; features: string[]; limits: string | null;
  pricing: { currency: "USD"; proposedMonthlyPriceUsd: number | null; isProposal: true };
  promotions: Array<{ description: string; durationDays: number | null }>;
  addOns: Array<{ name: string; proposedMonthlyPriceUsd: number | null; optional: true }>;
  conditions: string[];
  foundingProgram: { enrolled: true; programStatus: "pending_definitive_approval"; proposedBenefits: string[] } | null;
  chargesRequireExpressAcceptance: true; automaticCharges: false; automaticRenewal: false; billingActivated: false;
}
/** Normaliza: las salvaguardas (sin cobro ni renovación automáticos, facturación apagada) las fija el servidor. */
export function normalizeOrderTerms(i: OrderTermsInput): OrderTerms {
  const price = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.round(x * 100) / 100 : null);
  return {
    schema: 2, status: "proposal", planName: i.planName.trim(), features: i.features.map((f) => f.trim()).filter(Boolean),
    limits: i.limits?.trim() || null,
    pricing: { currency: "USD", proposedMonthlyPriceUsd: price(i.proposedMonthlyPriceUsd), isProposal: true },
    promotions: (i.promotions ?? []).map((p) => ({ description: p.description.trim(), durationDays: p.durationDays ?? null })),
    addOns: (i.addOns ?? []).map((a) => ({ name: a.name.trim(), proposedMonthlyPriceUsd: price(a.proposedMonthlyPriceUsd), optional: true as const })),
    conditions: (i.conditions ?? []).map((c) => c.trim()).filter(Boolean),
    foundingProgram: i.foundingProgram ? { enrolled: true, programStatus: FOUNDING_PROGRAM.status, proposedBenefits: [...FOUNDING_PROGRAM.proposedBenefits] } : null,
    chargesRequireExpressAcceptance: true, automaticCharges: false, automaticRenewal: false, billingActivated: false,
  };
}
const usd = (x: number | null) => (x === null ? "POR DEFINIR Y ACEPTAR" : `US$${x.toFixed(2)} al mes (PROPUESTA, sujeta a aprobación y a la aceptación expresa de la Agencia)`);
/** Texto de la Orden generado de sus condiciones. La de prueba lleva la marca obligatoria. */
export function subscriptionOrderBody(orgName: string, t: OrderTerms, isTest: boolean) {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `   - ${x}`).join("\n") : "   - Ninguna.");
  return `${isTest ? "DOCUMENTO FICTICIO DE PRUEBA — sin valor legal. No es una Orden de Suscripción real.\n\n" : ""}ORDEN DE SUSCRIPCIÓN — ETNARA CARE
Proveedor: DE LA VEGA TECHNOLOGY LLC (ETNARA Care). Agencia: ${orgName}.
Esta Orden forma parte del Contrato General de Suscripción y Servicios y se rige por él.
ESTADO: PROPUESTA COMERCIAL PENDIENTE DE APROBACIÓN COMERCIAL Y JURÍDICA. No genera cargos.

1. Plan propuesto: ${t.planName}.
2. Funcionalidades:
${list(t.features)}
3. Límites: ${t.limits ?? "Según el plan, por definir."}
4. Precio mensual: ${usd(t.pricing.proposedMonthlyPriceUsd)}. Impuestos según la ley aplicable.
5. Promociones:
${list(t.promotions.map((p) => p.description + (p.durationDays ? ` (${p.durationDays} días)` : "")))}
6. Complementos opcionales:
${list(t.addOns.map((a) => `${a.name}: ${a.proposedMonthlyPriceUsd === null ? "precio por definir y aceptar" : `US$${a.proposedMonthlyPriceUsd.toFixed(2)} al mes (propuesta)`}`))}
7. Condiciones particulares:
${list(t.conditions)}
8. Programa Agencias Fundadoras: ${t.foundingProgram ? `incluida, como configuración comercial PENDIENTE DE APROBACIÓN DEFINITIVA:\n${list(t.foundingProgram.proposedBenefits)}` : "no aplica."}
9. Cargos y renovación: ningún cargo, renovación o suscripción se activa sin la aceptación expresa y separada de la Agencia. Esta Orden no activa cobros automáticos ni renovaciones automáticas; la facturación permanece desactivada.
`;
}

