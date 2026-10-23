/** Gate 6: pure proximity math for "Llegué" (no I/O, unit-tested). */

/** Arrival counts as "near" within this radius (plus the reading's accuracy, capped). */
export const ARRIVAL_RADIUS_M = 200;
const MAX_ACCURACY_CREDIT_M = 100;

/** Great-circle distance in meters. */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** NEAR / FAR from one reading; distance rounded to 10 m. */
export function classifyProximity(distance: number, accuracy: number | undefined) {
  const credit = Math.min(Math.max(accuracy ?? 0, 0), MAX_ACCURACY_CREDIT_M);
  return {
    proximity: distance <= ARRIVAL_RADIUS_M + credit ? ("NEAR" as const) : ("FAR" as const),
    distanceM: Math.round(distance / 10) * 10,
  };
}
