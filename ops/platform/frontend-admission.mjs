// Low-level durable ledger only. No live bootstrap, route wiring, historical
// credential retirement, migration authorization or automatic restoration.
import { createHash } from "node:crypto";

const demand = (ok) => { if (!ok) throw new Error("FRONTEND_ADMISSION_REFUSED"); };
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
const sourceDigest = (value) => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value) && !/^0+$/u.test(value);
const epoch = (value) => typeof value === "string" && /^[1-9][0-9]{0,17}$/u.test(value);
function binding(target) {
  demand(["staging", "production"].includes(target?.environment) && digest(target.targetSha256));
  return [target.environment, target.targetSha256];
}
async function transaction(client, task) {
  try { await client.query("BEGIN"); const result = await task(); await client.query("COMMIT"); return result; }
  catch { try { await client.query("ROLLBACK"); } catch { /* outcome remains unverified */ }
    throw new Error("FRONTEND_ADMISSION_FAILED_REVIEW_REQUIRED"); }
}
async function control(client, target, expectedEpoch) {
  const expected = binding(target); demand(epoch(expectedEpoch));
  const { rows } = await client.query("SELECT environment,target_sha256,epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton FOR UPDATE NOWAIT");
  const row = rows[0];
  demand(rows.length === 1 && row.environment === expected[0] && row.target_sha256 === expected[1] && row.epoch === expectedEpoch);
  return row;
}

// Operator-only primitives: the caller supplies a dedicated connected Client,
// owns environment serialization and does not nest these transactions.
export async function changeFrontendAdmission(client, target, expectedEpoch, flags) {
  binding(target); demand(epoch(expectedEpoch) && typeof flags?.newWork === "boolean" && typeof flags.recovery === "boolean");
  return transaction(client, async () => {
    const current = await control(client, target, expectedEpoch);
    if (flags.newWork && !current.new_work || flags.recovery && !current.recovery) {
      const unresolved = await client.query("SELECT 1 FROM frontend_admission.operations WHERE state <> 'completed' LIMIT 1");
      demand(unresolved.rows.length === 0);
    }
    const { rows } = await client.query(`UPDATE frontend_admission.control SET epoch=epoch+1,new_work=$1,recovery=$2
      WHERE singleton RETURNING epoch::text,new_work,recovery`, [flags.newWork, flags.recovery]);
    return { epoch: rows[0].epoch, newWork: rows[0].new_work, recovery: rows[0].recovery };
  });
}

function interactiveSelection(target, expectedEpoch, selection) {
  binding(target);
  demand(target.environment === "staging" && epoch(expectedEpoch) && sourceDigest(selection?.sourceCommit) &&
    typeof target.runtimeRole === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(target.runtimeRole) &&
    Array.isArray(selection.ordinaryProducers) && selection.ordinaryProducers.length > 0 && selection.ordinaryProducers.length <= 256);
  const { sourceCommit, ordinaryProducers, runtimeProducer, interactiveProducer } = selection;
  const producerSha256 = createHash("sha256").update(`lash-her:p2q:interactive-producer:v1\n${sourceCommit}\n${target.targetSha256}`).digest("hex");
  demand(interactiveProducer?.producerSha256 === producerSha256 && runtimeProducer?.role?.name === target.runtimeRole &&
    interactiveProducer.role?.name === target.runtimeRole && interactiveProducer.role.oid === runtimeProducer.role.oid &&
    ordinaryProducers.some(producer => producer?.producerSha256 === runtimeProducer.producerSha256 &&
      producer.role?.name === target.runtimeRole && producer.role.oid === runtimeProducer.role.oid));
  const selected = new Map();
  for (const producer of [...ordinaryProducers, interactiveProducer]) {
    const oid = producer?.role?.oid;
    demand(digest(producer?.producerSha256) && typeof oid === "string" && /^[1-9][0-9]{0,9}$/u.test(oid) &&
      BigInt(oid) <= 4_294_967_295n && !selected.has(producer.producerSha256));
    selected.set(producer.producerSha256, oid);
  }
  return {
    sourceCommit, selected, runtimeRole: target.runtimeRole, runtimeOid: runtimeProducer.role.oid,
    ordinary: ordinaryProducers.map(producer => producer.producerSha256),
    interactive: [producerSha256],
  };
}

