import { ResidentialError } from "./residentialErrors.js";

/** 177 (F5): rango libre de días locales, como máximo 31 (decisión de Rafa, 26-nov). */
export const REPORT_MAX_DAYS = 31;
const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/;
export function reportRange(from: unknown, to: unknown): { from: string; to: string; days: number } {
  const f = typeof from === "string" ? from : "", t = typeof to === "string" ? to : "";
  if (!LOCAL_DAY.test(f) || !LOCAL_DAY.test(t)) throw new ResidentialError("INVALID_INPUT", 400);
  const a = Date.parse(`${f}T00:00:00Z`), b = Date.parse(`${t}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || new Date(a).toISOString().slice(0, 10) !== f || new Date(b).toISOString().slice(0, 10) !== t) throw new ResidentialError("INVALID_INPUT", 400);
  const days = Math.round((b - a) / 86_400_000) + 1;
  if (days < 1 || days > REPORT_MAX_DAYS) throw new ResidentialError("RESIDENTIAL_REPORT_RANGE_INVALID", 400);
  return { from: f, to: t, days };
}
