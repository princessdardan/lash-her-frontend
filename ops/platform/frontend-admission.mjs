// Low-level durable ledger only. No live bootstrap, route wiring, historical
// credential retirement, migration authorization or automatic restoration.
const demand = (ok) => { if (!ok) throw new Error("FRONTEND_ADMISSION_REFUSED"); };
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
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

export async function observeFrontendDrain(client, target, expectedEpoch) {
  binding(target); demand(epoch(expectedEpoch));
  return transaction(client, async () => {
    const row = await control(client, target, expectedEpoch);
    const { rows } = await client.query(`SELECT count(*) FILTER (WHERE state='active')::int AS active,
      count(*) FILTER (WHERE state='uncertain')::int AS uncertain FROM frontend_admission.operations`);
    return { epoch: row.epoch, newWork: row.new_work, recovery: row.recovery,
      active: rows[0].active, uncertain: rows[0].uncertain,
      ledgerDrained: !row.new_work && !row.recovery && rows[0].active === 0 && rows[0].uncertain === 0,
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
  demand(epoch(operation?.epoch) && digest(operation.producerSha256) && typeof operation.sourceSha === "string" &&
    /^[a-f0-9]{40}$/u.test(operation.sourceSha) && !/^0+$/u.test(operation.sourceSha) &&
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
