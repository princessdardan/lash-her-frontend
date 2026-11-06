import { createHash, randomUUID } from "node:crypto";
import { readdirSync, lstatSync, fstatSync, readSync, realpathSync, openSync, closeSync, writeFileSync, fsyncSync, linkSync, unlinkSync, constants, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Client } from "pg";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { buildExpectedPrivateDbMigrationLineage, assertAppliedMigrationLineage } from "../../src/lib/private-db/migration-lineage.ts";
import { readMigrationCatalog } from "./frontend-schema.mjs";
import { assertSourceCheckout } from "./source-checkout.mjs";
import { phase2ContractManifestBinding } from "./release.mjs";
import { decodeQualificationTargetJson, parseQualificationTargetProfileRef, QualificationTargetProfileError, requireQualificationTargetProfile, resolveQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE } from "./qualification-target-profile.mjs";

export const FRONTEND_MIGRATION_LOCK = "lash-her:private-db:migrations";
// hashtext is sign-extended by pg_advisory_lock(bigint). Match both halves,
// including negative hashes, rather than assuming pg_locks.classid is zero.
const HELD_FRONTEND_LOCK = `select exists(select 1 from pg_locks where locktype='advisory'
  and pid=pg_backend_pid() and database=(select oid from pg_database where datname=current_database())
  and classid=((hashtext($1)::bigint >> 32) & 4294967295)::oid
  and objid=(hashtext($1)::bigint & 4294967295)::oid and objsubid=1
  and mode='ExclusiveLock' and granted) as held`;
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const demand = (ok, code) => { if (!ok) throw new Error(code); };
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value) && !/^0+$/u.test(value);
const safeName = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,63}$/u.test(value);
function profileContext(expected, ...carriers) {
  if (expected === undefined) {
    if (carriers.some(value => value && Object.hasOwn(value, "qualificationTargetProfile"))) throw new QualificationTargetProfileError("QUALIFICATION_TARGET_PROFILE_REFUSED");
    return undefined;
  }
  const selected = requireQualificationTargetProfile(expected, ...carriers), definition = resolveQualificationTargetProfile(selected);
  if (definition.environment !== "staging" || definition.kind !== "existing-staging") throw new QualificationTargetProfileError("QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED");
  return selected;
}

function read(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    demand(info.isFile() && info.size > 0 && info.size <= 2_000_000, "INPUT_FILE_REFUSED");
    const bytes = Buffer.alloc(2_000_001); let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    demand(length <= 2_000_000, "INPUT_FILE_REFUSED");
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

export function writeFrontendReceipt(directory, name, value) {
  const path = join(directory, name), temporary = join(directory, `.${name}.${randomUUID()}`);
  let linked = false;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd);
    linkSync(temporary, path); linked = true;
    const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } catch (error) {
    if (linked) { try { unlinkSync(path); } catch { /* failed retention remains an error */ } }
    throw error;
  } finally { closeSync(fd); try { unlinkSync(temporary); } catch { /* private temporary file only */ } }
}

export function frontendMigrationArtifact(sourceRoot = root) {
  const folder = join(sourceRoot, "drizzle"), journalBytes = read(join(folder, "meta/_journal.json"));
  const journal = JSON.parse(journalBytes);
  demand(Array.isArray(journal.entries) && journal.entries.length > 0, "SOURCE_JOURNAL_REQUIRED");
  const seen = new Set(); let previous = 0;
  for (const entry of journal.entries) {
    demand(typeof entry.tag === "string" && /^\d{4}_[a-z0-9_]+$/u.test(entry.tag) && !seen.has(entry.tag) &&
      Number.isSafeInteger(entry.when) && entry.when > previous && !lstatSync(join(folder, `${entry.tag}.sql`)).isSymbolicLink(), "SOURCE_JOURNAL_REFUSED");
    seen.add(entry.tag); previous = entry.when;
  }
  demand(readdirSync(folder).filter((name) => name.endsWith(".sql") && !name.endsWith(".down.sql"))
    .every((name) => seen.has(name.slice(0, -4))), "UNJOURNALED_SOURCE_SQL_REFUSED");
  const migrations = readMigrationFiles({ migrationsFolder: folder }).map((migration, index) => {
    demand(migration.folderMillis === journal.entries[index].when, "SOURCE_ORDER_REFUSED");
    return { ...migration, tag: journal.entries[index].tag };
  });
  const manifest = { journalSha256: hash(journalBytes), entries: migrations.map(({ tag, hash, folderMillis }) => ({ tag, hash, folderMillis })) };
  return { migrations, expected: buildExpectedPrivateDbMigrationLineage(migrations), sqlArtifactSha256: hash(JSON.stringify(manifest)), manifest,
    ...(existsSync(join(sourceRoot, "contracts/api-integration/p2-candidate/manifest.json")) ? (() => {
      const { contractPhase, phase2ContractManifestSha256 } = phase2ContractManifestBinding(sourceRoot);
      return { contractPhase, phase2ContractManifestSha256 };
    })() : {}),
    contractManifestSha256: "sha256:" + hash(read(join(sourceRoot, "contracts/api-integration/v1/manifest.json"))) };
}

