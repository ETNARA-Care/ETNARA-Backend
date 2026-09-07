-- Migration 040: ensure app_runtime can connect to the database where the
-- ETNARA schema is installed. Migration 017 originally named a local database
-- directly, so existing installations need this additive correction.
DO $$
BEGIN
    EXECUTE format(
        'GRANT CONNECT ON DATABASE %I TO app_runtime',
        current_database()
    );
END
$$;