async function verifyInteractiveProducers(client, selection, enabled, allowUnregistered = false) {
  const { rows } = await client.query(`SELECT p.producer_sha256,p.source_sha,p.database_role::text AS role_oid,p.enabled,r.rolname,r.rolcanlogin
    FROM frontend_admission.producers p LEFT JOIN pg_catalog.pg_roles r ON p.database_role=r.oid
    WHERE p.enabled OR p.producer_sha256=ANY($1::text[]) LIMIT 258`, [[...selection.selected.keys()]]);
  const registered = rows.some(row => row.producer_sha256 === selection.interactive[0]);
  demand((registered || allowUnregistered) && rows.length === selection.selected.size - (registered ? 0 : 1) && rows.every(row =>
    row.source_sha === selection.sourceCommit && selection.selected.get(row.producer_sha256) === row.role_oid &&
    (row.role_oid !== selection.runtimeOid || row.rolname === selection.runtimeRole && row.rolcanlogin === true) &&
    row.enabled === enabled.includes(row.producer_sha256)));
  return registered;
}

async function replaceInteractiveProducers(client, selection, enabled) {
  await client.query(`UPDATE frontend_admission.producers SET enabled=producer_sha256=ANY($2::text[])
    WHERE producer_sha256=ANY($1::text[])`, [[...selection.selected.keys()], enabled]);
}

async function readAdmissionCounts(client) {
  const { rows } = await client.query(`SELECT count(*) FILTER (WHERE state='active')::int AS active,
    count(*) FILTER (WHERE state='uncertain')::int AS uncertain FROM frontend_admission.operations`);
  return rows[0];
}

async function advanceInteractiveAdmission(client, expectedEpoch, open) {
  const { rows } = await client.query(`UPDATE frontend_admission.control SET epoch=epoch+1,new_work=$1,recovery=$1
    WHERE singleton RETURNING epoch::text,new_work,recovery`, [open]);
  const next = (BigInt(expectedEpoch) + 1n).toString();
  demand(rows.length === 1 && epoch(next) && rows[0].epoch === next && rows[0].new_work === open && rows[0].recovery === open);
  return { epoch: next, newWork: open, recovery: open };
}

async function verifyInteractiveState(client, target, next, selection, enabled) {
  const readback = await control(client, target, next.epoch);
  demand(readback.new_work === next.newWork && readback.recovery === next.recovery);
  await verifyInteractiveProducers(client, selection, enabled);
}

// Install only the deterministic, disabled producer for this staging runtime.
// A conflicting existing row remains available for deliberate investigation.
export async function prepareFrontendInteractiveProducer(client, target, expectedEpoch, reviewed) {
  const selection = interactiveSelection(target, expectedEpoch, reviewed);
  const [producerSha256] = selection.interactive;
  return transaction(client, async () => {
    const current = await control(client, target, expectedEpoch);
    demand(current.new_work === false && current.recovery === false);
    await client.query("LOCK TABLE frontend_admission.producers IN SHARE ROW EXCLUSIVE MODE NOWAIT");
    const drain = await readAdmissionCounts(client);
    demand(drain.active === 0 && drain.uncertain === 0);
    const registered = await verifyInteractiveProducers(client, selection, selection.ordinary, true);
    if (!registered) {
      await client.query(`INSERT INTO frontend_admission.producers (producer_sha256,source_sha,database_role,enabled)
        VALUES($1,$2,$3::oid,false)`, [producerSha256, selection.sourceCommit, selection.runtimeOid]);
    }
    const closed = { epoch: expectedEpoch, newWork: false, recovery: false };
    await verifyInteractiveState(client, target, closed, selection, selection.ordinary);
    return { ...closed, producerSha256, registered: !registered };
  });
}

// Only the pre-registered browser producer can begin work during this epoch.
// Hold the same row lock as admit() and exclude changes to the producer set.
export async function openFrontendInteractiveAdmission(client, target, expectedEpoch, reviewed) {
  const selection = interactiveSelection(target, expectedEpoch, reviewed);
  demand(epoch((BigInt(expectedEpoch) + 2n).toString()));
  return transaction(client, async () => {
    const current = await control(client, target, expectedEpoch);
    demand(current.new_work === false && current.recovery === false);
    await client.query("LOCK TABLE frontend_admission.producers IN SHARE ROW EXCLUSIVE MODE NOWAIT");
    await verifyInteractiveProducers(client, selection, selection.ordinary);
    const drain = await readAdmissionCounts(client);
    demand(drain.active === 0 && drain.uncertain === 0);
    await replaceInteractiveProducers(client, selection, selection.interactive);
    const opened = await advanceInteractiveAdmission(client, expectedEpoch, true);
    await verifyInteractiveState(client, target, opened, selection, selection.interactive);
    return opened;
  });
}

