import PDFDocument from "pdfkit";

/**
 * Módulo contractual, Etapa 2: PDF del documento (para descargar antes de aceptar) y constancia de
 * aceptación. Fuentes estándar del PDF (WinAnsi), que cubren los acentos del español.
 * La constancia solo lleva datos de la evidencia: nada de residentes ni del personal.
 */
const NAVY = "#16213D";
const MUTED = "#5b6475";
const when = (instant: string | Date) => {
  const d = new Date(instant);
  const pr = d.toLocaleString("es-PR", { timeZone: "America/Puerto_Rico", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
  return `${pr} (hora de Puerto Rico) · ${d.toISOString()}`;
};

function render(build: (doc: PDFKit.PDFDocument) => void, info: { Title: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 56, bufferPages: true, compress: false, info: { ...info, Author: "ETNARA Care", Creator: "ETNARA Care" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    build(doc);
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).fillColor(MUTED).text(`Página ${i + 1} de ${range.count}`, 56, doc.page.height - 40, { align: "right", width: doc.page.width - 112, lineBreak: false });
    }
    doc.end();
  });
}

export interface ContractPdfVersion {
  title: string; code: string; versionLabel: string; body: string; contentSha256: string; publishedAt: string; isTest: boolean;
}

export function renderContractDocumentPdf(v: ContractPdfVersion): Promise<Buffer> {
  return render((doc) => {
    if (v.isTest) doc.fontSize(9).fillColor("#a03a2c").text("DOCUMENTO FICTICIO DE PRUEBA — SIN VALOR LEGAL", { align: "center" }).moveDown(0.6);
    doc.fontSize(18).fillColor(NAVY).font("Helvetica-Bold").text(v.title);
    doc.moveDown(0.3).font("Helvetica").fontSize(10).fillColor(MUTED)
      .text(`Versión ${v.versionLabel} · Código ${v.code} · Publicada el ${when(v.publishedAt)}`)
      .text(`Huella SHA-256 del texto: ${v.contentSha256}`);
    doc.moveDown(1).fontSize(11).fillColor("#222").text(v.body, { align: "left", lineGap: 2 });
  }, { Title: `${v.title} — versión ${v.versionLabel}` });
}

export interface AcceptanceCertificate {
  id: string; organizationName: string; title: string; code: string; versionLabel: string; contentSha256: string; isTest: boolean;
  signerFullName: string; signerTitle: string; authorityDeclaration: string; acceptanceStatement: string;
  acceptedByLogin: string; verifiedEmail: string; verificationMethod: string; acceptedAt: string; ipAddress: string | null;
}

export function renderAcceptanceCertificatePdf(a: AcceptanceCertificate): Promise<Buffer> {
  return render((doc) => {
    if (a.isTest) doc.fontSize(9).fillColor("#a03a2c").text("CONSTANCIA DE PRUEBA SOBRE UN DOCUMENTO FICTICIO — SIN VALOR LEGAL", { align: "center" }).moveDown(0.6);
    doc.fontSize(18).fillColor(NAVY).font("Helvetica-Bold").text("Constancia de aceptación electrónica");
    doc.moveDown(0.8).font("Helvetica").fontSize(11).fillColor("#222");
    const row = (label: string, value: string) => { doc.font("Helvetica-Bold").text(label, { continued: true }).font("Helvetica").text(` ${value}`).moveDown(0.25); };
    row("Organización:", a.organizationName);
    row("Documento:", `${a.title} (código ${a.code})`);
    row("Versión aceptada:", a.versionLabel);
    row("Huella SHA-256 del texto aceptado:", a.contentSha256);
    row("Representante:", `${a.signerFullName}, ${a.signerTitle}`);
    row("Cuenta que firmó:", a.acceptedByLogin);
    row("Verificación de identidad:", a.verificationMethod === "EMAIL_CODE" ? `código de un solo uso enviado a ${a.verifiedEmail}` : a.verificationMethod);
    row("Fecha y hora:", when(a.acceptedAt));
    if (a.ipAddress) row("Dirección IP:", a.ipAddress);
    row("Identificador de la evidencia:", a.id);
    doc.moveDown(0.6).font("Helvetica-Bold").text("Declaración de autoridad aceptada");
    doc.font("Helvetica").text(a.authorityDeclaration).moveDown(0.6);
    doc.font("Helvetica-Bold").text("Declaración de aceptación");
    doc.font("Helvetica").text(a.acceptanceStatement).moveDown(1);
    doc.fontSize(9).fillColor(MUTED).text("Para comprobar que un texto es el aceptado, calcule su huella SHA-256 y compárela con la de esta constancia. La evidencia original se conserva en ETNARA Care y no puede modificarse.");
  }, { Title: `Constancia de aceptación — ${a.title} ${a.versionLabel}` });
}
