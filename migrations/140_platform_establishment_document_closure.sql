-- 140: ETNARA Central deja de tener acceso permanente a los documentos institucionales de las
-- agencias (decisión de producto del 1-nov-2026; PR 1 de ETNARA Verified).
--
-- Antes (125): Central leía todos los documentos de establecimiento no archivados de todas las
-- agencias y registraba aprobado/rechazado («ETNARA Verified» permanente).
-- Ahora: un superadministrador de plataforma ve 0 filas y no puede escribir ninguna, igual que
-- con los datos de residentes (078). El acceso futuro será solo por autorización expresa y
-- temporal de la agencia, documento por documento (PR 2, no incluido).
--
-- Qué cambia:
--   * se retiran las dos políticas de revisión de Central creadas en la 125;
--   * se añade la política RESTRICTIVA platform_phi_deny, la misma de la 078 para datos de residentes.
--     Las ramas «OR app_is_superadmin()» de las políticas de la agencia (125) quedan inertes.
-- Qué NO cambia: los permisos (GRANT) de app_runtime, las políticas de la agencia (gerencia y
-- administración del establecimiento de su propia organización), el trigger que impide a la
-- agencia aprobarse a sí misma, los documentos ya guardados y su estado de revisión.
-- Idempotente. Reversión: ops/140_platform_establishment_document_closure.rollback.sql

DROP POLICY IF EXISTS establishment_documents_platform_review_read ON establishment_documents;
DROP POLICY IF EXISTS establishment_documents_platform_review_update ON establishment_documents;

DROP POLICY IF EXISTS platform_phi_deny ON establishment_documents;
CREATE POLICY platform_phi_deny ON establishment_documents AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());
