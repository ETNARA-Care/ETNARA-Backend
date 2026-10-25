import PDFDocument from "pdfkit";

/**
 * Facturación F2.3 — the invoice PDF (letter size, Spanish). Built ONLY from
 * the frozen copy saved at issue (issuer, client, lines, segments, totals), so
 * it always matches what was issued. Never includes diagnoses, care notes,
 * locations or clinical data. The caregiver's name appears only when the
 * agency turned on show_caregiver_name (D9, off by default).
 * Standard PDF fonts (WinAnsi) cover Spanish accents; no external font file.
 */
export const PDF_GENERATOR_VERSION = "billing-pdf-1";

export interface PdfIssuer { legalName: string; tradeName: string | null; address: string | null; phone: string | null; email: string | null; merchantRegistration: string | null; paymentTerms: string | null; footerNote: string | null; logo: Buffer | null }
export interface PdfClient { name: string; address: string | null }
export interface PdfSegment { date: string; startsAt: string; endsAt: string; minutes: number; amountCents: number; holiday: string | null }
export interface PdfLine { kind: "shift" | "manual" | "discount"; date: string; description: string; recipientName: string | null; caregiverName: string | null; quantityHundredths: number; unit: string | null; unitPriceCents: number | null; amountCents: number; taxLabel: string; segments: PdfSegment[] }
export interface PdfTotals { subtotalCents: number; taxes: { rateBasisPoints: number; baseCents: number; taxCents: number }[]; exemptBaseCents: number; totalCents: number; exemptBases: string[] }
export interface PdfInvoice {
  numberText: string; issueDate: string; periodFrom: string; periodTo: string; issuedAt: string;
  issuer: PdfIssuer; client: PdfClient; lines: PdfLine[]; totals: PdfTotals; notes: string | null;
  voided?: { at: string; reason: string } | null;
}

