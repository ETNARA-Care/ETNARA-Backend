/**
 * Validación de archivos de documentos (institucionales y del residente) ANTES de guardarlos.
 *
 * No se confía en lo que declara el cliente. Un archivo se acepta solo si:
 *   - no está vacío y no supera el máximo;
 *   - su nombre es razonable y su extensión está en la lista permitida de ese tipo de documento;
 *   - el tipo MIME declarado corresponde a esa extensión (o el navegador no lo sabe:
 *     vacío / application/octet-stream);
 *   - los primeros bytes (la «firma» del archivo) corresponden a ese mismo formato.
 * El tipo MIME que se guarda y con el que luego se descarga es el canónico del servidor,
 * nunca el texto que envió el cliente. SVG, HTML, ejecutables, scripts y cualquier otro
 * formato quedan fuera porque no están en ninguna lista.
 */

export type DocumentFormat = "pdf" | "jpeg" | "png" | "webp" | "heic" | "doc" | "docx";

export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Documentos institucionales del establecimiento: lo mismo que ofrece el portal (PDF, JPEG, PNG). */
export const ESTABLISHMENT_DOCUMENT_FORMATS: readonly DocumentFormat[] = ["pdf", "jpeg", "png"];
/** Documentos del residente: el portal ofrece PDF, imágenes y Word. */
export const RESIDENT_DOCUMENT_FORMATS: readonly DocumentFormat[] = ["pdf", "jpeg", "png", "webp", "heic", "doc", "docx"];

const FORMATS: Record<DocumentFormat, { extensions: string[]; mimes: string[]; canonical: string }> = {
  pdf: { extensions: ["pdf"], mimes: ["application/pdf"], canonical: "application/pdf" },
  jpeg: { extensions: ["jpg", "jpeg"], mimes: ["image/jpeg", "image/jpg", "image/pjpeg"], canonical: "image/jpeg" },
  png: { extensions: ["png"], mimes: ["image/png"], canonical: "image/png" },
  webp: { extensions: ["webp"], mimes: ["image/webp"], canonical: "image/webp" },
  heic: { extensions: ["heic", "heif"], mimes: ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"], canonical: "image/heic" },
  doc: { extensions: ["doc"], mimes: ["application/msword"], canonical: "application/msword" },
  docx: {
    extensions: ["docx"],
    mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    canonical: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
};

/** El navegador no siempre conoce el tipo (p. ej. .docx sin Office instalado). Entonces decide la firma. */
const UNKNOWN_MIMES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

export type DocumentUploadRejection =
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "INVALID_FILE_NAME"
  | "FILE_TYPE_NOT_ALLOWED"
  | "FILE_CONTENT_MISMATCH";

export class DocumentUploadRejectedError extends Error {
  constructor(public readonly code: DocumentUploadRejection) { super(code); this.name = "DocumentUploadRejectedError"; }
}

const startsWith = (b: Buffer, sig: number[], offset = 0) => b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);
const ascii = (b: Buffer, from: number, to: number) => b.subarray(from, Math.min(to, b.length)).toString("latin1");

/** Firma real del contenido, o null si no es ninguno de los formatos conocidos. */
export function sniffDocumentFormat(body: Buffer): DocumentFormat | null {
  // PDF: la cabecera puede ir precedida de basura en los primeros 1024 bytes (lo admiten los lectores),
  // pero exigimos que esté al principio: es lo que generan escáneres, teléfonos y Office.
  if (ascii(body, 0, 5) === "%PDF-") return "pdf";
  if (startsWith(body, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (ascii(body, 0, 4) === "RIFF" && ascii(body, 8, 12) === "WEBP") return "webp";
  if (ascii(body, 4, 8) === "ftyp") {
    const brand = ascii(body, 8, 12);
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
  }
  if (startsWith(body, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "doc";
  // DOCX es un ZIP con [Content_Types].xml y la carpeta word/. Un ZIP cualquiera no basta.
  if (startsWith(body, [0x50, 0x4b, 0x03, 0x04])) {
    const head = ascii(body, 0, Math.min(body.length, 64 * 1024));
    if (head.includes("[Content_Types].xml") && head.includes("word/")) return "docx";
  }
  return null;
}

export interface ValidatedDocument { contentType: string; format: DocumentFormat; extension: string }

export function validateDocumentUpload(
  input: { fileName: string; declaredContentType: string; body: Buffer },
  allowed: readonly DocumentFormat[],
  maxBytes = DOCUMENT_MAX_BYTES,
): ValidatedDocument {
  const { body } = input;
  if (!body || body.byteLength === 0) throw new DocumentUploadRejectedError("EMPTY_FILE");
  if (body.byteLength > maxBytes) throw new DocumentUploadRejectedError("FILE_TOO_LARGE");

  const fileName = input.fileName.trim();
  // Sin rutas, sin caracteres de control y con una longitud razonable.
  if (!fileName || fileName.length > 200 || /[\u0000-\u001f\u007f/\\]/.test(fileName) || fileName.startsWith(".")) {
    throw new DocumentUploadRejectedError("INVALID_FILE_NAME");
  }
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) throw new DocumentUploadRejectedError("FILE_TYPE_NOT_ALLOWED");
  const extension = fileName.slice(dot + 1).toLowerCase();

  const byExtension = allowed.find((f) => FORMATS[f].extensions.includes(extension));
  if (!byExtension) throw new DocumentUploadRejectedError("FILE_TYPE_NOT_ALLOWED");

  const declared = input.declaredContentType.split(";")[0].trim().toLowerCase();
  if (!UNKNOWN_MIMES.has(declared) && !FORMATS[byExtension].mimes.includes(declared)) {
    throw new DocumentUploadRejectedError("FILE_CONTENT_MISMATCH");
  }

  const sniffed = sniffDocumentFormat(body);
  if (sniffed !== byExtension) throw new DocumentUploadRejectedError("FILE_CONTENT_MISMATCH");

  return { contentType: FORMATS[byExtension].canonical, format: byExtension, extension };
}

/** Respuesta HTTP de un rechazo: 413 si es por tamaño, 400 en los demás casos. Sin datos del archivo. */
export function documentUploadRejectionStatus(code: DocumentUploadRejection) {
  return code === "FILE_TOO_LARGE" ? 413 : 400;
}
