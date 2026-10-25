/**
 * ETNARA Finanzas F1 — pure money calculation (no database, no floats).
 *
 * Every amount is an integer number of cents and every quantity an integer
 * number of minutes. Division rounds half up to the cent (same rule as the
 * existing approved timesheets). Nothing here decides labour or tax rules:
 * whatever is not clear-cut comes back as `needsReview` for the agency.
 */

export type FinanceUnit = "hour" | "shift" | "day" | "fixed";
export type HalfDayPolicy = "review" | "proportional" | "fixed";

export interface RateRules {
  amountCents: number;
  minMinutes?: number | null;
  roundingMinutes?: number | null;
  halfDayPolicy?: HalfDayPolicy | null;
  halfDayAmountCents?: number | null;
}

export interface ChargeResult {
  /** Billable quantity in hundredths of the unit (150 = 1.5 hours or days). */
  quantityHundredths: number;
  amountCents: number;
  needsReview: boolean;
  reviewReason: string | null;
  detail: string;
}

const MINUTES_PER_DAY = 1440;
const HALF_DAY = 720;

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label}_INVALID`);
}

/** n / d rounded half up, for non-negative integers, without floating point. */
export function roundDiv(n: number, d: number): number {
  assertNonNegativeInteger(n, "NUMERATOR");
  if (!Number.isSafeInteger(d) || d <= 0) throw new RangeError("DENOMINATOR_INVALID");
  const remainder = n % d;
  const quotient = (n - remainder) / d;
  return remainder * 2 >= d ? quotient + 1 : quotient;
}

/** Ceil n to the next multiple of step (integers). */
function ceilTo(n: number, step: number): number {
  const remainder = n % step;
  return remainder === 0 ? n : n + (step - remainder);
}

/**
 * Charge (or pay) for one service occurrence.
 *  - hour:  billable minutes (minimum, then rounded up to the increment) × rate / 60
 *  - shift: one unit per completed shift, whatever its length
 *  - fixed: one charge per service provided, whatever its length
 *  - day:   one unit per full 24 h block; the remainder follows the half-day
 *           policy: "review" (default, the agency decides), "proportional"
 *           (remainder / 1440 of the day rate) or "fixed" (the half-day amount
 *           for a remainder up to 12 h; longer remainders go to review).
 *           A 24 h service is one day, never 24 billable hours.
 */
export function computeCharge(unit: FinanceUnit, minutes: number, rules: RateRules): ChargeResult {
  assertNonNegativeInteger(minutes, "MINUTES");
  assertNonNegativeInteger(rules.amountCents, "AMOUNT");

  if (unit === "shift" || unit === "fixed") {
    return {
      quantityHundredths: 100,
      amountCents: rules.amountCents,
      needsReview: false,
      reviewReason: null,
      detail: unit === "shift" ? "1 turno" : "Precio fijo",
    };
  }

  if (unit === "hour") {
    let billable = minutes;
    if (rules.minMinutes && billable < rules.minMinutes) billable = rules.minMinutes;
    if (rules.roundingMinutes) billable = ceilTo(billable, rules.roundingMinutes);
    return {
      quantityHundredths: roundDiv(billable * 100, 60),
      amountCents: roundDiv(billable * rules.amountCents, 60),
      needsReview: false,
      reviewReason: null,
      detail: `${billable} min facturables`,
    };
  }

  // day
  const fullDays = (minutes - (minutes % MINUTES_PER_DAY)) / MINUTES_PER_DAY;
  const remainder = minutes % MINUTES_PER_DAY;
  const fullAmount = fullDays * rules.amountCents;
  if (remainder === 0) {
    return { quantityHundredths: fullDays * 100, amountCents: fullAmount, needsReview: fullDays === 0, reviewReason: fullDays === 0 ? "NO_TIME" : null, detail: `${fullDays} día(s)` };
  }
  const policy = rules.halfDayPolicy ?? "review";
  if (policy === "proportional") {
    return {
      quantityHundredths: fullDays * 100 + roundDiv(remainder * 100, MINUTES_PER_DAY),
      amountCents: fullAmount + roundDiv(remainder * rules.amountCents, MINUTES_PER_DAY),
      needsReview: false,
      reviewReason: null,
      detail: `${fullDays} día(s) + ${remainder} min proporcionales`,
    };
  }
  if (policy === "fixed" && remainder <= HALF_DAY && rules.halfDayAmountCents != null) {
    return {
      quantityHundredths: fullDays * 100 + 50,
      amountCents: fullAmount + rules.halfDayAmountCents,
      needsReview: false,
      reviewReason: null,
      detail: `${fullDays} día(s) + medio día`,
    };
  }
  return {
    quantityHundredths: fullDays * 100,
    amountCents: fullAmount,
    needsReview: true,
    reviewReason: "PARTIAL_DAY",
    detail: `${fullDays} día(s) completos + ${remainder} min por decidir`,
  };
}

/**
 * Estimated gross margin between what is billed and what is paid for the same
 * occurrence. It is NOT net profit: it ignores payroll taxes, insurance, travel
 * and every other cost. Basis points (10000 = 100 %); null when nothing is billed.
 */
export function grossMargin(billCents: number, payCents: number): { differenceCents: number; marginBasisPoints: number | null } {
  if (!Number.isSafeInteger(billCents) || !Number.isSafeInteger(payCents)) throw new RangeError("AMOUNT_INVALID");
  const differenceCents = billCents - payCents;
  if (billCents <= 0) return { differenceCents, marginBasisPoints: null };
  const sign = differenceCents < 0 ? -1 : 1;
  return { differenceCents, marginBasisPoints: sign * roundDiv(Math.abs(differenceCents) * 10000, billCents) };
}

/** Parses "25", "25.5", "25.50", "$1,025.00" into cents without floats. */
export function parseDollarsToCents(input: string): number {
  const cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "");
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) throw new RangeError("AMOUNT_INVALID");
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new RangeError("AMOUNT_INVALID");
  return cents;
}
