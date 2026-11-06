# Proposed managed API role/schema preflight

**Plan only. No managed-database connection or query has run.** Root must validate these exact credential/target/CA contexts before an executable observer is prepared or invoked. This observes provider defaults; it neither relaxes role policy nor grants migration/admission authority.

## Fixed contexts and private provenance

Use only the five preserved API service environment files already privately compared to the accepted C07 binding: Course API/publisher/snapshot, and Community API/worker. Verify all five regular-file/owner/private-permission and unchanged-byte bindings again in process. Parse only their existing named staging database URLs privately. Do not open the mounted FIFO, load dotenv, obtain another credential, read a store or use an inherited PG/environment default.

Public selectors come from C07's retained `qualification-receipts/database-current-after/{course,community}/database-receipt.json` and retained API job runtime-role metadata:

| Context | Exact host | Port/database/major | Authenticated runtime role | API migration role to observe |
| --- | --- | --- | --- | --- |
| Course | `ep-sparkling-moon-b4htlczb.c-6.us-east-2.aws.neon.tech` | `5432 / neondb / 18` | `lash_her_course_staging_runtime` | `lash_her_course_staging_migration` |
| Community | `ep-fancy-glitter-b81a2g6r.c-14.us-east-1.aws.neon.tech` | `5432 / neondb / 18` | `lash_her_community_staging_runtime` | `lash_her_community_staging_migration` |

Before any connection, all three Course URL identities/credentials must agree privately, as must both Community URLs. A disagreement is UNKNOWN, not permission to try different passwords. This permits two sequential sessions, one per exact API context. No frontend, pooled/alternate endpoint, alternate database, migration credential or owner login is substituted.

Construct explicit `pg.Client` host/port/database/user/password properties in memory; do not pass a connection string alongside an SSL object. Proposed CA context for root validation is the built-in `tls.rootCertificates` from pinned Node 24.18.0, supplied explicitly with exact hostname/SNI and `rejectUnauthorized: true`. Use the repository's pinned pg dependency. Accept no caller CA, client key, proxy or TLS override; inherit no `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`/`SSL_CERT_DIR`, TLS-disable flag, Node hook or PG override. The private API-mesh CA is not the Neon database CA. Confirm encrypted/authorized transport and the selected physical backend before/after observations. The [node-postgres SSL documentation](https://node-postgres.com/features/ssl) explains why SSL query parameters in a connection string can replace the intended SSL object.

Use startup-only `default_transaction_read_only=on` and bounded connection/statement timeouts; distinguish these observer-imposed settings from provider defaults. No `SET ROLE`, transaction-control statement, explicit/advisory lock, DDL/DML, schema grant, migration, admission, process/host control or mutation is available. Run only the fixed catalog queries below. A permission/TLS/identity/schema/row-bound failure is UNKNOWN; there is no credential fallback, repair or automatic retry.

## Literal metadata queries

All identifiers/functions resolve through `pg_catalog`; bound names/OIDs come only from the fixed contexts or the preceding catalog result. Do not accept caller SQL. Repeat these observations once at the end on the same connection; require stable identity, roles, memberships and schema results, then close it. Metadata drift remains UNKNOWN. Limits are sentinels: a returned limit row marks incomplete coverage rather than an empty/complete result.

`identity` has no parameters. Its read-only state is imposed by this observer, not claimed as a stored provider default.

```sql
SELECT pg_catalog.current_database() AS database_name,
       current_user AS authenticated_role, session_user AS session_role,
       current_user::pg_catalog.regrole::oid::text AS authenticated_role_oid,
       d.datdba::text AS database_owner_oid,
       pg_catalog.pg_get_userbyid(d.datdba) AS database_owner_name,
       pg_catalog.current_setting('server_version_num')::integer / 10000 AS server_major,
       pg_catalog.current_setting('transaction_read_only') AS read_only,
       pg_catalog.current_setting('search_path') AS session_search_path,
       pg_catalog.pg_backend_pid() AS backend_pid,
       s.ssl AS server_reports_tls, s.version AS tls_protocol,
       s.cipher AS tls_cipher, s.bits AS tls_bits
FROM pg_catalog.pg_database d
LEFT JOIN pg_catalog.pg_stat_ssl s ON s.pid = pg_catalog.pg_backend_pid()
WHERE d.datname = pg_catalog.current_database();
```

`roles`: `$1::text[]` is exactly the context's expected runtime and API migration names, plus `pg_database_owner`. Include the actual database owner and parent memberships to explain provider-derived privileges. Return setting **names only**; never select a password, SCRAM verifier or raw `rolconfig` value.

