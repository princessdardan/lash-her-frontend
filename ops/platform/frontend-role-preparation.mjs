// Staging role preparation only. No application SQL, admission or provider authority.
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, readFileSync, writeFileSync, fsyncSync, linkSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Client } from "pg";
import { frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";

export const FRONTEND_PREPARATION_ROLES = Object.freeze({ owner: "lash_her_frontend_staging_admission_owner_p2", runtime: "lash_her_frontend_staging_runtime_p2" });
const roleSpecification = {
  owner: { login: false, inherit: false, superuser: false, createdb: false, createrole: false, replication: false, bypassrls: false,
    database: ["CREATE"], persistentObjectOwnershipBeforeBootstrap: false, operatorSetRole: true },
  runtime: { login: true, inherit: false, superuser: false, createdb: false, createrole: false, replication: false, bypassrls: false,
    database: ["CONNECT"], publicSchema: ["USAGE"], publicTables: ["SELECT", "INSERT", "UPDATE", "DELETE"], publicSequences: ["USAGE", "SELECT"],
    futurePublicObjects: "same-table-and-sequence-grants-for-migration-operator", outboundMemberships: false, persistentDDL: false, journalAccess: false },
  inheritedPublicTemporaryPrivilege: "observe-without-changing", automaticCreatorAdminMembership: "operator-inbound-only-no-set-no-inherit",
};
const LOCK = "lash-her:private-db:migrations", plans = new WeakSet();
const refuse = () => new Error("FRONTEND_ROLE_PREPARATION_REFUSED");
const demand = (ok, checkpoint) => { if (!ok) { const error = refuse(); if (checkpoint) error.checkpoint = checkpoint; throw error; } };
const digest = (value, length = 64) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value) && !/^0+$/u.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const frontendRolesHash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest("hex");
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const identifier = name => { demand(typeof name === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(name)); return `"${name}"`; };
const oid = value => typeof value === "string" && /^[1-9][0-9]{0,9}$/u.test(value) && Number(value) <= 4294967295;
const flagNames = ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "rolinherit"];
const heldLock = `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
  AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
  AND classid=((hashtext($1)::bigint >> 32) & 4294967295)::oid AND objid=(hashtext($1)::bigint & 4294967295)::oid
  AND objsubid=1 AND mode='ExclusiveLock' AND granted) AS held`;

