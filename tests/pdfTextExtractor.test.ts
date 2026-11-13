import { readFileSync } from "node:fs";
import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import { pdfToText, PdfTextError } from "../scripts/lib/pdfText.js";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function makePdf(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    draw(doc);
    doc.end();
  });
}

// 11-nov-2026: the F3 privacy checks read the family PDF with pdfjs-dist (pinned) instead of
// pdftotext from apt. The extractor must read real text and FAIL CLOSED when it cannot.
describe("PDF text extractor for the verification scripts", () => {
  it("reads the text of a real PDF (accents, two lines, two pages)", async () => {
    const pdf = await makePdf((doc) => {
      doc.fontSize(14).text("INFORME DE TURNO · Doña Carmen");
      doc.text("Desayuno · Casi todo");
      doc.addPage().text("Página dos: Caminata en el patio");
    });
    const text = await pdfToText(pdf);
    expect(text).toContain("INFORME DE TURNO");
    expect(text).toContain("Doña Carmen");
    expect(text).toContain("Desayuno · Casi todo");
    expect(text).toContain("Caminata en el patio");
    expect(text.indexOf("Desayuno")).toBeLessThan(text.indexOf("Caminata"));
  });

  it("fails closed: not a PDF", async () => {
    await expect(pdfToText(Buffer.from("<html>not a pdf</html>"))).rejects.toThrow(PdfTextError);
    await expect(pdfToText(Buffer.alloc(0))).rejects.toThrow(/PDF_TEXT_NOT_A_PDF/);
  });

  it("fails closed: a corrupt PDF", async () => {
    await expect(pdfToText(Buffer.from("%PDF-1.7\n%garbage that is not a document\n"))).rejects.toThrow(/PDF_TEXT_UNREADABLE/);
  });

  it("fails closed: a valid PDF without any readable text (an empty extraction never passes a check)", async () => {
    const pdf = await makePdf((doc) => { doc.rect(50, 50, 100, 100).fill("#333333"); });
    await expect(pdfToText(pdf)).rejects.toThrow(/PDF_TEXT_EMPTY/);
  });

  it("the CI no longer depends on apt/pdftotext and the F3 checks use the pinned extractor", () => {
    for (const wf of [".github/workflows/etnara-ci.yml", ".github/workflows/smartmatch-postgres.yml"]) {
      const y = read(wf);
      expect(y).not.toMatch(/apt-get|poppler|pdftotext/);
      expect(y).toContain("npx tsx scripts/verifyShiftReportsF3.ts");
    }
    const f3 = read("scripts/verifyShiftReportsF3.ts");
    expect(f3).toContain('import { pdfToText } from "./lib/pdfText.js";');
    expect(f3).not.toMatch(/execFileSync|pdftotext/);
    expect(f3.match(/await pdfText\((p1|p2|pM)\.buf\)/g)?.length).toBe(3);
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.devDependencies["pdfjs-dist"]).toBe("4.10.38");
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.packages["node_modules/pdfjs-dist"].version).toBe("4.10.38");
    expect(lock.packages["node_modules/pdfjs-dist"].integrity).toMatch(/^sha512-/);
  });
});
