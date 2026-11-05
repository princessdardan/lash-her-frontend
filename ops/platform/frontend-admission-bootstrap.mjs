// Reviewed in-process component only. No startup hook, CLI or ambient credentials.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const demand = ok => { if (!ok) throw new Error("FRONTEND_ADMISSION_BOOTSTRAP_REFUSED"); };
const digest = (value, size = 64) => typeof value === "string" && new RegExp(`^[a-f0-9]{${size}}$`, "u").test(value) && !/^0+$/u.test(value);
const name = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(value);
const oid = value => typeof value === "string" && /^[1-9][0-9]{0,9}$/u.test(value) && Number(value) <= 4294967295;
const hash = value => createHash("sha256").update(value).digest("hex");
const artifact = () => readFileSync(new URL("./frontend-admission.sql", import.meta.url), "utf8");

export function frontendAdmissionBootstrapArtifact() { return { sqlSha256: hash(artifact()) }; }

export function frontendAdmissionTargetSha256(environment, target) {
  demand(environment === "staging" && typeof target?.host === "string" && /^[a-z0-9.-]+$/u.test(target.host) &&
    !/pooler|pgbouncer/u.test(target.host) && name(target.database) && name(target.user) &&
    Number.isInteger(target.port) && target.port > 0 && target.port < 65536 && [16, 18].includes(target.serverMajor));
  return hash(JSON.stringify({ environment, host: target.host, port: target.port, database: target.database, user: target.user, serverMajor: target.serverMajor }));
}

export function prepareFrontendAdmissionBootstrap(input) {
  demand(input?.version === 1 && input.environment === "staging" && typeof input.actionId === "string" &&
    /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.actionId) && digest(input.sourceCommit, 40) &&
    input.sqlSha256 === frontendAdmissionBootstrapArtifact().sqlSha256 && digest(input.inventorySha256));
  const target = input.target;
  demand(input.targetSha256 === frontendAdmissionTargetSha256(input.environment, target) &&
    name(input.owner?.name) && oid(input.owner.oid) && input.owner.name !== target.user &&
    Array.isArray(input.producers) && input.producers.length > 0 && input.producers.length <= 256 &&
    input.producers.every(p => digest(p?.producerSha256) && p.sourceCommit === input.sourceCommit &&
      name(p.role?.name) && oid(p.role.oid) && ![target.user, input.owner.name].includes(p.role.name)) &&
    new Set(input.producers.map(p => p.producerSha256)).size === input.producers.length);
  const roleOids = new Map(), roleNames = new Map();
  for (const producer of input.producers) {
    demand(!roleOids.has(producer.role.oid) || roleOids.get(producer.role.oid) === producer.role.name);
    demand(!roleNames.has(producer.role.name) || roleNames.get(producer.role.name) === producer.role.oid);
    roleOids.set(producer.role.oid, producer.role.name); roleNames.set(producer.role.name, producer.role.oid);
  }
  demand(!roleOids.has(input.owner.oid));
  return { version: 1, environment: input.environment, actionId: input.actionId, sourceCommit: input.sourceCommit,
    sqlSha256: input.sqlSha256, inventorySha256: input.inventorySha256, targetSha256: input.targetSha256,
    target: Object.fromEntries(["host", "port", "database", "user", "serverMajor"].map(key => [key, target[key]])),
    owner: { name: input.owner.name, oid: input.owner.oid },
    producers: input.producers.map(p => ({ producerSha256: p.producerSha256, sourceCommit: p.sourceCommit,
      role: { name: p.role.name, oid: p.role.oid } })).sort((a, b) => a.producerSha256.localeCompare(b.producerSha256)) };
}