export function prepareFrontendRolesPlan(candidate, job, specification) {
  try {
    demand(candidate?.version === 2 && candidate.environment === "staging" && candidate.integration?.state === "passed" &&
      candidate.sourceApproval?.mode === "single-operator-dispatch" && candidate.sourceApproval.operatorGithubUserId === "8996309" &&
      candidate.sources?.frontend?.repository === "https://github.com/princessdardan/lash-her-frontend.git" && candidate.sources.frontend.requiredChecks === "passed" &&
      candidate.contractPhase === "p2" && /^sha256:[a-f0-9]{64}$/u.test(candidate.phase2ContractManifestSha256 ?? "") &&
      job?.version === 1 && job.operator === "Dardan" && job.environment === "staging" && job.releaseId === candidate.releaseId &&
      /^[a-z0-9][a-z0-9-]{0,63}$/u.test(job.releaseId ?? "") && digest(job.sourceCommit, 40) && job.sourceCommit === candidate.sources.frontend.commit &&
      job.contractPhase === "p2" && job.phase2ContractManifestSha256 === candidate.phase2ContractManifestSha256 &&
      job.contractManifestSha256 === candidate.contractManifestSha256 && /^sha256:[a-f0-9]{64}$/u.test(job.contractManifestSha256 ?? "") && digest(job.sqlArtifactSha256) &&
      candidate.frontendMigration?.sourceCommit === job.sourceCommit && candidate.frontendMigration.sqlArtifactSha256 === job.sqlArtifactSha256 &&
      candidate.frontendMigration.contractManifestSha256 === job.contractManifestSha256 && candidate.frontendMigration.contractPhase === "p2" &&
      candidate.frontendMigration.phase2ContractManifestSha256 === job.phase2ContractManifestSha256 &&
      candidate.artifacts?.frontendMigration?.image === `ghcr.io/princessdardan/lash-her-platform-frontend-migration@${job.migrationImageDigest}` && /^sha256:[a-f0-9]{64}$/u.test(job.migrationImageDigest ?? "") &&
      ![job.contractManifestSha256, job.phase2ContractManifestSha256, job.migrationImageDigest].some(value => /^sha256:0+$/u.test(value)) &&
      typeof job.recoveryRef === "string" && /^[A-Za-z0-9_./:-]{1,200}$/u.test(job.recoveryRef));
    const targetSha256 = frontendAdmissionTargetSha256("staging", job.target);
    demand(job.target.runtimeRole === FRONTEND_PREPARATION_ROLES.runtime && !Object.values(FRONTEND_PREPARATION_ROLES).includes(job.target.user) &&
      specification?.version === 1 && Array.isArray(specification.producerSha256) && specification.producerSha256.length > 0 && specification.producerSha256.length <= 256 &&
      specification.producerSha256.every(value => digest(value)) && new Set(specification.producerSha256).size === specification.producerSha256.length);
    let reuse;
    if (specification.reuse !== undefined) {
      demand(oid(specification.reuse.ownerOid) && oid(specification.reuse.runtimeOid) && specification.reuse.ownerOid !== specification.reuse.runtimeOid && digest(specification.reuse.proofSha256));
      reuse = Object.fromEntries(["ownerOid", "runtimeOid", "proofSha256"].map(key => [key, specification.reuse[key]]));
    }
    // Input documents are public reviewed artifacts; reject accidental secret-bearing material.
    const inspect = value => { if (!value || typeof value !== "object") return; for (const [key, child] of Object.entries(value)) { demand(!/password|credential|databaseurl|access.?token|private.?key/iu.test(key)); inspect(child); } };
    inspect(candidate); inspect(job);
    const base = { version: 1, environment: "staging", actionId: job.releaseId, sourceCommit: job.sourceCommit,
      candidateSha256: frontendRolesHash(candidate), jobSha256: frontendRolesHash(job), targetSha256,
      phase2ContractManifestSha256: job.phase2ContractManifestSha256, sqlArtifactSha256: job.sqlArtifactSha256, migrationImageDigest: job.migrationImageDigest,
      recoveryRef: job.recoveryRef, target: Object.fromEntries(["host", "port", "database", "user", "runtimeRole", "serverMajor"].map(key => [key, job.target[key]])),
      desiredRoles: { ...FRONTEND_PREPARATION_ROLES }, producerSha256: [...specification.producerSha256].sort(), ...(reuse ? { reuse } : {}),
      rolePolicy: "p2-staging-noinherit-public-crud-v1", roleSpecification, trafficAuthorized: false, migrationAuthorized: false };
    const plan = freeze({ ...base, planSha256: frontendRolesHash(base) }); plans.add(plan); return plan;
  } catch { throw refuse(); }
}