const NAVY = "#16213D";
const MUTED = "#5b6475";
const money = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("es-PR", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
const time = (instant: string) => new Date(instant).toLocaleTimeString("es-PR", { timeZone: "America/Puerto_Rico", hour: "numeric", minute: "2-digit" });
const qty = (h: number) => (h / 100).toLocaleString("es-PR", { maximumFractionDigits: 2 });
const pct = (bp: number) => `${(bp / 100).toLocaleString("es-PR", { maximumFractionDigits: 2 })} %`;
const hours = (m: number) => (m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);

export function renderInvoicePdf(inv: PdfInvoice): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER", margin: 48, bufferPages: true, compress: false, // uncompressed: invoices are small and text stays inspectable
      info: { Title: `Factura ${inv.numberText}`, Author: inv.issuer.legalName, Creator: "ETNARA Care", CreationDate: new Date(inv.issuedAt) },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;

    // Header: logo + issuer · invoice box.
    let y = doc.y;
    if (inv.issuer.logo) {
      try { doc.image(inv.issuer.logo, left, y, { fit: [120, 60] }); } catch { /* an unreadable logo never blocks the invoice */ }
    }
    const issuerX = inv.issuer.logo ? left + 132 : left;
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(13).text(inv.issuer.legalName, issuerX, y, { width: 260 });
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED);
    for (const l of [inv.issuer.tradeName, inv.issuer.address, [inv.issuer.phone, inv.issuer.email].filter(Boolean).join(" · ") || null,
      inv.issuer.merchantRegistration ? `Registro de comerciante: ${inv.issuer.merchantRegistration}` : null]) {
      if (l) doc.text(l, issuerX, undefined, { width: 260 });
    }
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(18).text("FACTURA", left + width - 180, y, { width: 180, align: "right" });
    doc.font("Helvetica").fontSize(9).fillColor("#000")
      .text(`Número: ${inv.numberText}`, left + width - 180, undefined, { width: 180, align: "right" })
      .text(`Fecha de emisión: ${day(inv.issueDate)}`, { width: 180, align: "right" })
      .text(`Período: ${day(inv.periodFrom)} – ${day(inv.periodTo)}`, { width: 180, align: "right" });
    y = Math.max(doc.y, y + 70) + 14;

    // Client.
    doc.moveTo(left, y).lineTo(left + width, y).strokeColor("#d9dce3").stroke();
    y += 10;
    doc.fillColor(MUTED).fontSize(8).text("FACTURAR A", left, y);
    doc.fillColor("#000").font("Helvetica-Bold").fontSize(10.5).text(inv.client.name, left, undefined, { width: width / 2 });
    doc.font("Helvetica").fontSize(9);
    if (inv.client.address) doc.text(inv.client.address, { width: width / 2 });
    y = doc.y + 16;

    // Lines table.
    const cols = { date: left, desc: left + 70, qty: left + width - 200, price: left + width - 140, amount: left + width - 70 };
    const header = () => {
      doc.rect(left, y, width, 18).fill(NAVY);
      doc.fillColor("#fff").font("Helvetica-Bold").fontSize(8.5)
        .text("Fecha", cols.date + 4, y + 5).text("Concepto", cols.desc, y + 5)
        .text("Cant.", cols.qty, y + 5, { width: 50, align: "right" }).text("Precio", cols.price, y + 5, { width: 60, align: "right" })
        .text("Importe", cols.amount, y + 5, { width: 66, align: "right" });
      y += 24;
    };
    header();
    for (const line of inv.lines) {
      const detail: string[] = [];
      if (line.recipientName) detail.push(`Residente: ${line.recipientName}`);
      if (line.caregiverName) detail.push(`Cuidador/a: ${line.caregiverName}`);
      if (line.segments.length > 1) {
        for (const s of line.segments) detail.push(`${day(s.date)} ${time(s.startsAt)}–${time(s.endsAt)} · ${hours(s.minutes)} · ${money(s.amountCents)}${s.holiday ? ` · Feriado: ${s.holiday}` : ""}`);
      }
      detail.push(line.taxLabel);
      const descHeight = doc.font("Helvetica").fontSize(9).heightOfString(line.description, { width: cols.qty - cols.desc - 8 })
        + doc.fontSize(7.5).heightOfString(detail.join("\n"), { width: cols.qty - cols.desc - 8 }) + 6;
      if (y + descHeight > doc.page.height - 160) { doc.addPage(); y = doc.page.margins.top; header(); }
      doc.fillColor("#000").font("Helvetica").fontSize(9).text(day(line.date), cols.date + 4, y, { width: 64 });
      doc.font("Helvetica-Bold").text(line.description, cols.desc, y, { width: cols.qty - cols.desc - 8 });
      doc.font("Helvetica").fontSize(7.5).fillColor(MUTED).text(detail.join("\n"), cols.desc, undefined, { width: cols.qty - cols.desc - 8 });
      doc.fillColor("#000").fontSize(9)
        .text(qty(line.quantityHundredths), cols.qty, y, { width: 50, align: "right" })
        .text(line.unitPriceCents != null ? money(line.unitPriceCents) : "—", cols.price, y, { width: 60, align: "right" })
        .text(money(line.amountCents), cols.amount, y, { width: 66, align: "right" });
      y += descHeight + 6;
      doc.moveTo(left, y - 3).lineTo(left + width, y - 3).strokeColor("#eceef2").stroke();
    }

    // Totals.
    if (y > doc.page.height - 200) { doc.addPage(); y = doc.page.margins.top; }
    y += 6;
    const totalRow = (label: string, value: string, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9).fillColor(bold ? NAVY : "#000")
        .text(label, left + width - 260, y, { width: 180, align: "right" }).text(value, cols.amount - 14, y, { width: 80, align: "right" });
      y += bold ? 18 : 14;
    };
    totalRow("Subtotal", money(inv.totals.subtotalCents));
    for (const t of inv.totals.taxes) totalRow(`IVU ${pct(t.rateBasisPoints)} sobre ${money(t.baseCents)}`, money(t.taxCents));
    if (inv.totals.exemptBaseCents !== 0) totalRow("Exento", money(inv.totals.exemptBaseCents));
    totalRow("Total", money(inv.totals.totalCents), true);
    if (inv.totals.exemptBases.length) {
      doc.font("Helvetica").fontSize(7.5).fillColor(MUTED).text(`Base legal de la exención: ${inv.totals.exemptBases.join("; ")}`, left, y + 4, { width });
      y = doc.y;
    }

    // Terms, notes, footer.
    y += 14;
    doc.font("Helvetica").fontSize(8.5).fillColor("#000");
    if (inv.issuer.paymentTerms) { doc.text(`Condiciones: ${inv.issuer.paymentTerms}`, left, y, { width }); y = doc.y + 4; }
    if (inv.notes) { doc.text(inv.notes, left, y, { width }); y = doc.y + 4; }
    if (inv.issuer.footerNote) doc.fillColor(MUTED).fontSize(7.5).text(inv.issuer.footerNote, left, y + 6, { width, align: "center" });

    if (inv.voided) {
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] })
          .fillColor("#b42318").opacity(0.18).font("Helvetica-Bold").fontSize(110)
          .text("ANULADA", 0, doc.page.height / 2 - 60, { width: doc.page.width, align: "center" }).restore();
        doc.opacity(1).fillColor("#b42318").font("Helvetica-Bold").fontSize(9)
          .text(`ANULADA el ${day(inv.voided.at.slice(0, 10))}. Motivo: ${inv.voided.reason}`, left, doc.page.margins.top - 30, { width });
      }
    }
    doc.end();
  });
}
