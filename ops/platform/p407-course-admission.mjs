import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";

export const P407_ADMISSION_OWNER = "lash_her_p407_admission_owner";
export const P407_ADMISSION_RUNTIME = "lash_her_p407_frontend_runtime";
export const P407_ADMISSION_TARGET = Object.freeze({
  host: "p4-07-db.lashher.com",
  database: "lash_her_p407_frontend",
  user: "lash_her_p407_frontend_migration",
  port: 5432,
  serverMajor: 18,
});
const environment = "staging";
const targetSha256 = frontendAdmissionTargetSha256(environment, P407_ADMISSION_TARGET);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maxWindowMs = 15 * 60_000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const demand = (condition) => {
  if (!condition) throw new Error("P407_ADMISSION_OPERATOR_REFUSED");
};
const load = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

export function planP407CourseAdmission(review) {
  demand(review && /^[0-9a-f]{40}$/u.test(review.sourceCommit) && !/^0+$/u.test(review.sourceCommit) &&
    uuid.test(review.orderId) && uuid.test(review.customerId) && uuid.test(review.courseId) &&
    typeof review.expiresAt === "string" && Number.isFinite(Date.parse(review.expiresAt)) &&
    new Date(review.expiresAt).toISOString() === review.expiresAt);
  const producer = hash(JSON.stringify({
    targetSha256,
    sourceCommit: review.sourceCommit,
    orderId: review.orderId,
    customerId: review.customerId,
    courseId: review.courseId,
    expiresAt: review.expiresAt,
  }));
  return {
    ...Object.fromEntries(["sourceCommit", "orderId", "customerId", "courseId", "expiresAt"].map((key) => [key, review[key]])),
    producer,
    target: { ...P407_ADMISSION_TARGET, environment, targetSha256 },
    writerAdmissionTarget: { ...P407_ADMISSION_TARGET, user: P407_ADMISSION_RUNTIME, environment, targetSha256 },
    scopeSqlSha256: hash(load("./p407-course-admission.sql")),
  };
}

async function verifyOperator(client) {
  const stream = client.connection?.stream;
  const params = client.connectionParameters;
  demand(stream?.encrypted === true && stream.authorized === true &&
    params?.host === P407_ADMISSION_TARGET.host && Number(params?.port) === P407_ADMISSION_TARGET.port);
  const { rows: [row] } = await client.query(`SELECT current_database() AS database, current_user AS "user",
    session_user AS "sessionUser", current_setting('server_version_num')::int/10000 AS major,
    current_setting('transaction_read_only') = 'off' AS writable,
    (SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)
       FROM pg_roles WHERE rolname=session_user) AS restricted`);
  demand(row?.database === P407_ADMISSION_TARGET.database && row.user === P407_ADMISSION_TARGET.user &&
    row.sessionUser === row.user && row.major === P407_ADMISSION_TARGET.serverMajor && row.writable && row.restricted);
}

async function withAdmissionOwner(client, operation) {
  await verifyOperator(client);
  await client.query("BEGIN");
  try {
    await verifyOperator(client);
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const { rows } = await client.query(`SELECT
      r.rolname, oid::text, r.rolcanlogin AS login,
      NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit) AS restricted
      FROM pg_roles r WHERE rolname = ANY($1::text[])`, [[P407_ADMISSION_OWNER, P407_ADMISSION_RUNTIME]]);
    const owner = rows.find((row) => row.rolname === P407_ADMISSION_OWNER);
    const runtime = rows.find((row) => row.rolname === P407_ADMISSION_RUNTIME);
    demand(rows.length === 2 && owner?.restricted === true && !owner.login && runtime?.restricted === true && runtime.login);
    const { rows: [privileges] } = await client.query(`SELECT
      NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=$1::oid
        OR (roleid=$1::oid AND member<>session_user::regrole::oid)) AS owner_isolated,
      NOT pg_has_role($2, session_user, 'MEMBER') AS migration_isolated,
      NOT has_database_privilege($2, current_database(), 'CREATE') AS runtime_no_create,
      NOT has_schema_privilege($2, 'public', 'CREATE') AS runtime_no_ddl`, [owner.oid, runtime.rolname]);
    demand(privileges?.owner_isolated && privileges.migration_isolated && privileges.runtime_no_create && privileges.runtime_no_ddl);
    await client.query(`SET LOCAL ROLE ${P407_ADMISSION_OWNER}`);
    const result = await operation(runtime.oid);
    await client.query("COMMIT");
    return result;
  } catch {
    try { await client.query("ROLLBACK"); } catch { /* The operator must inspect state after an uncertain outcome. */ }
    throw new Error("P407_ADMISSION_OPERATION_REQUIRES_REVIEW");
  }
}

async function readOrders(client, plan) {
  // Only the migration login can read application tables. The ledger owner
  // sees them through this locked operator transaction, with no standing grant.
  await client.query("RESET ROLE");
  const { rows: [order] } = await client.query(`SELECT count(*)::int AS count,
    count(*) FILTER (WHERE id=$1 AND customer_id=$2 AND course_id=$3)::int AS selected
    FROM public.course_purchase_orders`, [plan.orderId, plan.customerId, plan.courseId]);
  await client.query(`SET LOCAL ROLE ${P407_ADMISSION_OWNER}`);
  return order;
}

