-- Reversión de 150 (deja el esquema igual que 149).
-- Efecto en datos: los documentos marcados «sin vencimiento aplicable» pasan a verse como
-- «vencimiento no informado» (la marca se pierde). Fechas, archivos, versiones e historial intactos.
-- Ejecutar como propietario de las migraciones, en una transacción.
BEGIN;
ALTER TABLE establishment_documents DROP CONSTRAINT IF EXISTS establishment_documents_expiry_not_applicable_check;
ALTER TABLE establishment_documents DROP COLUMN IF EXISTS expiry_not_applicable;
DELETE FROM schema_migrations WHERE filename = '150_establishment_document_expiry.sql';
COMMIT;