export function prepareFrontendMigration(candidate, job, baseline, artifact = undefined, expectedProfile = undefined) {
  if (expectedProfile !== undefined) parseQualificationTargetProfileRef(expectedProfile);
  const profile = profileContext(expectedProfile, candidate, candidate?.frontendMigration, job, job?.target);
  if (profile && (candidate?.version !== 3 || job?.version !== 2)) throw new QualificationTargetProfileError("QUALIFICATION_TARGET_PROFILE_REQUIRED");
  demand(!profile || candidate.environment === "staging", "QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED");
  demand(candidate?.version === (profile ? 3 : 2) && candidate.integration?.state === "passed" &&
    candidate.sourceApproval?.mode === "single-operator-dispatch" && candidate.sourceApproval.operatorGithubUserId === "8996309" &&
    candidate.sources?.frontend?.repository === "https://github.com/princessdardan/lash-her-frontend.git" &&
    candidate.sources.frontend.requiredChecks === "passed", "QUALIFIED_CANDIDATE_REQUIRED");
  demand(job?.version === (profile ? 2 : 1) && job.operator === "Dardan" && ["staging", "production"].includes(job.environment) && job.environment === candidate.environment &&
    typeof job.releaseId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(job.releaseId) && job.releaseId === candidate.releaseId &&
    sha(job.sourceCommit) && job.sourceCommit === candidate.sources.frontend.commit &&
    job.contractManifestSha256 === candidate.contractManifestSha256, "FRONTEND_RELEASE_BINDING_REFUSED");
  if (artifact === undefined) artifact = frontendMigrationArtifact();
  profileContext(undefined, artifact, baseline);
  demand(job.contractManifestSha256 === artifact.contractManifestSha256, "FRONTEND_RELEASE_BINDING_REFUSED");
  demand(candidate.frontendMigration?.sourceCommit === job.sourceCommit && candidate.frontendMigration.sqlArtifactSha256 === artifact.sqlArtifactSha256 &&
    candidate.frontendMigration.contractManifestSha256 === job.contractManifestSha256, "CANDIDATE_FRONTEND_SQL_BINDING_REQUIRED");
  const bindings = [artifact, candidate, candidate.frontendMigration, job];
  if (bindings.some(value => value.contractPhase !== undefined || value.phase2ContractManifestSha256 !== undefined)) {
    demand(bindings.every(value => value.contractPhase === "p2" && /^sha256:[a-f0-9]{64}$/u.test(value.phase2ContractManifestSha256 ?? "") &&
      !/^sha256:0+$/u.test(value.phase2ContractManifestSha256) && value.phase2ContractManifestSha256 === artifact.phase2ContractManifestSha256),
    "FRONTEND_PHASE2_CONTRACT_BINDING_REQUIRED");
  }
  demand(/^sha256:[a-f0-9]{64}$/u.test(job.migrationImageDigest ?? "") && !/^sha256:0+$/u.test(job.migrationImageDigest) &&
    candidate.artifacts?.frontendMigration?.image === `ghcr.io/princessdardan/lash-her-platform-frontend-migration@${job.migrationImageDigest}`,
  "FRONTEND_MIGRATION_IMAGE_BINDING_REQUIRED");
  const target = job.target;
  demand(typeof target?.host === "string" && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(target.host) && !target.host.includes("-pooler") &&
    safeName(target.database) && safeName(target.user) && safeName(target.runtimeRole) && target.user !== target.runtimeRole &&
    Number.isSafeInteger(target.port) && target.port > 0 && target.port < 65536 && [16, 18].includes(target.serverMajor) &&
    Array.isArray(target.approvedPendingTags) && target.approvedPendingTags.every((tag) => /^\d{4}_[a-z0-9_]+$/u.test(tag)) &&
    typeof target.allowEmptyBootstrap === "boolean" && typeof job.recoveryRef === "string" && /^[A-Za-z0-9_./:-]{1,200}$/u.test(job.recoveryRef), "FRONTEND_TARGET_REFUSED");
  demand(digest(job.sqlArtifactSha256) && job.sqlArtifactSha256 === artifact.sqlArtifactSha256 &&
    digest(job.schemaBaselineSha256) && hash(JSON.stringify(baseline)) === job.schemaBaselineSha256 &&
    candidate.frontendMigration.schemaBaselines?.[target.serverMajor] === job.schemaBaselineSha256 &&
    baseline?.version === 1 && baseline.serverMajor === target.serverMajor && baseline.sqlArtifactSha256 === artifact.sqlArtifactSha256 &&
    ["relations", "columns", "constraints", "indexes", "triggers", "functions", "enums", "sequences", "policies"].every((name) => Array.isArray(baseline.catalog?.[name])), "FRONTEND_SCHEMA_ARTIFACT_REFUSED");
  if (job.environment === "production") {
    const prior = job.stagingVerification;
    demand(prior?.database?.status === "DATABASE_VERIFIED" && prior.database.environment === "staging" && prior.database.service === "frontend" &&
      prior.terminal?.status === "DATABASE_VERIFIED" && prior.database.sourceCommit === job.sourceCommit &&
      prior.database.sqlArtifactSha256 === job.sqlArtifactSha256 && prior.database.contractManifestSha256 === job.contractManifestSha256 &&
      prior.database.migrationImageDigest === job.migrationImageDigest &&
      prior.database.contractPhase === job.contractPhase && prior.database.phase2ContractManifestSha256 === job.phase2ContractManifestSha256 &&
      prior.database.schemaVerified === true && prior.database.runtimeRoleVerified === true &&
      prior.database.schemaBaselineSha256 === job.schemaBaselineSha256 &&
      ["version", "service", "environment", "releaseId", "sourceCommit", "migrationImageDigest", "sqlArtifactSha256", "contractManifestSha256", "schemaBaselineSha256", "target"]
        .every((key) => prior.database[key] !== undefined && isDeepStrictEqual(prior.database[key], prior.terminal[key])) &&
      prior.database.contractPhase === prior.terminal.contractPhase && prior.database.phase2ContractManifestSha256 === prior.terminal.phase2ContractManifestSha256 &&
      prior.database.failureCode === undefined && prior.terminal.failureCode === undefined,
    "EXACT_STAGING_FRONTEND_MIGRATION_REQUIRED");
  }
  return { ...(profile ? { qualificationTargetProfile: profile } : {}), candidate: structuredClone(candidate), job: structuredClone(job), baseline: structuredClone(baseline), artifact };
}

