-- 150: vencimiento explícito de los documentos institucionales (D4, 5-nov-2026).
--
-- Tres estados, sin fechas artificiales:
--   * fecha real ............... expires_on con fecha;
--   * sin vencimiento aplicable  expiry_not_applicable = true y expires_on NULL;
--   * vencimiento no informado . expiry_not_applicable = false y expires_on NULL.
--
-- Solo añade una columna con valor por defecto constante (PostgreSQL no reescribe la tabla ni
-- toca ninguna fila: todos los documentos existentes quedan exactamente igual, y los que no
-- tienen fecha siguen siendo «no informada») y una restricción que ninguna fila existente puede
-- incumplir. No cambia la 149: la aplicación sigue sin poder modificar documentos (solo archiva
-- e inserta versiones nuevas); app_runtime inserta la columna nueva con su permiso de tabla.
-- La responsabilidad de los documentos sigue siendo de cada agencia; ETNARA Central no tiene acceso.
-- Idempotente. Reversión: ops/150_establishment_document_expiry.rollback.sql

ALTER TABLE establishment_documents ADD COLUMN IF NOT EXISTS expiry_not_applicable boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'establishment_documents_expiry_not_applicable_check'
                 AND conrelid = 'public.establishment_documents'::regclass) THEN
    ALTER TABLE establishment_documents
      ADD CONSTRAINT establishment_documents_expiry_not_applicable_check
      CHECK (NOT expiry_not_applicable OR expires_on IS NULL) NOT VALID;
  END IF;
END $$;
-- Ninguna fila existente tiene la marca: la validación no puede fallar.
ALTER TABLE establishment_documents VALIDATE CONSTRAINT establishment_documents_expiry_not_applicable_check;

COMMENT ON COLUMN establishment_documents.expiry_not_applicable IS
  'true = el documento no vence (sin vencimiento aplicable). false con expires_on NULL = vencimiento no informado.';