export async function bootstrapFrontendAdmission(input, client, dependencies) {
  const plan = prepareFrontendAdmissionBootstrap(input);
  demand(dependencies?.confirmation === `staging/${plan.actionId}` && typeof dependencies.record === "function" && typeof dependencies.verifySession === "function");
  const base = { ...plan, trafficAuthorized: false, migrationAuthorized: false };
  let phase = "durable-intent", started = false;
  const verify = async () => {
    await dependencies.verifySession();
    demand(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true &&
      client.connectionParameters?.host === plan.target.host && Number(client.connectionParameters.port) === plan.target.port);
    const actual = (await client.query("SELECT current_user AS username,session_user AS session_username,current_database() AS database,current_setting('server_version_num')::int/10000 AS major,current_setting('transaction_read_only') AS read_only")).rows[0];
    demand(actual?.username === plan.target.user && actual.session_username === plan.target.user && actual.database === plan.target.database && actual.major === plan.target.serverMajor && actual.read_only === "off");
  };
  const roles = [...new Map(plan.producers.map(p => [p.role.name, p.role])).values()];
  const checkRoles = async () => {
    const selected = [plan.owner, ...roles];
    const actual = (await client.query(`SELECT oid::text,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit
      FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`, [selected.map(role => role.name)])).rows;
    demand(actual.length === selected.length && actual.every(row => selected.some(role => role.name === row.rolname && role.oid === row.oid) &&
      row.rolcanlogin === (row.rolname !== plan.owner.name) &&
      ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "rolinherit"].every(key => row[key] === false)));
    // The migration operator may SET ROLE to the owner. Runtime must not own
    // this schema or gain a role path to the owner/operator.
    demand((await client.query(`SELECT 1 FROM pg_auth_members WHERE member=$1::oid OR
      (roleid=$1::oid AND member <> session_user::regrole::oid) LIMIT 1`, [plan.owner.oid])).rows.length === 0);
    for (const role of roles) {
      const privileges = (await client.query(`SELECT pg_has_role($1,$2,'MEMBER') AS owner_member,
        pg_has_role($1,session_user,'MEMBER') AS operator_member,
        has_database_privilege($1,current_database(),'CREATE') AS database_create,
        has_schema_privilege($1,'public','CREATE') AS public_create`, [role.name, plan.owner.name])).rows;
      demand(privileges.length === 1 && privileges[0].owner_member === false && privileges[0].operator_member === false &&
        privileges[0].database_create === false && privileges[0].public_create === false);
    }
  };
  try {
    await dependencies.record("admission-bootstrap-started.json", { ...base, status: "FRONTEND_ADMISSION_BOOTSTRAP_STARTED" }); started = true;
    phase = "locked-target-preflight"; await verify(); await checkRoles();
    demand((await client.query("SELECT to_regnamespace('frontend_admission') IS NOT NULL AS present")).rows[0]?.present === false);
    phase = "install-closed-ledger";
    await client.query("BEGIN");
    try {
      await verify(); await checkRoles();
      const sql = artifact(); demand(hash(sql) === plan.sqlSha256);
      await client.query(`SET LOCAL ROLE "${plan.owner.name}"`);
      await client.query(sql);
      await client.query("INSERT INTO frontend_admission.control(environment,target_sha256) VALUES($1,$2)", [plan.environment, plan.targetSha256]);
      for (const producer of plan.producers) {
        await client.query("INSERT INTO frontend_admission.producers(producer_sha256,source_sha,database_role,enabled) VALUES($1,$2,$3::oid,true)",
          [producer.producerSha256, producer.sourceCommit, producer.role.oid]);
      }
      for (const role of roles) {
        // Revoke defaults a bootstrap owner may have inherited. Explicitly
        // remove CREATE and all direct table/sequence access before granting
        // the protocol's USAGE/EXECUTE privileges.
        await client.query(`REVOKE ALL ON SCHEMA frontend_admission FROM "${role.name}"`);
        await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA frontend_admission FROM "${role.name}"`);
        await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA frontend_admission FROM "${role.name}"`);
        await client.query(`GRANT USAGE ON SCHEMA frontend_admission TO "${role.name}"`);
        await client.query(`GRANT EXECUTE ON ALL ROUTINES IN SCHEMA frontend_admission TO "${role.name}"`);
      }
      await client.query("COMMIT");
    } catch { try { await client.query("ROLLBACK"); } catch { /* observe actual state in a new action */ } throw new Error("BOOTSTRAP_OUTCOME_UNVERIFIED"); }
    phase = "closed-ledger-postflight"; await verify();
    await client.query("BEGIN READ ONLY");
    try {
    await client.query(`SET LOCAL ROLE "${plan.owner.name}"`);
    demand((await client.query("SELECT nspowner::text AS owner_oid FROM pg_namespace WHERE nspname='frontend_admission'")).rows[0]?.owner_oid === plan.owner.oid);
    const rows = (await client.query("SELECT environment,target_sha256,epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton")).rows;
    demand(rows.length === 1 && rows[0].environment === plan.environment && rows[0].target_sha256 === plan.targetSha256 &&
      rows[0].epoch === "1" && rows[0].new_work === false && rows[0].recovery === false);
    demand((await client.query("SELECT count(*)::int AS count FROM frontend_admission.operations")).rows[0]?.count === 0);
    const registered = (await client.query("SELECT producer_sha256,source_sha,database_role::text AS role_oid,enabled FROM frontend_admission.producers ORDER BY producer_sha256")).rows;
    demand(registered.length === plan.producers.length && registered.every((row, i) => row.producer_sha256 === plan.producers[i].producerSha256 &&
      row.source_sha === plan.sourceCommit && row.role_oid === plan.producers[i].role.oid && row.enabled === true));
    for (const role of roles) {
      const privileges = (await client.query(`SELECT has_schema_privilege($1,'frontend_admission','USAGE') AS usage,
        has_schema_privilege($1,'frontend_admission','CREATE') AS ddl,
        EXISTS(SELECT 1 FROM pg_class c CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
          WHERE c.relnamespace='frontend_admission'::regnamespace AND c.relkind='r' AND has_table_privilege($1,c.oid,p)) AS tables,
        EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='frontend_admission'::regnamespace AND NOT has_function_privilege($1,p.oid,'EXECUTE')) AS missing_execute`, [role.name])).rows[0];
      demand(privileges?.usage === true && privileges.ddl === false && privileges.tables === false && privileges.missing_execute === false);
    }
    } finally { await client.query("ROLLBACK"); }
    await dependencies.verifySession();
    const result = { ...base, status: "FRONTEND_ADMISSION_BOOTSTRAPPED_CLOSED", epoch: "1", newWork: false, recovery: false };
    await dependencies.record("admission-bootstrap-outcome.json", result); return result;
  } catch {
    try { if (started) await dependencies.record("admission-bootstrap-outcome.json", { ...base, status: "FAILED_REQUIRES_REVIEW", phase }); } catch { /* retain originals */ }
    throw new Error("FRONTEND_ADMISSION_BOOTSTRAP_FAILED_REVIEW_REQUIRED");
  }
}