// Derive bindings mechanically from one candidate, maintained target settings
// and the private owned-schema export; never copy an unknown credential field.
export function prepareFrontendMigrationJob(candidate, settings, schemaExport, stagingVerification = undefined, expectedProfile = undefined) {
  if (expectedProfile !== undefined) parseQualificationTargetProfileRef(expectedProfile);
  const profile = profileContext(expectedProfile, candidate, candidate?.frontendMigration, settings,
    ...(stagingVerification === undefined ? [] : [stagingVerification, stagingVerification?.database, stagingVerification?.terminal]));
  if (profile && candidate?.version !== 3) throw new QualificationTargetProfileError("QUALIFICATION_TARGET_PROFILE_REQUIRED");
  demand(candidate?.version === (profile ? 3 : 2) && (!profile || candidate.environment === "staging"), "QUALIFIED_CANDIDATE_REQUIRED");
  demand(schemaExport?.status === "FRONTEND_MIGRATION_OWNED_POSTGRES_PASS" && schemaExport.providerTouched === false &&
    schemaExport.postgresMajor === settings?.serverMajor && schemaExport.schemaBaseline?.serverMajor === settings.serverMajor, "FRONTEND_SCHEMA_EXPORT_REQUIRED");
  if (candidate.contractPhase === "p2") demand(schemaExport.contractPhase === "p2" &&
    schemaExport.phase2ContractManifestSha256 === candidate.phase2ContractManifestSha256, "FRONTEND_PHASE2_SCHEMA_EXPORT_REQUIRED");
  const baseline = structuredClone(schemaExport.schemaBaseline);
  const job = { version: profile ? 2 : 1, ...(profile ? { qualificationTargetProfile: profile } : {}), operator: "Dardan", releaseId: candidate.releaseId, environment: candidate.environment,
    ...(candidate.contractPhase === "p2" ? { contractPhase: "p2", phase2ContractManifestSha256: candidate.phase2ContractManifestSha256 } : {}),
    sourceCommit: candidate.sources?.frontend?.commit, contractManifestSha256: candidate.contractManifestSha256,
    migrationImageDigest: candidate.artifacts?.frontendMigration?.image?.split("@")[1],
    sqlArtifactSha256: candidate.frontendMigration?.sqlArtifactSha256, schemaBaselineSha256: hash(JSON.stringify(baseline)),
    recoveryRef: settings.recoveryRef,
    target: { ...Object.fromEntries(["host", "port", "database", "user", "runtimeRole", "serverMajor", "allowEmptyBootstrap", "approvedPendingTags"].map((key) => [key, settings[key]])), ...(profile ? { qualificationTargetProfile: profile } : {}) },
    ...(candidate.environment === "production" ? { stagingVerification } : {}) };
  prepareFrontendMigration(candidate, job, baseline, undefined, profile);
  return { job, baseline };
}

