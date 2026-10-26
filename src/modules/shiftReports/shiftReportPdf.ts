import PDFDocument from "pdfkit";

/**
 * Informe de Turno F3 — the family PDF (letter size, es-PR). Built ONLY from the
 * family projection of the approved version (app_shift_report_family_project):
 * the same fields the family portal shows, nothing else. No internal ids except the
 * report id, no location data, no clinical records, no photos. ETNARA colors:
 * navy, cream and sage. Standard PDF fonts (WinAnsi) cover Spanish; no font files.
 */
export const SHIFT_REPORT_PDF_VERSION = "shift-report-pdf-1";

interface Item { at: string; note?: string | null; [k: string]: unknown }
export interface FamilyShiftReport {
  id: string; version: number; status: string; approvedAt: string; serviceDate: string;
  organization: { name: string | null }; recipient: { name: string | null }; caregiver: { name: string | null };
  agencySummary: string | null; shown: string[];
  sections: {
    schedule?: { scheduledStart: string; scheduledEnd: string; arrivalAt: string | null; startAt: string | null; endAt: string | null };
    meals?: Item[]; hydration?: Item[]; activities?: Item[]; mobility?: Item[]; hygiene?: Item[]; mood?: Item[];
    observations?: { notes: Array<{ at: string; text: string | null }>; caregiverNote: { at: string; text: string } | null };
    incidents?: Array<{ at: string; severity: string | null; description: string | null }>;
  };
}

const NAVY = "#16213D", CREAM = "#F7F3EA", SAGE = "#7C9A82", MUTED = "#5B6475", LINE = "#D9DCE3";
const TZ = "America/Puerto_Rico";
/** Non-breaking spaces (WinAnsi 0xA0): «9:44 p. m.» is never split across lines. */
const keep = (t: string) => t.replace(/[\s\u202f]+/g, "\u00a0");
export const time = (v: string | null | undefined) => (v ? keep(new Date(v).toLocaleTimeString("es-PR", { timeZone: TZ, hour: "numeric", minute: "2-digit" })) : "—");
/** Puerto Rico calendar day (YYYY-MM-DD). */
const dayKey = (v: string) => new Date(v).toLocaleDateString("en-CA", { timeZone: TZ });
/**
 * Same rule as the portal: a time that falls on another day than the shift's day also
 * shows its date («24 oct»). Visits can cross midnight or stay open several days; the
 * records are shown exactly as stored, only labelled with their day.
 */
export const otherDay = (v: string | null | undefined, refDay: string) =>
  v && dayKey(v) !== refDay ? keep(new Date(v).toLocaleDateString("es-PR", { timeZone: TZ, day: "numeric", month: "short" }).replace(/\./g, "")) : null;
