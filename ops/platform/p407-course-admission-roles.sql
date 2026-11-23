\set ON_ERROR_STOP on
BEGIN;

DO $$
BEGIN
  IF current_database() <> 'lash_her_p407_frontend' OR session_user <> 'postgres'
      OR current_setting('server_version_num')::integer / 10000 <> 18
      OR to_regnamespace('frontend_admission') IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname='lash_her_p407_frontend_migration'
          AND rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)
      )
      OR has_schema_privilege('lash_her_p407_frontend_runtime', 'public', 'CREATE')
      OR EXISTS (SELECT 1 FROM public.course_purchase_orders) THEN
    RAISE EXCEPTION 'P407_ADMISSION_ROLE_PROVISIONING_REFUSED';
  END IF;
END;
$$;

CREATE ROLE lash_her_p407_admission_owner NOLOGIN NOINHERIT;
GRANT CREATE ON DATABASE lash_her_p407_frontend TO lash_her_p407_admission_owner;
GRANT lash_her_p407_admission_owner TO lash_her_p407_frontend_migration WITH INHERIT FALSE, SET TRUE;
COMMIT;