export function frontendConnectionOptions(value, target) {
  let url; try { url = new URL(value); } catch { throw new Error("FRONTEND_CREDENTIAL_TARGET_REFUSED"); }
  demand(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname === target.host && Number(url.port || 5432) === target.port &&
    decodeURIComponent(url.pathname) === `/${target.database}` && decodeURIComponent(url.username) === target.user && url.password && !url.hash &&
    [...url.searchParams].length === 1 && url.searchParams.get("sslmode") === "verify-full", "FRONTEND_CREDENTIAL_TARGET_REFUSED");
  return { host: target.host, port: target.port, database: target.database, user: target.user, password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true }, enableChannelBinding: true, connectionTimeoutMillis: 15_000,
    // Keep pg_catalog implicitly first and unqualified application DDL in
    // public, irrespective of the privileged operator's role/database settings.
    options: "-c search_path=public" + (target.approvedPendingTags?.length === 0 ? " -c default_transaction_read_only=on" : ""),
    statement_timeout: 120_000, lock_timeout: 15_000, application_name: "lash-her-operator-frontend-migration" };
}

async function journal(client) {
  const { rows } = await client.query("select hash, created_at from drizzle.__drizzle_migrations order by created_at asc nulls first, id asc");
  return rows;
}

async function verifyRuntime(client, target, withTables) {
  const { rows } = await client.query(`select rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
    pg_has_role($1,$2,'MEMBER') as migration_member,has_schema_privilege($1,'public','CREATE') as ddl
    from pg_roles where rolname=$1`, [target.runtimeRole, target.user]);
  demand(rows.length === 1 && ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "migration_member", "ddl"].every((key) => rows[0][key] === false), "FRONTEND_RUNTIME_PRIVILEGE_REFUSED");
  const owners = await client.query(`select 1 where has_database_privilege($1,current_database(),'CREATE') or
    exists(select 1 from pg_database where datname=current_database() and pg_has_role($1,datdba,'MEMBER')) or
    exists(select 1 from pg_namespace where nspname in ('public','drizzle') and pg_has_role($1,nspowner,'MEMBER')) or
    exists(select 1 from pg_class where relnamespace='public'::regnamespace and pg_has_role($1,relowner,'MEMBER'))`, [target.runtimeRole]);
  demand(owners.rows.length === 0, "FRONTEND_RUNTIME_OWNERSHIP_REFUSED");
  if (withTables) {
    const grants = await client.query(`select c.relname from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','p') and
      exists(select 1 from unnest(array['SELECT','INSERT','UPDATE','DELETE']) p where not has_table_privilege($1,c.oid,p))`, [target.runtimeRole]);
    demand(grants.rows.length === 0, "FRONTEND_RUNTIME_TABLE_GRANTS_REFUSED");
    const sequences = await client.query(`select c.relname from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='S' and
      exists(select 1 from unnest(array['SELECT','USAGE']) p where not has_sequence_privilege($1,c.oid,p))`, [target.runtimeRole]);
    demand(sequences.rows.length === 0, "FRONTEND_RUNTIME_SEQUENCE_GRANTS_REFUSED");
    const isolation = await client.query("select has_schema_privilege($1,'drizzle','USAGE') as journal_access", [target.runtimeRole]);
    demand(isolation.rows[0].journal_access === false, "FRONTEND_RUNTIME_JOURNAL_ACCESS_REFUSED");
    const defaults = (await client.query(`select d.defaclobjtype as kind,a.privilege_type as privilege
      from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
      where d.defaclrole=current_user::regrole and d.defaclnamespace='public'::regnamespace and a.grantee=$1::regrole`, [target.runtimeRole])).rows;
    demand([...["SELECT", "INSERT", "UPDATE", "DELETE"].map((privilege) => ["r", privilege]), ["S", "SELECT"], ["S", "USAGE"]]
      .every(([kind, privilege]) => defaults.some((entry) => entry.kind === kind && entry.privilege === privilege)), "FRONTEND_RUNTIME_DEFAULT_GRANTS_REFUSED");
  }
}

