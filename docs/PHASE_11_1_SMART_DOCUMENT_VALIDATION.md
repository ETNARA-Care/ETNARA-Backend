# Phase 11.1 — Smart initial document validation

## Goal

Prevent ETNARA from treating an uploaded file as a valid credential merely because a user selected a credential type and entered plausible dates.

Phase 11.1 adds an assisted analysis layer between upload and human verification.

## Required flow

Upload document → analyze document → identify likely document type → compare against the selected credential type and submitted metadata → flag inconsistencies → human review → approve/reject → audit.

## Non-negotiable guardrails

- Analysis is advisory. It never approves or rejects a credential.
- Analysis never changes worker eligibility, activation status, credential status, verification status, expiration dates, or compliance policy.
- Existing organization/tenant boundaries remain mandatory.
- A human manager remains responsible for the final verification decision.
- Analysis results must be auditable and tied to the analyzed document/version.
- Re-uploading a document requires analysis of the new version; a prior result must not silently carry forward.
- Family users receive no document-analysis route or organization-wide compliance data.
- Do not send a document to an external AI/model unless the deployment has an explicitly configured and approved document-analysis provider. A deterministic/local fallback may flag obvious unsupported or non-document cases but must identify its limitations.

## Initial analysis result contract

An analysis result should expose, at minimum:

- `analysisStatus`: `pending | completed | unavailable | failed`
- `assessment`: `consistent | inconsistent | uncertain`
- `selectedCredentialTypeCode`
- `detectedDocumentType`: nullable human-readable/type code
- `confidence`: nullable bounded score
- `flags`: machine-readable findings
- `summary`: concise explanation for the human reviewer
- `analyzedDocumentId`
- `analyzedDocumentVersion`
- `analyzedAt`
- `analysisMethod`: identifies the configured analyzer/fallback without implying human verification

## Initial findings

The analyzer may flag objective inconsistencies such as:

- uploaded content does not appear to be a credential/document
- detected document type conflicts with the credential type selected by the user
- expected identifying text/fields cannot be found
- submitted issue/expiration dates conflict with reliably extracted dates
- file cannot be analyzed or confidence is too low

A finding is not a rejection.

## UX language

Use neutral language such as:

- “El archivo no parece corresponder al tipo de documento seleccionado.”
- “No pudimos confirmar automáticamente el tipo de documento.”
- “Requiere revisión humana.”

Never display “approved by AI” or equivalent wording.

## Acceptance scenario

If a user uploads an ordinary pet/photo image while selecting a credential type, ETNARA must not represent the file as verified merely because dates were entered. The analysis should flag the mismatch or uncertainty and keep the existing human verification workflow authoritative.

## Scope boundary for 11.1

This phase establishes the validation contract and safe integration boundary. Later 11.x work may add richer extraction/provider integrations, requirement-specific checks, reviewer UX, and analytics without weakening these guardrails.
