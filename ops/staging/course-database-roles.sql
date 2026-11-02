-- Course staging role preparation only; no application migration or credentials.
-- Approved target: damp-mouse-63038480 / br-solitary-art-b4n5ohq5 / neondb.
-- The operator must verify the direct endpoint independently before submission:
-- ep-sparkling-moon-b4htlczb.c-6.us-east-2.aws.neon.tech.
-- SQL cannot independently prove the Neon project/branch/endpoint identity.
-- Both roles remain NOLOGIN until protected credential provisioning is ready.
-- Refuse existing roles rather than changing an existing principal or password.
BEGIN;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '5s';
DO $guard$
BEGIN
  IF current_database() <> 'neondb' OR current_user <> 'neondb_owner'
     OR current_setting('server_version_num')::integer / 10000 <> 18 THEN
    RAISE EXCEPTION 'COURSE_ROLE_TARGET_REFUSED';
  END IF;
  IF NOT pg_try_advisory_xact_lock(5494745940314423301::bigint) THEN
    RAISE EXCEPTION 'COURSE_ROLE_LOCK_BUSY';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN
      ('lash_her_course_staging_migration', 'lash_her_course_staging_runtime')) THEN
    RAISE EXCEPTION 'COURSE_ROLE_ALREADY_EXISTS_REVIEW_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p','v','m','f','S'))
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','drizzle'))
     OR EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname IN ('public','drizzle') AND t.typtype='e') THEN
    RAISE EXCEPTION 'COURSE_ROLE_EMPTY_BASELINE_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace n
      CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
      WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type='CREATE')
     OR EXISTS (SELECT 1 FROM pg_database d
      CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a
      WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type='CREATE') THEN
    RAISE EXCEPTION 'COURSE_ROLE_PUBLIC_CREATE_REQUIRES_REVIEW';
  END IF;
END
$guard$;
CREATE ROLE lash_her_course_staging_migration NOLOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE lash_her_course_staging_runtime NOLOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
-- The existing owner is the administrative provisioning principal, not a runtime
-- identity. Explicit SET membership permits ownership-scoped default grants.
GRANT lash_her_course_staging_migration TO neondb_owner
  WITH INHERIT FALSE, SET TRUE;
GRANT CONNECT, CREATE ON DATABASE neondb TO lash_her_course_staging_migration;
GRANT USAGE, CREATE ON SCHEMA public TO lash_her_course_staging_migration;
GRANT CONNECT ON DATABASE neondb TO lash_her_course_staging_runtime;
GRANT USAGE ON SCHEMA public TO lash_her_course_staging_runtime;
SET LOCAL ROLE lash_her_course_staging_migration;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lash_her_course_staging_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lash_her_course_staging_runtime;
RESET ROLE;
COMMIT;