```sql
WITH RECURSIVE relevant(oid) AS (
  SELECT r.oid FROM pg_catalog.pg_roles r
  WHERE r.rolname = ANY($1::text[])
     OR r.oid = (SELECT datdba FROM pg_catalog.pg_database
                 WHERE datname = pg_catalog.current_database())
  UNION
  SELECT m.roleid FROM pg_catalog.pg_auth_members m
  JOIN relevant r ON r.oid = m.member
)
SELECT r.oid::text AS role_oid, r.rolname AS role_name,
       r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
       r.rolreplication, r.rolbypassrls, r.rolinherit,
       r.rolconnlimit, r.rolvaliduntil::text AS role_valid_until,
       r.rolconfig IS NULL AS role_config_is_null,
       ARRAY(SELECT pg_catalog.split_part(config.setting, '=', 1)
             FROM pg_catalog.unnest(COALESCE(r.rolconfig, ARRAY[]::text[])) AS config(setting)
             ORDER BY 1) AS role_setting_names,
       pg_catalog.pg_has_role(r.oid, 'MEMBER') AS runtime_member,
       pg_catalog.pg_has_role(r.oid, 'USAGE') AS runtime_inherits,
       pg_catalog.pg_has_role(r.oid, 'SET') AS runtime_can_set,
       pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'CONNECT') AS database_connect,
       pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'CREATE') AS database_create,
       pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'TEMP') AS database_temporary
FROM pg_catalog.pg_roles r JOIN relevant x ON x.oid = r.oid
ORDER BY r.oid
LIMIT 65;
```

`memberships`: `$1::oid[]` contains only the observed relevant role OIDs from `roles` (at most 64). No membership is granted or changed.

```sql
SELECT m.roleid::text AS role_oid, m.member::text AS member_oid,
       m.grantor::text AS grantor_oid,
       m.admin_option, m.inherit_option, m.set_option
FROM pg_catalog.pg_auth_members m
WHERE m.roleid = ANY($1::oid[]) OR m.member = ANY($1::oid[])
ORDER BY m.roleid, m.member, m.grantor
LIMIT 4097;
```

`schemas`: enumerate every namespace; do not predeclare that only `public`/`drizzle`, or that any provider prefix, is safe. Parameters are unnecessary because effective privileges are for the authenticated runtime principal.

```sql
SELECT n.oid::text AS schema_oid, n.nspname AS schema_name,
       n.nspowner::text AS owner_oid,
       pg_catalog.pg_get_userbyid(n.nspowner) AS owner_name,
       n.nspacl IS NULL AS default_acl,
       pg_catalog.has_schema_privilege(n.oid, 'USAGE') AS runtime_usage,
       pg_catalog.has_schema_privilege(n.oid, 'CREATE') AS runtime_create,
       ARRAY(SELECT e.extname FROM pg_catalog.pg_extension e
             WHERE e.extnamespace = n.oid ORDER BY e.extname) AS extension_names
FROM pg_catalog.pg_namespace n
ORDER BY n.nspname
LIMIT 257;
```

`schemaAcl`: explode actual/default namespace ACLs so PUBLIC-derived access is visible. Do not infer that an effective privilege is a direct grant.

```sql
SELECT n.oid::text AS schema_oid, n.nspname AS schema_name,
       a.grantor::text AS grantor_oid, a.grantee::text AS grantee_oid,
       a.grantee = 0 AS grantee_public,
       a.privilege_type, a.is_grantable
FROM pg_catalog.pg_namespace n
CROSS JOIN LATERAL pg_catalog.aclexplode(
  COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
ORDER BY n.oid, a.grantee, a.grantor, a.privilege_type
LIMIT 4097;
```

These use documented [role attributes](https://www.postgresql.org/docs/18/view-pg-roles.html), [membership options](https://www.postgresql.org/docs/18/catalog-pg-auth-members.html), [namespace ownership/ACLs](https://www.postgresql.org/docs/18/catalog-pg-namespace.html) and [privilege-inquiry functions](https://www.postgresql.org/docs/18/functions-info.html). No application relation, row, migration journal, table count, column listing or function body is queried.

## Proposed sanitized result and interpretation

Return `status: P2_MANAGED_API_ROLE_METADATA_OBSERVED` only for successful complete stable observations; otherwise `P2_MANAGED_API_ROLE_METADATA_UNKNOWN` and a fixed stage/code. Fields are `context`, public `target`, `sourceBindingVerified`, `tlsAuthorized`, `identity`, `roles`, `memberships`, `schemas`, `schemaAcl`, `rowBoundsComplete`, `readbackStable`, `metadataOnly: true`, `frontendQualified: false`, `migrationAuthorized: false`, `rolePreparationAuthorized: false`. Do not retain URLs/passwords, raw errors, private file bytes/digests, certificate bodies/fingerprints, raw GUC values or unrelated principal details.

Actual provider role flags and PUBLIC/schema privileges are observations, not automatic allowlists or invented requirements. They cannot establish frontend operator attributes, frontend schema safety, historical fencing or application readiness. The missing original frontend credential/archive remains unresolved; API material cannot qualify it. Root must validate the two selectors, runtime principals, CA choice and private custody/grouping before any connection.
