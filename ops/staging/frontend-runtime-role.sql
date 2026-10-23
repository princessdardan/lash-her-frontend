-- Proposed grant scope. Apply only to the verified frontend staging database
-- using its direct migration owner; never run against production.
-- Supply LASH_STAGING_RUNTIME_PASSWORD through the process environment.
-- No application migration or customer data is included here.
\set ON_ERROR_STOP on
\getenv runtime_password LASH_STAGING_RUNTIME_PASSWORD
BEGIN;
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L',
  'lash_her_frontend_staging_runtime', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lash_her_frontend_staging_runtime')
\gexec
GRANT CONNECT ON DATABASE neondb TO lash_her_frontend_staging_runtime;
GRANT USAGE ON SCHEMA public TO lash_her_frontend_staging_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lash_her_frontend_staging_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lash_her_frontend_staging_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lash_her_frontend_staging_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO lash_her_frontend_staging_runtime;
COMMIT;
