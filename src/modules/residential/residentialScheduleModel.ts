/**
 * 172 · Hogares F2: cálculos puros del calendario semanal (sin base de datos, para probarlos solos).
 *
 * Puerto Rico no tiene horario de verano: la hora local es siempre UTC−4. Las horas de un turno que cruza la
 * medianoche se reparten entre los días en que caen (23:00–07:00 → 1 h el primer día y 7 h el siguiente).
 */
export const PR_OFFSET_MINUTES = -240;

export interface ScheduleEntryLike {
  id: string;
  startsAt: Date;
  endsAt: Date;
  membershipId: string | null;
  requiredRole: string;
}

/** Fecha local (YYYY-MM-DD) de Puerto Rico de un instante. */
export function localDate(at: Date): string {
  return new Date(at.getTime() + PR_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/** Minutos de cada día local que ocupa un intervalo. */
export function minutesByLocalDay(start: Date, end: Date): Map<string, number> {
  const out = new Map<string, number>();
  let cursor = start.getTime();
  const stop = end.getTime();
  while (cursor < stop) {
    const day = localDate(new Date(cursor));
    // Siguiente medianoche local (UTC−4): 04:00 UTC del día siguiente.
    const nextMidnight = Date.parse(`${day}T00:00:00Z`) - PR_OFFSET_MINUTES * 60_000 + 24 * 3_600_000;
    const segmentEnd = Math.min(nextMidnight, stop);
    out.set(day, (out.get(day) ?? 0) + Math.round((segmentEnd - cursor) / 60_000));
    cursor = segmentEnd;
  }
  return out;
}

export type ScheduleWarning =
  | { type: "duplicate"; membershipId: string; entryIds: string[] }
  | { type: "overlap"; membershipId: string; entryIds: string[] };

/**
 * Avisos del calendario: una misma persona en dos entradas que se solapan («overlap»), o dos veces en la misma
 * entrada exacta («duplicate»). Las plazas sin persona no se comparan (varias plazas iguales son normales).
 */
export function scheduleWarnings(entries: ScheduleEntryLike[]): ScheduleWarning[] {
  const byWorker = new Map<string, ScheduleEntryLike[]>();
  for (const e of entries) if (e.membershipId) byWorker.set(e.membershipId, [...(byWorker.get(e.membershipId) ?? []), e]);
  const out: ScheduleWarning[] = [];
  for (const [membershipId, list] of byWorker) {
    const sorted = [...list].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i], b = sorted[j];
        if (b.startsAt.getTime() >= a.endsAt.getTime()) break;
        const same = a.startsAt.getTime() === b.startsAt.getTime() && a.endsAt.getTime() === b.endsAt.getTime();
        out.push({ type: same ? "duplicate" : "overlap", membershipId, entryIds: [a.id, b.id] });
      }
    }
  }
  return out;
}

/** Horas programadas: total, por persona y por día local (repartiendo los turnos nocturnos). */
export function scheduleSummary(entries: ScheduleEntryLike[]) {
  const byWorker = new Map<string, number>();
  const byDay = new Map<string, number>();
  let total = 0;
  let unassigned = 0;
  for (const e of entries) {
    const minutes = Math.round((e.endsAt.getTime() - e.startsAt.getTime()) / 60_000);
    total += minutes;
    if (e.membershipId) byWorker.set(e.membershipId, (byWorker.get(e.membershipId) ?? 0) + minutes);
    else unassigned += 1;
    for (const [day, m] of minutesByLocalDay(e.startsAt, e.endsAt)) byDay.set(day, (byDay.get(day) ?? 0) + m);
  }
  return {
    totalMinutes: total,
    unassignedEntries: unassigned,
    byWorker: [...byWorker].map(([membershipId, minutes]) => ({ membershipId, minutes })),
    byDay: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, minutes]) => ({ date, minutes })),
  };
}

/** Desplaza una fecha local «YYYY-MM-DD» n días. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