async function readState(client, plan, runtimeOid, lock = false) {
  const { rows: controls } = await client.query(`SELECT environment,target_sha256,epoch::text,new_work,recovery
    FROM frontend_admission.control WHERE singleton${lock ? " FOR UPDATE NOWAIT" : ""}`);
  const { rows: [window] } = await client.query("SELECT order_id,phase,expires_at FROM frontend_admission.p407_window WHERE singleton");
  const { rows: producers } = await client.query("SELECT producer_sha256,source_sha,database_role::text,enabled FROM frontend_admission.producers");
  const { rows: [operations] } = await client.query(`SELECT count(*) FILTER (WHERE state='active')::int AS active,
    count(*) FILTER (WHERE state='uncertain')::int AS uncertain FROM frontend_admission.operations`);
  const control = controls[0];
  const producer = producers[0];
  demand(controls.length === 1 && control.environment === environment && control.target_sha256 === targetSha256 &&
    producers.length === 1 && producer.producer_sha256 === plan.producer && producer.source_sha === plan.sourceCommit &&
    producer.database_role === runtimeOid && window?.order_id === plan.orderId &&
    control.new_work === (window.phase === "checkout") && control.recovery === (window.phase === "recovery") &&
    producer.enabled === (control.new_work || control.recovery));
  return {
    epoch: control.epoch,
    phase: window.phase,
    expiresAt: window.expires_at?.toISOString() ?? null,
    newWork: control.new_work,
    recovery: control.recovery,
    ...operations,
  };
}

export async function bootstrapP407CourseAdmission(client, review) {
  const plan = planP407CourseAdmission(review);
  return withAdmissionOwner(client, async (runtimeOid) => {
    const { rows: [state] } = await client.query("SELECT to_regnamespace('frontend_admission') IS NULL AS absent");
    demand(state?.absent && (await readOrders(client, plan)).count === 0);
    await client.query(load("./frontend-admission.sql"));
    const scopeSql = load("./p407-course-admission.sql");
    demand(hash(scopeSql) === plan.scopeSqlSha256);
    await client.query(scopeSql);
    await client.query("INSERT INTO frontend_admission.control(environment,target_sha256) VALUES($1,$2)", [environment, targetSha256]);
    await client.query("INSERT INTO frontend_admission.producers(producer_sha256,source_sha,database_role) VALUES($1,$2,$3::oid)",
      [plan.producer, plan.sourceCommit, runtimeOid]);
    await client.query("INSERT INTO frontend_admission.p407_window(order_id,phase) VALUES($1,'held')", [plan.orderId]);
    await client.query(`GRANT USAGE ON SCHEMA frontend_admission TO ${P407_ADMISSION_RUNTIME};
      GRANT EXECUTE ON ROUTINE
        frontend_admission.current_policy(text,text,text,text),
        frontend_admission.admit_p407(uuid,text,text,text,bigint,text,text,uuid),
        frontend_admission.begin_p407_operation(uuid,text,text,text,bigint,text,text,uuid),
        frontend_admission.finish_operation(uuid,text),
        frontend_admission.settle(uuid,text) TO ${P407_ADMISSION_RUNTIME}`);
    return readState(client, plan, runtimeOid);
  });
}

export async function changeP407CourseAdmission(client, review, expectedEpoch, nextPhase) {
  const plan = planP407CourseAdmission(review);
  demand(typeof expectedEpoch === "string" && /^[1-9][0-9]{0,17}$/u.test(expectedEpoch) &&
    ["checkout", "recovery", "closed"].includes(nextPhase));
  return withAdmissionOwner(client, async (runtimeOid) => {
    const previous = await readState(client, plan, runtimeOid, true);
    const drained = previous.active === 0 && previous.uncertain === 0;
    const advances = nextPhase === "checkout" && previous.phase === "held" ||
      nextPhase === "recovery" && previous.phase === "checkout";
    demand(previous.epoch === expectedEpoch && (nextPhase === "closed" || (drained && advances)));
    if (nextPhase === "closed" && previous.phase === "closed") return previous;
    if (nextPhase !== "closed") {
      const { rows: [clock] } = await client.query("SELECT $1::timestamptz > clock_timestamp() AS valid", [plan.expiresAt]);
      const order = await readOrders(client, plan);
      demand(clock?.valid && (nextPhase === "checkout" ? order.count === 0 : order.count === 1 && order.selected === 1));
    }
    const newWork = nextPhase === "checkout";
    const recovery = nextPhase === "recovery";
    await client.query("UPDATE frontend_admission.control SET epoch=epoch+1,new_work=$1,recovery=$2 WHERE singleton", [newWork,recovery]);
    await client.query("UPDATE frontend_admission.producers SET enabled=$1 WHERE producer_sha256=$2", [newWork || recovery, plan.producer]);
    await client.query(`UPDATE frontend_admission.p407_window SET phase=$1,
      expires_at=CASE WHEN $1='closed' THEN NULL ELSE LEAST($3::timestamptz, clock_timestamp()+$2*interval '1 millisecond') END WHERE singleton`,
    [nextPhase, maxWindowMs, plan.expiresAt]);
    return readState(client, plan, runtimeOid);
  });
}

export async function observeP407CourseAdmission(client, review) {
  const plan = planP407CourseAdmission(review);
  return withAdmissionOwner(client, (runtimeOid) => readState(client, plan, runtimeOid, true));
}