function privateDirectory(directory) {
  demand(typeof directory === "string" && resolve(directory) === directory && realpathSync(directory) === directory);
  const info = lstatSync(directory); demand(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
  for (let path = directory;; path = dirname(path)) { demand(!existsSync(join(path, ".git"))); if (path === dirname(path)) break; }
  return directory;
}
function retain(directory, name, value) {
  privateDirectory(directory); demand(/^[a-z0-9.-]+\.json$/u.test(name));
  const temporary = join(directory, `.${name}.${randomUUID()}`), destination = join(directory, name);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); linkSync(temporary, destination);
    const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { closeSync(fd); try { unlinkSync(temporary); } catch { /* Never remove an exclusive retained destination. */ } }
}
function readPrivate(directory, name) {
  privateDirectory(directory);
  const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const info = fstatSync(fd); demand(info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0 && info.size > 0 && info.size <= 1_000_000); return JSON.parse(readFileSync(fd, "utf8")); }
  finally { closeSync(fd); }
}
export function readFrontendRolesMigrationCredential(directory) {
  const value = readPrivate(directory, "migration-connection.json");
  demand(typeof value.databaseUrl === "string"); return value.databaseUrl;
}
function credentials(plan, password) {
  const url = new URL(`postgresql://${plan.target.host}:${plan.target.port}`); url.username = FRONTEND_PREPARATION_ROLES.runtime; url.password = password; url.pathname = `/${plan.target.database}`; url.searchParams.set("sslmode", "verify-full");
  return { version: 1, planSha256: plan.planSha256, targetSha256: plan.targetSha256, role: FRONTEND_PREPARATION_ROLES.runtime, password, runtimeDatabaseUrl: url.href };
}
// Transmit a SCRAM verifier rather than the plaintext password in role SQL.
// Both remain private; no exception/query text is copied to public receipts.
function scram(password) {
  const salt = randomBytes(16), salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const client = createHmac("sha256", salted).update("Client Key").digest();
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${createHash("sha256").update(client).digest("base64")}:${createHmac("sha256", salted).update("Server Key").digest("base64")}`;
}

async function observeRoles(client, plan) {
  const selected = Object.values(FRONTEND_PREPARATION_ROLES);
  const rows = (await client.query(`SELECT oid::text,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolconnlimit,rolvaliduntil,rolconfig
    FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`, [selected])).rows;
  demand(rows.length === 2 && rows.every(row => selected.includes(row.rolname) && oid(row.oid) && row.rolcanlogin === (row.rolname === FRONTEND_PREPARATION_ROLES.runtime) &&
    flagNames.every(key => row[key] === false) && row.rolconnlimit === -1 && row.rolvaliduntil === null && row.rolconfig === null), "attributes");
  const owner = rows.find(row => row.rolname === FRONTEND_PREPARATION_ROLES.owner), runtime = rows.find(row => row.rolname === FRONTEND_PREPARATION_ROLES.runtime);
  demand(owner.oid !== runtime.oid && (!plan.reuse || owner.oid === plan.reuse.ownerOid && runtime.oid === plan.reuse.runtimeOid));
  // rolconfig covers global settings only. Database-specific role settings
  // must also be absent for both selected roles, across the whole cluster.
  demand((await client.query(`SELECT 1 FROM pg_catalog.pg_db_role_setting
    WHERE setrole=ANY($1::oid[]) LIMIT 1`, [[owner.oid, runtime.oid]])).rows.length === 0, "database-role-settings");
  // Inspect effective access, including PUBLIC grants. A schema owned by
  // someone else can still shadow unqualified runtime queries via "$user".
  demand((await client.query(`SELECT 1 FROM pg_catalog.pg_namespace
    WHERE nspname !~ '^pg_' AND nspname NOT IN ('information_schema','public','frontend_admission')
      AND pg_catalog.has_schema_privilege($1::oid,oid,'USAGE') LIMIT 1`, [runtime.oid])).rows.length === 0, "runtime-schema-usage");
  const memberships = (await client.query(`SELECT m.roleid::text,m.member::text,m.grantor::text,m.admin_option,m.inherit_option,m.set_option,g.rolsuper AS grantor_super
    FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.grantor
    WHERE m.roleid=ANY($1::oid[]) OR m.member=ANY($1::oid[]) ORDER BY m.roleid,m.member,m.grantor`, [[owner.oid, runtime.oid]])).rows;
  const operator = (await client.query("SELECT session_user::regrole::oid::text AS oid,(SELECT rolsuper FROM pg_roles WHERE rolname=session_user) AS super")).rows[0];
  // PG16+ automatically grants non-superuser CREATEROLE creators ADMIN TRUE,
  // SET FALSE, INHERIT FALSE, as the bootstrap superuser. Only a superuser can
  // remove that row. It grants no membership/path to the created runtime.
  const creatorRows = memberships.filter(row => row.admin_option === true);
  const ownerSetRows = memberships.filter(row => row.admin_option === false);
  demand(memberships.length === (operator.super ? 1 : 3) && creatorRows.length === (operator.super ? 0 : 2) &&
    creatorRows.every(row => row.member === operator.oid && [owner.oid,runtime.oid].includes(row.roleid) && row.grantor_super === true && row.inherit_option === false && row.set_option === false) &&
    new Set(creatorRows.map(row => row.roleid)).size === creatorRows.length && ownerSetRows.length === 1 && ownerSetRows[0].roleid === owner.oid &&
    ownerSetRows[0].member === operator.oid && ownerSetRows[0].grantor === operator.oid && ownerSetRows[0].inherit_option === false && ownerSetRows[0].set_option === true, "memberships");
  demand((await client.query("SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=ANY($1::oid[]) AND deptype='o' LIMIT 1", [[owner.oid, runtime.oid]])).rows.length === 0, "ownership-or-extra-dependency");
  const privileges = [];
  for (const role of [owner, runtime]) {
    const isRuntime = role.oid === runtime.oid;
    const row = (await client.query(`SELECT has_database_privilege($1::name,current_database(),'CONNECT') AS connect,
      has_database_privilege($1::name,current_database(),'CREATE') AS database_create,has_database_privilege($1::name,current_database(),'TEMP') AS temporary,
      has_schema_privilege($1::name,'public','USAGE') AS public_usage,
      EXISTS(SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' AND has_schema_privilege($1::name,oid,'CREATE')) AS schema_create,
      EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='drizzle' AND has_schema_privilege($1::name,oid,'USAGE')) AS journal_usage,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='drizzle' AND c.relkind IN ('r','p','v','m','f','S') AND
        CASE WHEN c.relkind='S' THEN has_sequence_privilege($1::name,c.oid,'SELECT,USAGE,UPDATE') ELSE has_table_privilege($1::name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END) AS journal_objects`, [role.rolname])).rows[0];
    demand(row && row.database_create === !isRuntime && row.schema_create === false && row.journal_usage === false && row.journal_objects === false && (!isRuntime || row.connect === true && row.public_usage === true), "effective-privileges");
    const tables = (await client.query(`SELECT c.oid::text,c.relname,p AS privilege,has_table_privilege($1::name,c.oid,p) AS allowed,
      has_table_privilege($1::name,c.oid,p||' WITH GRANT OPTION') AS grantable FROM pg_class c
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f') ORDER BY c.oid,p`, [role.rolname])).rows;
    demand(tables.every(entry => entry.allowed === (isRuntime && ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(entry.privilege)) && entry.grantable === false), "table-or-sequence-privileges");
    const sequences = (await client.query(`SELECT c.oid::text,c.relname,p AS privilege,has_sequence_privilege($1::name,c.oid,p) AS allowed,
      has_sequence_privilege($1::name,c.oid,p||' WITH GRANT OPTION') AS grantable FROM pg_class c CROSS JOIN unnest(ARRAY['SELECT','USAGE','UPDATE']) p
      WHERE c.relnamespace='public'::regnamespace AND c.relkind='S' ORDER BY c.oid,p`, [role.rolname])).rows;
    demand(sequences.every(entry => entry.allowed === (isRuntime && entry.privilege !== 'UPDATE') && entry.grantable === false), "table-or-sequence-privileges");
    const defaults = (await client.query(`SELECT d.defaclobjtype AS kind,a.privilege_type AS privilege,a.is_grantable FROM pg_default_acl d
      CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclrole=session_user::regrole AND d.defaclnamespace='public'::regnamespace
      AND a.grantee=$1::oid ORDER BY kind,privilege`, [role.oid])).rows;
    const expected = isRuntime ? ['r:DELETE','r:INSERT','r:SELECT','r:UPDATE','S:SELECT','S:USAGE'].sort() : [];
    demand(JSON.stringify(defaults.map(entry => `${entry.kind}:${entry.privilege}`).sort()) === JSON.stringify(expected) && defaults.every(entry => entry.is_grantable === false), "defaults");
    // No direct grant outside the fixed database/public/default scope, including grant options.
    const extra = (await client.query(`SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1::oid AND deptype IN ('a','i') AND dbid<>0
      AND dbid<>(SELECT oid FROM pg_database WHERE datname=current_database()) LIMIT 1`, [role.oid])).rows;
    demand(extra.length === 0, "other-database-grants");
    privileges.push({ role: { name: role.rolname, oid: role.oid }, effective: row, tables, sequences, defaults });
  }
  const directAcl = (await client.query(`WITH entries AS (
    SELECT 'database' AS kind,d.oid::text AS object_oid,d.datname AS schema_name,NULL::text AS creator,a.* FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a
    UNION ALL SELECT 'schema',n.oid::text,n.nspname,NULL::text,a.* FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
    UNION ALL SELECT CASE WHEN c.relkind='S' THEN 'sequence' ELSE 'table' END,c.oid::text,n.nspname,NULL::text,a.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
    UNION ALL SELECT 'column',c.oid::text,n.nspname,NULL::text,a.* FROM pg_attribute t JOIN pg_class c ON c.oid=t.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(t.attacl) a
    UNION ALL SELECT 'function',p.oid::text,n.nspname,NULL::text,a.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a
    UNION ALL SELECT 'type',t.oid::text,n.nspname,NULL::text,a.* FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace CROSS JOIN LATERAL aclexplode(t.typacl) a
    UNION ALL SELECT 'default-'::text||d.defaclobjtype::text,d.oid::text,n.nspname,d.defaclrole::regrole::text,a.* FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  ) SELECT kind,object_oid,schema_name,creator,grantee::text,privilege_type,is_grantable FROM entries WHERE grantee=ANY($1::oid[]) ORDER BY kind,object_oid,grantee,privilege_type`, [[owner.oid, runtime.oid]])).rows;
  demand(directAcl.every(entry => !entry.is_grantable && (entry.grantee === owner.oid ?
    entry.kind === 'database' && entry.schema_name === plan.target.database && entry.privilege_type === 'CREATE' :
    entry.kind === 'database' ? entry.schema_name === plan.target.database && entry.privilege_type === 'CONNECT' :
      entry.schema_name === 'public' && (entry.kind === 'schema' ? entry.privilege_type === 'USAGE' :
        entry.kind === 'table' || entry.kind === 'default-r' ? ['SELECT','INSERT','UPDATE','DELETE'].includes(entry.privilege_type) && (entry.kind === 'table' || entry.creator === plan.target.user) :
          (entry.kind === 'sequence' || entry.kind === 'default-S') && ['SELECT','USAGE'].includes(entry.privilege_type) && (entry.kind === 'sequence' || entry.creator === plan.target.user)))), "direct-acl");
  // Catch ACL dependencies on object classes not included in the allowed grant inventory.
  demand((await client.query(`SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=ANY($1::oid[]) AND deptype IN ('a','i')
    AND classid NOT IN ('pg_database'::regclass,'pg_namespace'::regclass,'pg_class'::regclass,'pg_default_acl'::regclass) LIMIT 1`, [[owner.oid, runtime.oid]])).rows.length === 0, "ownership-or-extra-dependency");
  return { owner: { name: owner.rolname, oid: owner.oid }, runtime: { name: runtime.rolname, oid: runtime.oid }, attributes: rows, memberships, privileges, directAcl };
}

