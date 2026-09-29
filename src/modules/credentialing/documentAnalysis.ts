export type DocumentAnalysisAssessment = "consistent" | "inconsistent" | "uncertain";

export interface InitialDocumentAnalysisInput {
  selectedCredentialTypeCode: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  documentId: string;
  fileId: string;
  documentVersion: number;
}

export interface InitialDocumentAnalysisResult {
  analysisStatus: "completed" | "unavailable";
  assessment: DocumentAnalysisAssessment;
  selectedCredentialTypeCode: string;
  detectedDocumentType: string | null;
  confidence: number | null;
  flags: string[];
  summary: string;
  analyzedDocumentId: string;
  analyzedDocumentVersion: number;
  analysisMethod: "metadata-safety-v1";
}

const imageExtensions = /\.(jpe?g|png)$/i;
const pdfExtension = /\.pdf$/i;

/**
 * Phase 11.1 safety analyzer.
 *
 * This intentionally does not pretend metadata is AI vision/OCR. It provides a
 * deterministic first gate and returns uncertainty whenever content identity
 * cannot be established. A richer approved provider can replace/augment this
 * in later 11.x work without changing the human-verification boundary.
 */
export function analyzeInitialCredentialDocument(
  input: InitialDocumentAnalysisInput
): InitialDocumentAnalysisResult {
  const flags: string[] = [];
  const filename = input.originalFilename.trim();
  const expectedExtension = input.contentType === "application/pdf"
    ? pdfExtension.test(filename)
    : input.contentType === "image/jpeg" || input.contentType === "image/png"
      ? imageExtensions.test(filename)
      : false;

  if (!expectedExtension) flags.push("FILE_EXTENSION_CONTENT_TYPE_MISMATCH");
  if (input.sizeBytes < 128) flags.push("FILE_TOO_SMALL_FOR_RELIABLE_ANALYSIS");

  const assessment: DocumentAnalysisAssessment = flags.length > 0 ? "inconsistent" : "uncertain";
  const summary = flags.length > 0
    ? "El archivo presenta inconsistencias técnicas y requiere revisión humana."
    : "No pudimos confirmar automáticamente el tipo de documento. Requiere revisión humana.";

  return {
    analysisStatus: "completed",
    assessment,
    selectedCredentialTypeCode: input.selectedCredentialTypeCode,
    detectedDocumentType: null,
    confidence: null,
    flags,
    summary,
    analyzedDocumentId: input.documentId,
    analyzedDocumentVersion: input.documentVersion,
    analysisMethod: "metadata-safety-v1",
  };
}
