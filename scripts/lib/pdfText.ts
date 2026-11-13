/**
 * Text of a PDF for the verification scripts, without system packages (no apt / poppler).
 *
 * Uses pdfjs-dist, pinned exactly in package.json/package-lock (4.10.38: the last major that
 * supports Node 20, the CI runtime). It comes from the same npm registry `npm ci` already
 * needs, so the checks no longer depend on the Ubuntu package mirror (outage of 11-nov-2026).
 *
 * Lines are rebuilt from text positions (same baseline → same line, left to right), close to
 * `pdftotext -layout`; the checks compare content, never positions.
 *
 * Fails closed: an unreadable PDF, a PDF without pages or without any extractable text throws
 * PdfTextError, so a privacy check can never pass on an empty extraction.
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export class PdfTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfTextError";
  }
}

type TextItem = { str: string; transform: number[] };

export async function pdfToText(buf: Buffer | Uint8Array): Promise<string> {
  if (!buf || buf.length < 5 || Buffer.from(buf.subarray(0, 5)).toString("latin1") !== "%PDF-") {
    throw new PdfTextError("PDF_TEXT_NOT_A_PDF");
  }
  let doc;
  try {
    doc = await getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  } catch (error) {
    throw new PdfTextError(`PDF_TEXT_UNREADABLE: ${(error as Error)?.message ?? error}`);
  }
  try {
    if (doc.numPages < 1) throw new PdfTextError("PDF_TEXT_NO_PAGES");
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const rows = new Map<number, { x: number; s: string }[]>();
      for (const item of content.items as TextItem[]) {
        if (typeof item.str !== "string" || !Array.isArray(item.transform)) continue;
        const y = Math.round(item.transform[5]);
        const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
        rows.set(key, [...(rows.get(key) ?? []), { x: item.transform[4], s: item.str }]);
      }
      pages.push([...rows.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, cells]) => cells.sort((a, b) => a.x - b.x).map((c) => c.s).join(" ").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n"));
    }
    const text = pages.join("\n\f");
    if (!text.trim()) throw new PdfTextError("PDF_TEXT_EMPTY");
    return text;
  } finally {
    await doc.destroy();
  }
}
