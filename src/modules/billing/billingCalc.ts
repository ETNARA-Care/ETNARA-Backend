/**
 * Facturación F2.2 — pure line calculation (no database, no floats).
 *
 * D8 (turnos nocturnos): an approved shift is cut into SEGMENTS at every
 * Puerto Rico midnight; each segment is priced with the rate in force on ITS
 * date (its own holiday, its own rate version). The sum of the segment minutes
 * is exactly the billable time — hours are never duplicated.
 *
 * Unit rules (diseño F2 v2 §9):
 *  - hour:  minimum and rounding applied ONCE to the whole shift with the rules
 *           of the starting segment's rate; the extra minutes go to the last
 *           segment (never two minimums). Line amount = round(Σ minutes×rate / 60)
 *           so splitting a shift never changes the total by a cent.
 *  - shift / fixed: one charge with the rate of the starting segment; the
 *           segments are still shown.
 *  - day:   24 h blocks from the start; each block uses the rate of the date on
 *           which it starts; the remainder follows the F1 half-day policy. The
 *           15-minute tolerance ONLY produces a warning (decision 25-oct): the
 *           billable minutes never change.
 *
 * Money in integer cents, quantities in hundredths, half-up rounding.
 */
import { computeCharge, roundDiv, type FinanceUnit, type HalfDayPolicy } from "../finance/financeCalc.js";

export const AGENCY_TZ = "America/Puerto_Rico";
const MINUTE = 60_000;
const DAY_MINUTES = 1440;

export interface SegmentRate {
  rateId: string;
  amountCents: number;
  source: "client" | "general";
  dayType: "standard" | "holiday";
  holiday: string | null;
  minMinutes: number | null;
  roundingMinutes: number | null;
  halfDayPolicy: HalfDayPolicy | null;
  halfDayAmountCents: number | null;
}

export interface Segment {
  date: string; // YYYY-MM-DD in Puerto Rico
  startsAt: string; // ISO instant
  endsAt: string; // ISO instant
  minutes: number;
  billableMinutes: number;
  rate: SegmentRate | null;
  amountCents: number;
}

export interface LineResult {
  quantityHundredths: number;
  unitPriceCents: number | null; // null when the segments use different prices
  amountCents: number;
  segments: Segment[];
  needsReview: boolean;
  reviewReasons: string[];
  warnings: { code: string; minutes?: number }[];
}

/** Local Puerto Rico calendar parts of an instant (Intl, no fixed offset). */
function localParts(instant: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AGENCY_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
}

export function prDate(instant: number): string {
  const p = localParts(instant);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** The instant of the next Puerto Rico midnight strictly after `instant`. */
function nextLocalMidnight(instant: number): number {
  const p = localParts(instant);
  const localAsUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  const offset = localAsUtc - Math.floor(instant / 1000) * 1000; // local - utc
  return Date.UTC(p.y, p.m - 1, p.d + 1) - offset;
}

/**
 * Cuts [start, start + minutes) at every PR midnight. Minutes are integers and
 * the segments add up exactly to `minutes`.
 */
export function splitAtMidnight(startIso: string, minutes: number): { date: string; startsAt: number; endsAt: number; minutes: number }[] {
  if (!Number.isSafeInteger(minutes) || minutes <= 0) throw new RangeError("MINUTES_INVALID");
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) throw new RangeError("START_INVALID");
  const end = start + minutes * MINUTE;
  const out: { date: string; startsAt: number; endsAt: number; minutes: number }[] = [];
  let cursor = start;
  let left = minutes;
  while (left > 0) {
    const cut = Math.min(end, nextLocalMidnight(cursor));
    let m = Math.round((cut - cursor) / MINUTE);
    if (m <= 0) m = 1; // never a zero-length segment (sub-minute starts)
    if (m > left) m = left;
    out.push({ date: prDate(cursor), startsAt: cursor, endsAt: cursor + m * MINUTE, minutes: m });
    cursor += m * MINUTE;
    left -= m;
  }
  return out;
}

const ceilTo = (n: number, step: number) => (n % step === 0 ? n : n + (step - (n % step)));

/**
 * Price one approved shift. `rateFor(date)` returns the billing rate in force
 * on that PR date (already resolved with holidays and client priority), or
 * null when there is none.
 */