// Closing admission precedes the drain and does not settle in-flight or uncertain
// work. The original registry is restored with both flags closed.
export async function closeFrontendInteractiveAdmission(client, target, expectedEpoch, reviewed) {
  const selection = interactiveSelection(target, expectedEpoch, reviewed);
  return transaction(client, async () => {
    const current = await control(client, target, expectedEpoch);
    demand(current.new_work === true && current.recovery === true);
    await client.query("LOCK TABLE frontend_admission.producers IN SHARE ROW EXCLUSIVE MODE NOWAIT");
    await verifyInteractiveProducers(client, selection, selection.interactive);
    const closed = await advanceInteractiveAdmission(client, expectedEpoch, false);
    await replaceInteractiveProducers(client, selection, selection.ordinary);
    await verifyInteractiveState(client, target, closed, selection, selection.ordinary);
    const drain = await readAdmissionCounts(client);
    return { ...closed, ...drain, ledgerDrained: drain.active === 0 && drain.uncertain === 0 };
  });
}

// A guard may have fenced both flags independently after losing the opener.
// Restore only a verified drained, still-scoped registry in a deliberate step.
export async function restoreFencedFrontendInteractiveProducers(client, target, expectedEpoch, reviewed) {
  const selection = interactiveSelection(target, expectedEpoch, reviewed);
  return transaction(client, async () => {
    const current = await control(client, target, expectedEpoch);
    demand(current.new_work === false && current.recovery === false);
    await client.query("LOCK TABLE frontend_admission.producers IN SHARE ROW EXCLUSIVE MODE NOWAIT");
    await verifyInteractiveProducers(client, selection, selection.interactive);
    const drain = await readAdmissionCounts(client);
    demand(drain.active === 0 && drain.uncertain === 0);
    await replaceInteractiveProducers(client, selection, selection.ordinary);
    const closed = await advanceInteractiveAdmission(client, expectedEpoch, false);
    await verifyInteractiveState(client, target, closed, selection, selection.ordinary);
    return { ...closed, ...drain, ledgerDrained: true };
  });
}

export async function observeFrontendDrain(client, target, expectedEpoch) {
  binding(target); demand(epoch(expectedEpoch));
  return transaction(client, async () => {
    const row = await control(client, target, expectedEpoch);
    const { active, uncertain } = await readAdmissionCounts(client);
    return { epoch: row.epoch, newWork: row.new_work, recovery: row.recovery,
      active, uncertain, ledgerDrained: !row.new_work && !row.recovery && active === 0 && uncertain === 0,
      historicalWritersFenced: false, migrationAuthorized: false };
  });
}

export async function reconcileFrontendOperation(client, target, expectedEpoch, id, evidenceSha256) {
  binding(target); demand(epoch(expectedEpoch) && digest(evidenceSha256));
  return transaction(client, async () => {
    const row = await control(client, target, expectedEpoch);
    demand(!row.new_work && !row.recovery);
    const result = await client.query(`UPDATE frontend_admission.operations SET state='completed',completed_at=clock_timestamp(),reconciliation_sha256=$2
      WHERE id=$1 AND state IN ('active','uncertain') RETURNING id`, [id, evidenceSha256]);
    demand(result.rows.length === 1);
  });
}

export async function runFrontendWriterOperation(client, target, operation, task) {
  const expected = binding(target);
  demand(epoch(operation?.epoch) && digest(operation.producerSha256) && sourceDigest(operation.sourceSha) &&
    ["new-work", "recovery"].includes(operation.kind) && typeof task === "function");
  try {
    // The procedure commits before any effect and refuses an outer transaction. A lost
    // admission acknowledgement never invokes task or retries admission.
    await client.query("CALL frontend_admission.begin_operation($1,$2,$3,$4,$5,$6,$7)",
      [operation.id, operation.kind, ...expected, operation.epoch, operation.producerSha256, operation.sourceSha]);
  } catch { throw new Error("FRONTEND_ADMISSION_REFUSED"); }
  const pending = new Set(); let failed = false, accepting = true, result;
  const defer = (work) => {
    demand(accepting && typeof work === "function");
    const promise = Promise.resolve().then(work).catch(() => { failed = true; }).finally(() => pending.delete(promise));
    pending.add(promise);
  };
  try { result = await task({ defer }); } catch { failed = true; }
  // Deferred work can register more deferred work while it is running.
  while (pending.size) await Promise.all([...pending]);
  accepting = false;
  try { await client.query("CALL frontend_admission.finish_operation($1,$2)", [operation.id, failed ? "uncertain" : "completed"]); }
  catch { throw new Error("FRONTEND_OPERATION_OUTCOME_REQUIRES_REVIEW"); }
  if (failed) throw new Error("FRONTEND_OPERATION_OUTCOME_REQUIRES_REVIEW");
  return result;
}