export async function applyPreparedFrontendRoles(plan, client, dependencies) {
  demand(plans.has(plan) && dependencies?.confirmation === `staging/${plan.actionId}` && typeof dependencies.verifyEnvironment === "function" && typeof dependencies.verifySession === "function");
  const { directory, privateDirectory: privatePath } = dependencies;
  privateDirectory(directory); privateDirectory(privatePath); demand(directory !== privatePath);
  demand(!existsSync(join(directory, "roles-preparation-started.json")) && !existsSync(join(directory, "roles-preparation-outcome.json")) && !existsSync(join(privatePath, "frontend-role-credentials.json")));
  let phase = "locked-target-preflight", started = false, transaction = false, commitAttempted = false, committed = false, rollbackAcknowledged = false, roleSqlAttempted = false, physicalPid;
  const base = { ...plan, admissionChanged: false, featuresEnabled: false, providerTouched: false };
  const verify = async () => {
    await dependencies.verifyEnvironment(); await dependencies.verifySession();
    demand(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true &&
      client.connectionParameters?.host === plan.target.host && Number(client.connectionParameters.port) === plan.target.port);
    const row = (await client.query("SELECT pg_backend_pid() AS pid,current_user AS username,session_user AS session_username,current_database() AS database,current_setting('server_version_num')::int/10000 AS major,current_setting('transaction_read_only') AS read_only")).rows[0];
    demand(row && Number.isInteger(row.pid) && (physicalPid === undefined || row.pid === physicalPid) && row.username === plan.target.user && row.session_username === plan.target.user && row.database === plan.target.database && row.major === plan.target.serverMajor && row.read_only === "off" &&
      (await client.query(heldLock, [LOCK])).rows[0]?.held === true);
    physicalPid ??= row.pid;
    return row;
  };
  try {
    const identity = await verify();
    const existing = (await client.query("SELECT oid::text,rolname FROM pg_roles WHERE rolname=ANY($1::text[])", [Object.values(FRONTEND_PREPARATION_ROLES)])).rows;
    demand(plan.reuse ? existing.length === 2 : existing.length === 0);
    let privateRecord;
    if (plan.reuse) {
      const previous = readPrivate(dependencies.reuseDirectory, "roles-preparation-outcome.json");
      const { proofSha256: previousSha256, ...previousProof } = previous;
      demand(previous.status === "FRONTEND_ROLES_PREPARED" && previousSha256 === frontendRolesHash(previousProof) && previousSha256 === plan.reuse.proofSha256 && previous.targetSha256 === plan.targetSha256 &&
        previous.owner?.name === FRONTEND_PREPARATION_ROLES.owner && previous.owner.oid === plan.reuse.ownerOid && previous.runtime?.name === FRONTEND_PREPARATION_ROLES.runtime && previous.runtime.oid === plan.reuse.runtimeOid);
      const priorPrivate = readPrivate(dependencies.reusePrivateDirectory, "frontend-role-credentials.json");
      demand(priorPrivate.targetSha256 === plan.targetSha256 && priorPrivate.role === FRONTEND_PREPARATION_ROLES.runtime && typeof priorPrivate.password === "string" && priorPrivate.password.length >= 64);
      privateRecord = credentials(plan, priorPrivate.password);
      demand(priorPrivate.runtimeDatabaseUrl === privateRecord.runtimeDatabaseUrl);
      await observeRoles(client, plan);
    } else privateRecord = credentials(plan, randomBytes(48).toString("base64url"));
    phase = "retain-private-credential-before-sql"; retain(privatePath, "frontend-role-credentials.json", privateRecord);
    demand(readPrivate(privatePath, "frontend-role-credentials.json").runtimeDatabaseUrl === privateRecord.runtimeDatabaseUrl);
    phase = "durable-intent"; retain(directory, "roles-preparation-started.json", { ...base, status: "FRONTEND_ROLE_PREPARATION_STARTED", physicalSessionPid: identity.pid }); started = true;
    await verify();
    demand(readPrivate(privatePath, "frontend-role-credentials.json").runtimeDatabaseUrl === privateRecord.runtimeDatabaseUrl);
    phase = "role-transaction"; await client.query("BEGIN"); transaction = true;
    let observed;
    try {
      await verify();
      await client.query("SET LOCAL createrole_self_grant = ''");
      if (!plan.reuse) {
        const owner = identifier(FRONTEND_PREPARATION_ROLES.owner), runtime = identifier(FRONTEND_PREPARATION_ROLES.runtime), operator = identifier(plan.target.user), database = identifier(plan.target.database);
        const flags = "NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";
        roleSqlAttempted = true; await client.query(`CREATE ROLE ${owner} NOLOGIN ${flags}`);
        await client.query(`CREATE ROLE ${runtime} LOGIN ${flags} PASSWORD '${scram(privateRecord.password)}'`);
        await client.query(`GRANT CREATE ON DATABASE ${database} TO ${owner}`);
        await client.query(`GRANT ${owner} TO ${operator} WITH INHERIT FALSE`);
        await client.query(`GRANT ${owner} TO ${operator} WITH SET TRUE`);
        await client.query(`GRANT ${owner} TO ${operator} WITH ADMIN FALSE`);
        await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${runtime}`);
        await client.query(`GRANT USAGE ON SCHEMA public TO ${runtime}`);
        await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${runtime}`);
        await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtime}`);
        await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${runtime}`);
        await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ${runtime}`);
      }
      phase = "role-grant-verification"; observed = await observeRoles(client, plan); await verify();
      retain(directory, "roles-precommit-observed.json", { ...base, status: "FRONTEND_ROLES_OBSERVED_UNCOMMITTED", observed });
      demand(readPrivate(privatePath, "frontend-role-credentials.json").runtimeDatabaseUrl === privateRecord.runtimeDatabaseUrl);
      phase = "commit"; commitAttempted = true; await client.query("COMMIT"); committed = true; transaction = false;
    } catch (error) {
      if (!commitAttempted) { try { await client.query("ROLLBACK"); rollbackAcknowledged = true; transaction = false; } catch { /* Unknown state retained. */ } }
      throw error;
    }
    phase = "postflight"; await verify(); observed = await observeRoles(client, plan);
    const runtimeClient = new Client({ host: plan.target.host, port: plan.target.port, database: plan.target.database, user: observed.runtime.name,
      password: privateRecord.password, ssl: client.connectionParameters.ssl, enableChannelBinding: true, connectionTimeoutMillis: 15_000 });
    runtimeClient.on("error", () => {});
    try {
      await runtimeClient.connect(); demand(runtimeClient.connection?.stream?.encrypted === true && runtimeClient.connection.stream.authorized === true);
      const actual = (await runtimeClient.query("SELECT current_user AS username,session_user AS session_username,current_user::regrole::oid::text AS oid,current_database() AS database")).rows[0];
      demand(actual.username === observed.runtime.name && actual.session_username === observed.runtime.name && actual.oid === observed.runtime.oid && actual.database === plan.target.database);
    } finally { await runtimeClient.end(); }
    await verify();
    const proof = { ...base, status: "FRONTEND_ROLES_PREPARED", owner: observed.owner, runtime: observed.runtime, observed,
      producers: plan.producerSha256.map(producerSha256 => ({ producerSha256, sourceCommit: plan.sourceCommit, role: observed.runtime })), committed: true, runtimeCredentialVerified: true };
    const result = freeze({ ...proof, proofSha256: frontendRolesHash(proof) });
    retain(directory, "roles-preparation-outcome.json", result);
    // Safe by default when passed to JSON receipts/logs. Private access is explicit and in-process.
    const returned = { ...result }; Object.defineProperty(returned, "private", { enumerable: false, value: Object.freeze({ runtimeDatabaseUrl: privateRecord.runtimeDatabaseUrl, credentialReceiptRef: join(privatePath, "frontend-role-credentials.json") }) });
    return Object.freeze(returned);
  } catch (error) {
    if (transaction && !commitAttempted) { try { await client.query("ROLLBACK"); rollbackAcknowledged = true; } catch { /* No replay. */ } }
    if (started) { try { retain(directory, "roles-preparation-outcome.json", { ...base, status: "FAILED_REQUIRES_REVIEW", phase,
      ...(["attributes","database-role-settings","runtime-schema-usage","memberships","ownership-or-extra-dependency","effective-privileges","table-or-sequence-privileges","defaults","other-database-grants","direct-acl"].includes(error?.checkpoint) ? {checkpoint:error.checkpoint} : {}),
      ...(typeof error?.code === "string" && /^[A-Z0-9]{5}$/u.test(error.code) ? { sqlState: error.code } : {}),
      sqlOutcome: committed ? "committed" : commitAttempted ? "commit-acknowledgment-unknown" : rollbackAcknowledged ? "rolled-back" : roleSqlAttempted ? "not-committed-or-unknown" : "not-started",
      roleSqlAttempted, automaticReplayAllowed: false }); } catch { /* Exclusive original intent/private evidence remains authoritative. */ } }
    throw new Error("FRONTEND_ROLE_PREPARATION_FAILED_REVIEW_REQUIRED");
  }
}