export function priceShift(unit: FinanceUnit, startIso: string, approvedMinutes: number,
  rateFor: (date: string) => SegmentRate | null, opts: { toleranceMinutes?: number } = {}): LineResult {
  const raw = splitAtMidnight(startIso, approvedMinutes);
  const segments: Segment[] = raw.map((s) => ({
    date: s.date, startsAt: new Date(s.startsAt).toISOString(), endsAt: new Date(s.endsAt).toISOString(),
    minutes: s.minutes, billableMinutes: s.minutes, rate: rateFor(s.date), amountCents: 0,
  }));
  const reviewReasons: string[] = [];
  const warnings: LineResult["warnings"] = [];
  const first = segments[0];

  if (unit === "hour") {
    if (segments.some((s) => !s.rate)) reviewReasons.push("NO_BILLING_RATE");
    let billable = approvedMinutes;
    const rules = first.rate;
    if (rules?.minMinutes && billable < rules.minMinutes) billable = rules.minMinutes;
    if (rules?.roundingMinutes) billable = ceilTo(billable, rules.roundingMinutes);
    segments[segments.length - 1].billableMinutes += billable - approvedMinutes;
    if (reviewReasons.length) return done(0, null, billable * 100 / 60);
    let numerator = 0;
    for (const s of segments) numerator += s.billableMinutes * s.rate!.amountCents;
    const total = roundDiv(numerator, 60);
    let allocated = 0;
    segments.forEach((s, i) => {
      s.amountCents = i === segments.length - 1 ? total - allocated : roundDiv(s.billableMinutes * s.rate!.amountCents, 60);
      allocated += s.amountCents;
    });
    const prices = new Set(segments.map((s) => s.rate!.amountCents));
    return done(total, prices.size === 1 ? first.rate!.amountCents : null, roundDiv(billable * 100, 60));
  }

  if (unit === "shift" || unit === "fixed") {
    if (!first.rate) { reviewReasons.push("NO_BILLING_RATE"); return done(0, null, 100); }
    first.amountCents = first.rate.amountCents;
    return done(first.rate.amountCents, first.rate.amountCents, 100);
  }

  // day: 24 h blocks from the real start, each priced on the date it starts.
  const start = Date.parse(startIso);
  const fullDays = Math.floor(approvedMinutes / DAY_MINUTES);
  const remainder = approvedMinutes % DAY_MINUTES;
  const segmentAt = (instant: number) => segments.find((s) => Date.parse(s.startsAt) <= instant && instant < Date.parse(s.endsAt)) ?? segments[segments.length - 1];
  let total = 0;
  let quantity = 0;
  const prices = new Set<number>();
  for (let i = 0; i < fullDays; i++) {
    const at = start + i * DAY_MINUTES * MINUTE;
    const seg = segmentAt(at);
    const rate = rateFor(prDate(at));
    if (!rate) { reviewReasons.push("NO_BILLING_RATE"); continue; }
    seg.amountCents += rate.amountCents; total += rate.amountCents; quantity += 100; prices.add(rate.amountCents);
  }
  if (remainder > 0) {
    const at = start + fullDays * DAY_MINUTES * MINUTE;
    const rate = rateFor(prDate(at));
    if (!rate) reviewReasons.push("NO_BILLING_RATE");
    else {
      const part = computeCharge("day", remainder, {
        amountCents: rate.amountCents, halfDayPolicy: rate.halfDayPolicy, halfDayAmountCents: rate.halfDayAmountCents,
      });
      if (part.needsReview && part.reviewReason) reviewReasons.push(part.reviewReason);
      segmentAt(at).amountCents += part.amountCents; total += part.amountCents; quantity += part.quantityHundredths; prices.add(rate.amountCents);
    }
    const tolerance = opts.toleranceMinutes ?? 15;
    if (DAY_MINUTES - remainder <= tolerance) warnings.push({ code: "DAY_ALMOST_COMPLETE", minutes: DAY_MINUTES - remainder });
  }
  if (reviewReasons.includes("NO_BILLING_RATE")) { segments.forEach((s) => (s.amountCents = 0)); total = 0; }
  return done(total, prices.size === 1 ? [...prices][0] : null, quantity);

  function done(amount: number, unitPrice: number | null, quantityHundredths: number): LineResult {
    return {
      quantityHundredths: Math.round(quantityHundredths), unitPriceCents: unitPrice, amountCents: amount, segments,
      needsReview: reviewReasons.length > 0, reviewReasons: [...new Set(reviewReasons)], warnings,
    };
  }
}

/** Manual and discount lines: quantity (hundredths) × unit price, half-up. */
export function priceManual(quantityHundredths: number, unitPriceCents: number): number {
  if (!Number.isSafeInteger(quantityHundredths) || quantityHundredths <= 0) throw new RangeError("QUANTITY_INVALID");
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0) throw new RangeError("PRICE_INVALID");
  return roundDiv(quantityHundredths * unitPriceCents, 100);
}

export type TaxTreatment = "taxable" | "exempt" | "pending";
export interface TotalsLine { amountCents: number; taxTreatment: TaxTreatment; taxRateBasisPoints: number | null }

/**
 * Subtotal and tax by rate group (§10): tax per taxable group on its base after
 * discounts, half-up to the cent. Nothing is assumed: "pending" lines carry no
 * tax and block issuing. A group whose base is negative is flagged.
 */
export function invoiceTotals(lines: TotalsLine[]) {
  const subtotal = lines.reduce((sum, l) => sum + l.amountCents, 0);
  const groups = new Map<number, number>();
  let exemptBase = 0;
  let pendingBase = 0;
  for (const l of lines) {
    if (l.taxTreatment === "taxable" && l.taxRateBasisPoints != null) groups.set(l.taxRateBasisPoints, (groups.get(l.taxRateBasisPoints) ?? 0) + l.amountCents);
    else if (l.taxTreatment === "exempt") exemptBase += l.amountCents;
    else pendingBase += l.amountCents;
  }
  const taxes = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([rate, base]) => ({
    rateBasisPoints: rate, baseCents: base, taxCents: base > 0 ? roundDiv(base * rate, 10000) : 0, negativeBase: base < 0,
  }));
  const taxTotal = taxes.reduce((s, t) => s + t.taxCents, 0);
  return {
    subtotalCents: subtotal, taxes, exemptBaseCents: exemptBase, pendingBaseCents: pendingBase,
    taxCents: taxTotal, totalCents: subtotal + taxTotal,
    taxPending: lines.some((l) => l.taxTreatment === "pending"),
    negativeTotal: subtotal + taxTotal < 0,
  };
}
