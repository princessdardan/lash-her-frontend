-- Community staging only: still-darkness-27201043 / neondb.
-- Applied using the existing neondb_owner direct connection. Runtime uses the
-- pooled endpoint and never receives this owner's migration credentials.
-- Supply LASH_STAGING_RUNTIME_PASSWORD through the process environment.
-- No application schema migration is included.
\set ON_ERROR_STOP on
\getenv runtime_password LASH_STAGING_RUNTIME_PASSWORD
BEGIN;
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT',
  'lash_her_community_staging_runtime', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lash_her_community_staging_runtime')
\gexec
GRANT CONNECT ON DATABASE neondb TO lash_her_community_staging_runtime;
GRANT USAGE ON SCHEMA public TO lash_her_community_staging_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lash_her_community_staging_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lash_her_community_staging_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lash_her_community_staging_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lash_her_community_staging_runtime;
COMMIT;