export async function runFrontendMigration(prepared, dependencies, expectedProfile = undefined) {
  if (expectedProfile !== undefined) parseQualificationTargetProfileRef(expectedProfile);
  const profile = profileContext(expectedProfile, prepared, prepared?.candidate, prepared?.candidate?.frontendMigration, prepared?.job, prepared?.job?.target);
  if (profile) prepared = prepareFrontendMigration(prepared.candidate, prepared.job, prepared.baseline, prepared.artifact, profile);
  const { job, artifact, baseline } = prepared, target = job.target;
  const readOnlyExpected = target.approvedPendingTags.length === 0;
  demand(!profile || readOnlyExpected || typeof dependencies?.beforeDatabasePreflight === "function" && typeof dependencies?.afterDatabaseVerified === "function", "IN_PROCESS_FRONTEND_CONTINUATION_REQUIRED");
  demand(dependencies.confirmation === `${job.environment}/${job.releaseId}`, "EXPLICIT_OPERATOR_CONFIRMATION_REQUIRED");
  demand(dependencies.afterDatabaseVerified === undefined || typeof dependencies.afterDatabaseVerified === "function",
    "IN_PROCESS_FRONTEND_CONTINUATION_REQUIRED");
  demand(dependencies.afterContinuationVerified === undefined || typeof dependencies.afterContinuationVerified === "function" &&
    typeof dependencies.afterDatabaseVerified === "function", "IN_PROCESS_FRONTEND_FINALIZATION_REQUIRED");
  demand(dependencies.beforeDatabasePreflight === undefined || typeof dependencies.beforeDatabasePreflight === "function",
    "IN_PROCESS_FRONTEND_PREFLIGHT_REQUIRED");
  const receiptBase = { version: profile ? 2 : 1, ...(profile ? { qualificationTargetProfile: profile } : {}), service: "frontend", environment: job.environment, releaseId: job.releaseId, sourceCommit: job.sourceCommit,
    ...(job.contractPhase === "p2" ? { contractPhase: "p2", phase2ContractManifestSha256: job.phase2ContractManifestSha256 } : {}),
    migrationImageDigest: job.migrationImageDigest,
    sqlArtifactSha256: job.sqlArtifactSha256, schemaBaselineSha256: job.schemaBaselineSha256, contractManifestSha256: job.contractManifestSha256,
    operator: "Dardan", migrationMode: readOnlyExpected ? "verify-current-only" : "apply-forward",
    target: { host: target.host, port: target.port, database: target.database, user: target.user, serverMajor: target.serverMajor },
    recoveryRef: job.recoveryRef, trafficAuthorized: false };
  let client, locked = false, databaseResult, failure, phase = "source-check";
  try {
    (dependencies.assertSource ?? assertSourceCheckout)(root, job.sourceCommit);
    phase = "credential-acquisition";
    client = (dependencies.createClient ?? ((options) => new Client(options)))(frontendConnectionOptions(await dependencies.getUrl(), target));
    // pg emits idle socket failures outside query promises. Keep a sanitized,
    // sticky failure while the continuation awaits provider work and cleanup.
    client.on("error", () => { failure ??= new Error("FRONTEND_DATABASE_CONNECTION_LOST"); });
    phase = "connect-and-target"; await client.connect();
    demand(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true, "FRONTEND_VERIFIED_TLS_REQUIRED");
    const identity = (await client.query("select pg_backend_pid() as pid,current_user,current_database() as database,current_setting('server_version_num')::int/10000 as major,current_setting('default_transaction_read_only') as default_read_only")).rows[0];
    demand(identity.current_user === target.user && identity.database === target.database && identity.major === target.serverMajor, "FRONTEND_DATABASE_IDENTITY_REFUSED");
    demand(!readOnlyExpected || identity.default_read_only === "on", "FRONTEND_READ_ONLY_SESSION_REQUIRED");
    phase = "database-lock";
    locked = (await client.query("select pg_try_advisory_lock(hashtext($1)) as locked", [FRONTEND_MIGRATION_LOCK])).rows[0].locked;
    demand(locked, "FRONTEND_RELEASE_LOCK_CONTENDED");
    const verifySession = async () => {
      demand(!failure, "FRONTEND_CONTINUATION_SESSION_LOST");
      const same = (await client.query("select pg_backend_pid() as pid,current_user,current_database() as database,current_setting('default_transaction_read_only') as default_read_only")).rows[0];
      demand(same?.pid === identity.pid && same.current_user === target.user && same.database === target.database &&
        (!readOnlyExpected || same.default_read_only === "on"), "FRONTEND_CONTINUATION_SESSION_CHANGED");
      demand((await client.query(HELD_FRONTEND_LOCK, [FRONTEND_MIGRATION_LOCK])).rows[0]?.held === true,
        "FRONTEND_CONTINUATION_LOCK_LOST");
      demand(!failure, "FRONTEND_CONTINUATION_SESSION_LOST");
    };
    if (dependencies.beforeDatabasePreflight) {
      // The reviewed parent owns the environment lock. Its in-process hook
      // establishes bootstrap/fencing/drain while this runner retains the same
      // physical database connection and advisory lock. JSON/CLI inputs cannot
      // provide code or turn a leaf-component receipt into SQL authority.
      phase = "locked-parent-preflight";
      await verifySession();
      await dependencies.beforeDatabasePreflight({ client, verifySession, ...(profile ? { qualificationTargetProfile: profile } : {}) });
      await verifySession();
    }
    phase = "lineage-preflight";
    const present = (await client.query("select to_regclass('drizzle.__drizzle_migrations') is not null as present")).rows[0].present;
    const before = present ? await journal(client) : [];
    const latest = assertAppliedMigrationLineage(artifact.expected, before);
    const pending = artifact.migrations.filter((migration) => migration.folderMillis > latest);
    demand(isDeepStrictEqual(pending.map(({ tag }) => tag), target.approvedPendingTags), "FRONTEND_PENDING_CHAIN_MISMATCH");
    if (!before.length) {
      demand(target.allowEmptyBootstrap && (await client.query("select count(*)::int as count from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p','v','m','f')")).rows[0].count === 0, "FRONTEND_UNJOURNALED_DATABASE_REFUSED");
    }
    await verifyRuntime(client, target, false);
    phase = "forward-apply";
    if (pending.length) {
      await client.query("create schema if not exists drizzle");
      await client.query("create table if not exists drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    }
    for (const migration of pending) {
      await client.query("begin");
      try {
        for (const statement of migration.sql) await client.query(statement);
        await client.query("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]);
        await client.query("commit");
      } catch { await client.query("rollback"); throw new Error("FRONTEND_APPLY_FAILED_OUTCOME_REQUIRES_REVIEW"); }
    }
    phase = "postflight";
    await client.query("begin read only");
    try {
      const same = (await client.query("select pg_backend_pid() as pid,current_user,current_database() as database,current_setting('default_transaction_read_only') as default_read_only")).rows[0];
      demand(same.pid === identity.pid && same.current_user === target.user && same.database === target.database, "FRONTEND_SESSION_CHANGED");
      demand(!readOnlyExpected || same.default_read_only === "on", "FRONTEND_READ_ONLY_SESSION_CHANGED");
      const after = await journal(client);
      demand(assertAppliedMigrationLineage(artifact.expected, after) === artifact.migrations.at(-1).folderMillis, "FRONTEND_POST_LINEAGE_REFUSED");
      demand(isDeepStrictEqual(await readMigrationCatalog(client), baseline.catalog), "FRONTEND_SCHEMA_DRIFT");
      await verifyRuntime(client, target, true);
      demand(frontendMigrationArtifact().sqlArtifactSha256 === artifact.sqlArtifactSha256, "FRONTEND_SOURCE_CHANGED");
      databaseResult = { ...receiptBase, status: "DATABASE_VERIFIED", before, after, applied: pending.map(({ tag, hash }) => ({ tag, hash })),
        schemaVerified: true, runtimeRoleVerified: true, readOnlyVerified: readOnlyExpected && same.default_read_only === "on" };
    } finally { await client.query("rollback"); }
    phase = "database-receipt"; await dependencies.record("database-receipt.json", databaseResult);
    if (dependencies.afterDatabaseVerified) {
      // The parent still owns its environment flock. Retain this physical
      // database session and lock while it verifies/deploys compatible code.
      // This hook neither fences writers nor authorizes promotion/admission.
      // No CLI/JSON/environment input can supply an executable continuation.
      const frozen = (value) => {
        if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
        return value;
      };
      phase = "compatible-frontend-continuation";
      await verifySession();
      await dependencies.record("frontend-continuation-started.json", { ...receiptBase,
        status: "FRONTEND_CONTINUATION_STARTED", databaseVerified: true });
      await dependencies.afterDatabaseVerified(frozen(structuredClone(databaseResult)), verifySession);
      await verifySession();
      // A callback may take minutes. Recheck actual schema/lineage/grants;
      // do not qualify a stale pre-deployment database observation.
      phase = "post-continuation-verification";
      await client.query("begin read only");
      try {
        demand(isDeepStrictEqual(await journal(client), databaseResult.after), "FRONTEND_CONTINUATION_LINEAGE_CHANGED");
        demand(isDeepStrictEqual(await readMigrationCatalog(client), baseline.catalog), "FRONTEND_CONTINUATION_SCHEMA_CHANGED");
        await verifyRuntime(client, target, true);
        demand(frontendMigrationArtifact().sqlArtifactSha256 === artifact.sqlArtifactSha256, "FRONTEND_SOURCE_CHANGED");
      } finally { await client.query("rollback"); }
      await dependencies.record("frontend-continuation-completed.json", { ...receiptBase,
        status: "FRONTEND_CONTINUATION_COMPLETED", databaseVerified: true });
      if (dependencies.afterContinuationVerified) {
        // Deliberate restoration starts only after every core SQL/runtime and
        // compatible-continuation check above succeeded and was durably retained.
        // Retain the same physical advisory lock/client; no source or JSON input
        // can install an executor or infer opening authority from a receipt.
        phase = "post-continuation-finalization";
        await verifySession();
        await dependencies.record("frontend-finalization-started.json", { ...receiptBase, status: "FRONTEND_FINALIZATION_STARTED", databaseVerified: true });
        await dependencies.afterContinuationVerified({ database: frozen(structuredClone(databaseResult)), verifySession, ...(profile ? { qualificationTargetProfile: profile } : {}) });
        await verifySession();
        await dependencies.record("frontend-finalization-completed.json", { ...receiptBase, status: "FRONTEND_FINALIZATION_COMPLETED", databaseVerified: true });
      }
      phase = "completed";
    }
  } catch (error) { failure = error; }
  finally {
    try { if (locked) await client.query("select pg_advisory_unlock(hashtext($1))", [FRONTEND_MIGRATION_LOCK]); }
    catch { failure ??= new Error("FRONTEND_UNLOCK_UNVERIFIED"); }
    try { if (client) await client.end(); } catch { failure ??= new Error("FRONTEND_DISCONNECT_UNVERIFIED"); }
  }
  const outcome = { ...receiptBase, status: failure ? "FAILED_REQUIRES_REVIEW" : "DATABASE_VERIFIED", phase,
    readOnlyVerified: !failure && databaseResult?.readOnlyVerified === true,
    ...(failure ? { failureCode: "FRONTEND_MIGRATION_OR_CLEANUP_FAILED" } : {}) };
  await dependencies.record("job-outcome.json", outcome);
  if (failure) throw new Error("FRONTEND_MIGRATION_FAILED_REVIEW_REQUIRED");
  return outcome;
}

export async function frontendMigrationCli(argv, options = {}) {
  let receipts, profile;
  try {
    if (["--check-profiled-current", "--execute-profiled-current"].includes(argv[0])) {
      profile = STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE; resolveQualificationTargetProfile(profile);
    }
    demand(process.versions.node.split(".")[0] === "24", "NODE24_REQUIRED");
    const [mode, candidateFile, jobFile, schemaFile, flag, confirmation, output] = argv;
    if (mode === "--manifest-only") {
      demand(argv.length === 1, "ARGUMENTS_REFUSED"); const artifact = frontendMigrationArtifact();
      console.log(JSON.stringify({ ...artifact.manifest, sqlArtifactSha256: artifact.sqlArtifactSha256, contractManifestSha256: artifact.contractManifestSha256,
        ...(artifact.contractPhase === "p2" ? { contractPhase: "p2", phase2ContractManifestSha256: artifact.phase2ContractManifestSha256 } : {}) }));
    }
    else {
      const check = mode === "--check" || mode === "--check-profiled-current", execute = mode === "--execute" || mode === "--execute-profiled-current";
      demand((check && argv.length === 4) || (execute && argv.length === 7 && flag === "--confirm"), "ARGUMENTS_REFUSED");
      const prepared = prepareFrontendMigration(decodeQualificationTargetJson(read(candidateFile), "carrier"), decodeQualificationTargetJson(read(jobFile), "carrier"), decodeQualificationTargetJson(read(schemaFile), "carrier"), undefined, profile);
      demand(!profile || !execute || prepared.job.target.approvedPendingTags.length === 0, "IN_PROCESS_FRONTEND_CONTINUATION_REQUIRED");
      if (options.assertSource) options.assertSource(root, prepared.job.sourceCommit);
      if (check) console.log(JSON.stringify({ ...(profile ? { qualificationTargetProfile: profile } : {}), status: "FRONTEND_INPUTS_CHECKED", credentialsRead: false, migrationAuthorized: false, sqlArtifactSha256: prepared.artifact.sqlArtifactSha256 }));
      else {
        demand(confirmation === `${prepared.job.environment}/${prepared.job.releaseId}`, "EXPLICIT_OPERATOR_CONFIRMATION_REQUIRED");
        const info = lstatSync(resolve(output)); receipts = realpathSync(output);
        demand(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0, "PRIVATE_RECEIPT_DIRECTORY_REQUIRED");
        for (let path = receipts; ; path = dirname(path)) { demand(!existsSync(join(path, ".git")), "RECEIPTS_OUTSIDE_CHECKOUT_REQUIRED"); if (dirname(path) === path) break; }
        writeFrontendReceipt(receipts, "started.json", { releaseId: prepared.job.releaseId, environment: prepared.job.environment, ...(profile ? { qualificationTargetProfile: profile } : {}), trafficAuthorized: false });
        const stop = () => { try { writeFrontendReceipt(receipts, "job-outcome.json", { ...(profile ? { qualificationTargetProfile: profile } : {}), status: "FAILED_REQUIRES_REVIEW", failureCode: "INTERRUPTED_OR_DEADLINE", trafficAuthorized: false }); } finally { process.exit(124); } };
        const deadline = setTimeout(stop, 20 * 60_000);
        process.once("SIGTERM", stop); process.once("SIGINT", stop);
        try {
          await runFrontendMigration(prepared, { confirmation, ...(options.assertSource ? { assertSource: options.assertSource } : {}),
            getUrl: () => process.env[prepared.job.environment === "staging" ? "FRONTEND_STAGING_MIGRATION_DATABASE_URL" : "FRONTEND_PROD_MIGRATION_DATABASE_URL"],
            record: (name, value) => writeFrontendReceipt(receipts, name, value) }, profile);
          console.log(profile ? JSON.stringify({ qualificationTargetProfile: profile, status: "DATABASE_VERIFIED", trafficAuthorized: false }) : '{"status":"DATABASE_VERIFIED","trafficAuthorized":false}');
        } finally { clearTimeout(deadline); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
      }
    }
  } catch {
    console.error(profile ? JSON.stringify({ qualificationTargetProfile: profile, status: "FRONTEND_MIGRATION_REFUSED", reviewRequired: true, trafficAuthorized: false }) : '{"status":"FRONTEND_MIGRATION_REFUSED","reviewRequired":true,"trafficAuthorized":false}'); process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await frontendMigrationCli(process.argv.slice(2));
