# Managed API role/schema metadata: observed

**Both approved direct API contexts completed the metadata-only preflight.** One fresh read-only PostgreSQL 18 session per target ran the six fixed catalog queries and repeated them on the same physical backend. Complete metadata was stable, source and accepted credential bindings matched on readback, and both clients closed awaited. [Sanitized summary](metadata-pass-3-summary.json) and [complete sanitized observations](metadata-pass-3-sanitized.json) retain the actual results.

This is read-only preparation. It does not qualify the frontend, grant migration/admission authority, accept a staging release or close P2/G2. No source-policy recommendation follows solely from these observations.

## Observer correction and retained failures

[Attempt 1](attempt-1-sanitized.json) and [identity diagnostic 2](identity-diagnostic-2-sanitized.json) remain unchanged. Both earlier stages refused the original observer guard. Diagnostic 2 showed verified client TLS 1.3 while `pg_stat_ssl.ssl` was false, with every other identity conjunct matching.

The reviewed correction applies only to this observer: client TLS acceptance requires the actual Node socket to be encrypted and authorized, the exact built-in Node CA roots, explicit selected-host SNI, `rejectUnauthorized: true`, and all fixed database, authenticated/session-role, host, port, major, read-only, search-path and backend-PID guards. Backend `pg_stat_ssl` fields remain observations and no longer decide client transport acceptance. Tests retain refusal for plain/unauthorized client sockets, substituted CA/SNI, disabled certificate verification and every other required identity mismatch.

Neon's [connection guidance](https://neon.com/docs/connect/connect-securely) describes CA and hostname verification. Its [security overview](https://neon.com/docs/security/security-overview) describes a proxy that authenticates connections before they reach PostgreSQL. PostgreSQL documents [`pg_stat_ssl`](https://www.postgresql.org/docs/18/monitoring-stats.html#MONITORING-PG-STAT-SSL-VIEW) as backend-connection SSL statistics. The observed distinction supports separating those checks; this preflight does not independently establish the provider's internal TLS topology.

## Observed roles and privileges

Both selected runtime and migration roles have LOGIN true and SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS and INHERIT false. Each has connection limit -1, no expiry and null role configuration with an empty setting-name list. Names and OIDs are retained only for the explicitly allowed roles; the unallowlisted relevant role name at OID 6392 is redacted while its OID and attributes remain. No password/verifier or raw role-setting value was selected.

| Observation | Course | Community |
| --- | --- | --- |
| Relevant role rows / membership rows | 15 / 15 | 15 / 14 |
| Schema rows / effective ACL rows | 5 / 16 | 5 / 16 |
| Runtime database CONNECT / CREATE / TEMP | true / false / true | true / false / true |
| Migration database CONNECT / CREATE / TEMP | true / true / true | true / true / true |
| Runtime MEMBER / inherited USAGE / SET for migration role | false / false / false | false / false / false |
| Scoped database-role setting rows | 0 | 0 |

The observed database owner in both contexts is `neondb_owner` (OID 16393): LOGIN true, SUPERUSER false, and CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS and INHERIT true. Its observed ancestor `neon_superuser` (OID 16384) has those broad flags true but LOGIN false and SUPERUSER false. `pg_database_owner` (OID 6171) has INHERIT true, LOGIN false and all those broad flags false. These provider-owner attributes do not authorize their use as an application runtime or migration operator.

For both authenticated runtime roles, schema USAGE is true for `public`, `pg_catalog` and `information_schema`, and false for `drizzle` and `pg_toast`. Schema CREATE is false for every observed schema. `drizzle` is owned by the context's exact migration role, `public` by `pg_database_owner`, and the system schemas by `cloud_admin`. The complete ACL rows preserve PUBLIC-derived privilege evidence instead of treating effective access as a direct grant.

The names-only `pg_db_role_setting` query returned no rows for the selected database/global database scope and observed relevant role/global role scope. This does not establish every server default or another database/role's settings. Session `search_path=pg_catalog,public`, read-only mode and timeouts were imposed by this observer and are not presented as stored provider defaults. Extension-name arrays are retained in the PostgreSQL name-array representation returned by the pinned client.

## Scope, privacy and validation

This final pass used two sequential managed sessions and 24 catalog SELECTs in total. Across all three explicitly authorized stages, six sessions and 28 catalog SELECTs ran. No application or journal rows, SQL mutation, role switch, explicit/advisory lock, migration, repair, credential fallback or provider/host/admission control occurred. There was no automatic retry.

All five original accepted API runtime files were verified privately before connection and after observation. The observer program, lockfile and accepted source reference were also unchanged on readback. The child inherited only `PATH` and `LANG`; pinned Node 24.18.0 used explicit built-in CA roots and strict TLS/SNI. Both successful sessions recorded authorized client TLS 1.3 and backend SSL false separately. Every row sentinel remained below its bound.

Unexpected role names are null with a redaction marker; OID joins remain intact. Setting names only, fixed public target selectors and role/schema attributes are published. No credential bytes or credential-file hashes, connection URL/password, certificate body, raw GUC value, raw upstream error or private temporary-directory locator is included.

Ten tests passed with no skips, including the actual production identity guard and all six literal SQL queries twice against an owned disposable PostgreSQL 16.13 cluster. ESLint, JavaScript syntax and whitespace checks passed. The local cluster proves query execution and guard behavior only; the separate final managed records prove these scoped PostgreSQL 18 observations. No production application, API operator, TLS, role or deployment policy was changed.
