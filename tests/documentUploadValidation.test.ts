import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DOCUMENT_MAX_BYTES,
  ESTABLISHMENT_DOCUMENT_FORMATS,
  RESIDENT_DOCUMENT_FORMATS,
  documentUploadRejectionStatus,
  sniffDocumentFormat,
  validateDocumentUpload,
} from "../src/modules/storage/documentUploadValidation.js";

// Archivos sintéticos: solo las firmas reales de cada formato, sin datos.
const pdf = Buffer.from("%PDF-1.7\n% sintetico\n%%EOF");
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]);
const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(16)]);
const doc = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(32)]);
const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("....[Content_Types].xml....word/document.xml....")]);
const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("....payload.exe....")]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const html = Buffer.from("<!doctype html><script>alert(1)</script>");
const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);

const est = (fileName: string, declaredContentType: string, body: Buffer) =>
  validateDocumentUpload({ fileName, declaredContentType, body }, ESTABLISHMENT_DOCUMENT_FORMATS);
const res = (fileName: string, declaredContentType: string, body: Buffer) =>
  validateDocumentUpload({ fileName, declaredContentType, body }, RESIDENT_DOCUMENT_FORMATS);
const code = (fn: () => unknown) => { try { fn(); return "OK"; } catch (e) { return (e as { code?: string }).code ?? "THROW"; } };

describe("validación de documentos: formatos permitidos", () => {
  it("acepta PDF, JPEG y PNG institucionales y guarda el tipo canónico del servidor", () => {
    expect(est("licencia.pdf", "application/pdf", pdf).contentType).toBe("application/pdf");
    expect(est("Permiso.JPG", "image/jpeg", jpeg).contentType).toBe("image/jpeg");
    expect(est("seguro.jpeg", "image/jpg", jpeg).contentType).toBe("image/jpeg");
    expect(est("plano.png", "image/png; charset=binary", png).contentType).toBe("image/png");
  });
  it("acepta en documentos del residente también WebP, HEIC, DOC y DOCX", () => {
    expect(res("foto.webp", "image/webp", webp).format).toBe("webp");
    expect(res("IMG_0001.HEIC", "image/heic", heic).contentType).toBe("image/heic");
    expect(res("orden.doc", "application/msword", doc).format).toBe("doc");
    expect(res("plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx).format).toBe("docx");
  });
  it("si el navegador no sabe el tipo (vacío u octet-stream), decide la firma del contenido", () => {
    expect(res("plan.docx", "application/octet-stream", docx).contentType)
      .toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(est("licencia.pdf", "", pdf).contentType).toBe("application/pdf");
  });
});

describe("validación de documentos: rechazos", () => {
  it("rechaza archivos vacíos y demasiado grandes (413)", () => {
    expect(code(() => est("a.pdf", "application/pdf", Buffer.alloc(0)))).toBe("EMPTY_FILE");
    const big = Buffer.concat([pdf, Buffer.alloc(DOCUMENT_MAX_BYTES)]);
    expect(code(() => est("a.pdf", "application/pdf", big))).toBe("FILE_TOO_LARGE");
    expect(documentUploadRejectionStatus("FILE_TOO_LARGE")).toBe(413);
    expect(documentUploadRejectionStatus("EMPTY_FILE")).toBe(400);
  });
  it("rechaza tipos peligrosos o no permitidos aunque se declaren como imagen o PDF", () => {
    expect(code(() => res("logo.svg", "image/svg+xml", svg))).toBe("FILE_TYPE_NOT_ALLOWED");
    expect(code(() => res("pagina.html", "text/html", html))).toBe("FILE_TYPE_NOT_ALLOWED");
    expect(code(() => res("instalar.exe", "application/octet-stream", exe))).toBe("FILE_TYPE_NOT_ALLOWED");
    expect(code(() => res("archivo", "application/pdf", pdf))).toBe("FILE_TYPE_NOT_ALLOWED");
    expect(code(() => res("archivo.", "application/pdf", pdf))).toBe("FILE_TYPE_NOT_ALLOWED");
    expect(code(() => res("gif.gif", "image/gif", Buffer.from("GIF89a....")))).toBe("FILE_TYPE_NOT_ALLOWED");
  });
  it("los documentos institucionales no aceptan Word ni HEIC (el portal no los ofrece)", () => {
    expect(code(() => est("permiso.docx", "application/octet-stream", docx))).toBe("FILE_TYPE_NOT_ALLOWED");
    expect(code(() => est("permiso.heic", "image/heic", heic))).toBe("FILE_TYPE_NOT_ALLOWED");
  });
  it("rechaza contenido que no corresponde a la extensión (HTML/SVG/EXE disfrazados)", () => {
    expect(code(() => res("informe.pdf", "application/pdf", html))).toBe("FILE_CONTENT_MISMATCH");
    expect(code(() => res("foto.jpg", "image/jpeg", svg))).toBe("FILE_CONTENT_MISMATCH");
    expect(code(() => res("foto.png", "image/png", exe))).toBe("FILE_CONTENT_MISMATCH");
    expect(code(() => res("foto.png", "image/png", jpeg))).toBe("FILE_CONTENT_MISMATCH");
    expect(code(() => res("plan.docx", "application/octet-stream", zip))).toBe("FILE_CONTENT_MISMATCH");
  });
  it("rechaza un tipo MIME declarado que contradice la extensión", () => {
    expect(code(() => res("informe.pdf", "text/html", pdf))).toBe("FILE_CONTENT_MISMATCH");
    expect(code(() => res("informe.pdf", "image/png", pdf))).toBe("FILE_CONTENT_MISMATCH");
  });
  it("rechaza nombres con rutas, caracteres de control, ocultos o demasiado largos", () => {
    expect(code(() => res("../../etc/passwd.pdf", "application/pdf", pdf))).toBe("INVALID_FILE_NAME");
    expect(code(() => res("a\\b.pdf", "application/pdf", pdf))).toBe("INVALID_FILE_NAME");
    expect(code(() => res("a\u0000.pdf", "application/pdf", pdf))).toBe("INVALID_FILE_NAME");
    expect(code(() => res(".pdf", "application/pdf", pdf))).toBe("INVALID_FILE_NAME");
    expect(code(() => res(`${"a".repeat(201)}.pdf`, "application/pdf", pdf))).toBe("INVALID_FILE_NAME");
  });
  it("la firma reconoce solo los formatos conocidos", () => {
    expect(sniffDocumentFormat(pdf)).toBe("pdf");
    expect(sniffDocumentFormat(svg)).toBeNull();
    expect(sniffDocumentFormat(zip)).toBeNull();
    expect(sniffDocumentFormat(Buffer.alloc(0))).toBeNull();
  });
});

describe("cableado: los servicios validan antes de subir y guardan el tipo canónico", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  for (const [path, list] of [
    ["src/modules/establishmentDocuments/establishmentDocuments.service.ts", "ESTABLISHMENT_DOCUMENT_FORMATS"],
    ["src/modules/residentDocuments/residentDocuments.service.ts", "RESIDENT_DOCUMENT_FORMATS"],
  ] as const) {
    it(path, () => {
      const s = read(path);
      expect(s).toContain(`validateDocumentUpload({fileName:input.fileName,declaredContentType:input.contentType,body},${list})`);
      expect(s.indexOf("validateDocumentUpload(")).toBeLessThan(s.indexOf("await uploadPrivateObject("));
      expect(s).toContain("uploadPrivateObject(");
      expect(s).not.toMatch(/uploadPrivateObject\([a-zA-Z]+,input\.contentType/);
      expect(s).not.toContain("${input.contentType}");
    });
  }
});