const longDate = (ymd: string) => {
  const s = new Date(`${ymd}T12:00:00Z`).toLocaleDateString("es-PR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const stamp = (v: string) => `${new Date(v).toLocaleDateString("es-PR", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" })}, ${time(v)}`;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const join = (...p: Array<string | null | undefined>) => p.filter(Boolean).join(" · ");

const SECTIONS: Array<{ key: "meals" | "hydration" | "activities" | "mobility" | "hygiene" | "mood"; title: string; empty: string; line: (i: Item) => string }> = [
  { key: "meals", title: "Alimentación", empty: "Sin registros de comida.", line: (i) => join(str(i.mealType), str(i.amountConsumed)) || "Comida registrada" },
  { key: "hydration", title: "Hidratación", empty: "Sin registros de hidratación.", line: (i) => str(i.amount) ?? "Registrada" },
  { key: "activities", title: "Actividades y acompañamiento", empty: "Sin actividades registradas.", line: (i) => join(str(i.label), typeof i.durationMinutes === "number" ? `${i.durationMinutes} min` : null) || "Actividad registrada" },
  { key: "mobility", title: "Movilidad", empty: "Sin registros de movilidad.", line: (i) => str(i.activity) ?? "Registrada" },
  { key: "hygiene", title: "Higiene", empty: "Sin registros de higiene.", line: (i) => str(i.result) ?? "Registrada" },
  { key: "mood", title: "Ánimo", empty: "Sin registros de ánimo.", line: (i) => str(i.mood) ?? "Registrado" },
];

export function renderShiftReportPdf(r: FamilyShiftReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER", margin: 48, bufferPages: true,
      info: { Title: "Informe de turno", Author: r.organization.name ?? "ETNARA Care", Creator: "ETNARA Care", Producer: SHIFT_REPORT_PDF_VERSION, CreationDate: new Date(r.approvedAt) },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom; // the footer is drawn inside the bottom margin
    const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };

    // Header band.
    doc.rect(0, 0, doc.page.width, 118).fill(NAVY);
    doc.fillColor("#FFFFFF").font("Times-Bold").fontSize(22).text("ETNARA", left, 34, { continued: true }).font("Times-Italic").fillColor("#C9D6CC").text(" Care");
    doc.font("Helvetica").fontSize(9).fillColor("#C9D6CC").text("INFORME DE TURNO", left, 66, { characterSpacing: 0.8 });
    doc.font("Times-Bold").fontSize(18).fillColor("#FFFFFF").text(r.recipient.name ?? "Residente", left, 80, { width: width - 150 });
    // Status pill.
    doc.roundedRect(left + width - 120, 36, 120, 22, 11).fill(SAGE);
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#FFFFFF").text("APROBADO", left + width - 120, 43, { width: 120, align: "center" });
    doc.y = 136;

    // Identification grid.
    const grid: Array<[string, string]> = [
      ["Agencia", r.organization.name ?? "—"], ["Residente", r.recipient.name ?? "—"],
      ["Cuidadora", r.caregiver.name ?? "—"], ["Fecha del servicio", longDate(r.serviceDate)],
      ["Estado", "Aprobado por la agencia"], ["Fecha de aprobación", stamp(r.approvedAt)],
    ];
    const colW = width / 2;
    let gy = doc.y;
    grid.forEach(([label, value], i) => {
      const x = left + (i % 2) * colW; if (i % 2 === 0 && i > 0) gy += 34;
      doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x, gy, { width: colW - 12, characterSpacing: 0.6 });
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(NAVY).text(value, x, gy + 11, { width: colW - 12 });
    });
    doc.y = gy + 40;

    // Schedule (cream box) — only when the agency shared it.
    const s = r.sections.schedule;
    if (s) {
      const y = doc.y;
      const ref = r.serviceDate;
      const cols: Array<[string, string, string | null]> = [
        ["Programado", `${time(s.scheduledStart)} – ${time(s.scheduledEnd)}`, otherDay(s.scheduledEnd, ref) ? `termina el ${otherDay(s.scheduledEnd, ref)}` : null],
        ["Llegada", s.arrivalAt ? time(s.arrivalAt) : "Sin registro", otherDay(s.arrivalAt, ref)],
        ["Inicio", time(s.startAt), otherDay(s.startAt, ref)],
        ["Final", time(s.endAt), otherDay(s.endAt, ref)],
      ];
      doc.roundedRect(left, y, width, 64, 8).fill(CREAM);
      const widths = [0.34, 0.22, 0.22, 0.22].map((f) => f * (width - 28));
      cols.forEach(([label, value, day], i) => {
        const x = left + 14 + widths.slice(0, i).reduce((a, b) => a + b, 0);
        doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x, y + 14, { characterSpacing: 0.6 });
        doc.font("Helvetica-Bold").fontSize(12).fillColor(NAVY).text(value, x, y + 28, { width: widths[i] - 8, lineBreak: false });
        if (day) doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(day, x, y + 44, { width: widths[i] - 8, lineBreak: false });
      });
      doc.y = y + 80;
    }

    const heading = (title: string, count: number) => {
      ensure(40);
      const y = doc.y;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.6).strokeColor(LINE).stroke();
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(SAGE).text(title.toUpperCase(), left, y + 8, { characterSpacing: 0.3 });
      doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(String(count), left, y + 8, { width, align: "right" });
      doc.y = y + 24;
    };
    const row = (at: string | null, text: string, note?: string | null) => {
      const noteH = note ? doc.font("Helvetica").fontSize(9).heightOfString(note, { width: width - 80 }) + 2 : 0;
      const day = otherDay(at, r.serviceDate);
      ensure(16 + Math.max(noteH, day ? 10 : 0));
      const y = doc.y;
      doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(at ? time(at) : "", left, y, { width: 74, lineBreak: false });
      if (day) doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(day, left, y + 12, { width: 74, lineBreak: false });
      doc.font("Helvetica").fontSize(10).fillColor("#1F2430").text(text, left + 80, y, { width: width - 80 });
      if (note) doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(note, left + 80, doc.y + 1, { width: width - 80 });
      doc.y = Math.max(doc.y, day ? y + 22 : 0) + 6;
    };
    const empty = (t: string) => { doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(t, left, doc.y, { width }); doc.y += 8; };

    for (const sec of SECTIONS) {
      const items = r.sections[sec.key];
      if (!items) continue;
      heading(sec.title, items.length);
      if (items.length === 0) empty(sec.empty);
      for (const i of items) row(i.at, sec.line(i), str(i.note));
    }
    const o = r.sections.observations;
    if (o) {
      heading("Observaciones de la cuidadora", o.notes.length + (o.caregiverNote ? 1 : 0));
      if (o.notes.length === 0 && !o.caregiverNote) empty("Sin observaciones.");
      for (const n of o.notes) row(n.at, n.text ?? "");
      if (o.caregiverNote) row(o.caregiverNote.at, "Observación final", o.caregiverNote.text);
    }
    if (r.sections.incidents) {
      heading("Incidentes", r.sections.incidents.length);
      if (r.sections.incidents.length === 0) empty("Ninguno registrado durante el turno.");
      for (const i of r.sections.incidents) row(i.at, join("Incidente", str(i.severity)), str(i.description));
    }
    if (r.agencySummary) {
      ensure(60);
      const h = doc.font("Helvetica").fontSize(10).heightOfString(r.agencySummary, { width: width - 28 }) + 34;
      const y = doc.y + 6;
      doc.roundedRect(left, y, width, h, 8).lineWidth(1).strokeColor(SAGE).stroke();
      doc.font("Helvetica-Bold").fontSize(9).fillColor(SAGE).text("RESUMEN DE LA AGENCIA", left + 14, y + 10, { characterSpacing: 0.3 });
      doc.font("Helvetica").fontSize(10).fillColor("#1F2430").text(r.agencySummary, left + 14, y + 24, { width: width - 28 });
      doc.y = y + h + 10;
    }
    const closing = "Generado a partir de los registros del turno y aprobado por la agencia. Incluye solo las secciones que la agencia autorizó para la familia. ETNARA no añade actividades ni marca tareas como hechas.";
    doc.font("Helvetica").fontSize(8.5);
    ensure(doc.heightOfString(closing, { width }) + 10);
    doc.fillColor(MUTED).text(closing, left, doc.y + 8, { width });

    // Footer on every page: report id, version, page.
    const range = doc.bufferedPageRange();
    for (let p = range.start; p < range.start + range.count; p++) {
      doc.switchToPage(p);
      doc.page.margins.bottom = 0; // the footer sits in the margin; never spill onto a new page
      const fy = doc.page.height - 40;
      doc.moveTo(left, fy - 6).lineTo(left + width, fy - 6).lineWidth(0.6).strokeColor(LINE).stroke();
      doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
        .text(`Informe ${r.id} · versión ${r.version} · ETNARA Care · Documento confidencial para la familia autorizada`, left, fy, { width: width - 60, lineBreak: false })
        .text(`Página ${p - range.start + 1} de ${range.count}`, left + width - 60, fy, { width: 60, align: "right", lineBreak: false });
    }
    doc.end();
  });
}
