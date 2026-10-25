-- ROLLBACK of migration 119 (ETNARA Finanzas F1 — services and rates).
-- Run ONLY as the database owner, in one go. A code-only rollback does NOT need
-- it: the previous backend never reads these tables, and no existing table was
-- changed (shifts, timesheets and worker_financial_rates are untouched).
-- Stops, changing nothing, if any agency has stored a service, rate, client,
-- holiday, default or shift term (that data and its history would be lost).
-- 118 (F0) is not touched.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM finance_services) OR EXISTS (SELECT 1 FROM finance_rates)
     OR EXISTS (SELECT 1 FROM billing_clients) OR EXISTS (SELECT 1 FROM billing_client_recipients)
     OR EXISTS (SELECT 1 FROM finance_holidays) OR EXISTS (SELECT 1 FROM recipient_finance_defaults)
     OR EXISTS (SELECT 1 FROM shift_finance_terms) THEN
    RAISE EXCEPTION 'finance services data exists: rollback aborted, nothing changed';
  END IF;
END $$;

DROP TABLE IF EXISTS shift_finance_terms;
DROP TABLE IF EXISTS recipient_finance_defaults;
DROP TABLE IF EXISTS finance_rates;
DROP TABLE IF EXISTS finance_holidays;
DROP TABLE IF EXISTS billing_client_recipients;
DROP TABLE IF EXISTS billing_clients;
DROP TABLE IF EXISTS finance_services;
DROP FUNCTION IF EXISTS public.app_shift_finance_terms_guard();
DROP FUNCTION IF EXISTS public.app_finance_service_guard();
DROP FUNCTION IF EXISTS public.app_finance_rate_guard();

DELETE FROM schema_migrations WHERE filename = '119_finance_services_rates.sql';

COMMIT;
