// Deliberate final stage only. Failure is never a request to retry a flag change,
// reopen another producer, replay SQL or restore historical LOGIN credentials.
import { changeFrontendAdmission, observeFrontendDrain } from "./frontend-admission.mjs";

const demand = ok => { if (!ok) throw new Error("FRONTEND_RESTORATION_REFUSED"); };
export function prepareFrontendRestoration(input) {
  demand(input?.version === 1 && typeof input.recovery === "boolean" && typeof input.newWork === "boolean" &&
    (!input.newWork || input.recovery) && input.nativeSchedulesEnabled === false && input.providerIngress === "keep-retired" &&
    typeof input.gatewayBindingSha256 === "string" && /^[a-f0-9]{64}$/u.test(input.gatewayBindingSha256) && !/^0+$/u.test(input.gatewayBindingSha256));
  return { version: 1, recovery: input.recovery, newWork: input.newWork, nativeSchedulesEnabled: false,
    providerIngress: "keep-retired", gatewayBindingSha256: input.gatewayBindingSha256 };
}

export async function restoreFrontendAdmission(plan, client, expectedEpoch, dependencies) {
  const selected = prepareFrontendRestoration(plan.restoration);
  demand(plan.environment === "staging" && typeof dependencies?.verifySession === "function" && typeof dependencies.withOwner === "function" &&
    typeof dependencies.verifyBoundary === "function" && typeof dependencies.record === "function");
  const target = { environment: plan.environment, targetSha256: plan.targetSha256 };
  const base = { version: 1, environment: plan.environment, actionId: plan.actionId, sourceCommit: plan.sourceCommit, targetSha256: plan.targetSha256,
    selected, historicalLoginsRestored: false, providerIngressRestored: false, nativeSchedulesRestored: false, sqlReplayAuthorized: false, wholeReleaseAccepted: false };
  let phase = "closed-boundary-verification", epoch = expectedEpoch, mutationAttempted = false, verifiedAdmission;
  const observe = async () => dependencies.withOwner(() => observeFrontendDrain(client, target, epoch));
  const verifyRetired = async () => {
    await dependencies.verifySession();
    const names = plan.historicalLogins.retiredLogins.map(role => role.name), oids = plan.historicalLogins.retiredLogins.map(role => role.oid);
    const roles = (await client.query("SELECT oid::text,rolname,rolcanlogin FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname", [names])).rows;
    demand(roles.length === names.length && roles.every(row => row.rolcanlogin === false && plan.historicalLogins.retiredLogins.some(role => role.name === row.rolname && role.oid === row.oid)));
    await client.query("SELECT pg_stat_clear_snapshot()");
    demand((await client.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usesysid=ANY($1::oid[])", [oids])).rows[0]?.count === 0);
    const actual = await dependencies.withOwner(async () => (await client.query("SELECT producer_sha256,source_sha,database_role::text AS role_oid FROM frontend_admission.producers WHERE enabled ORDER BY producer_sha256")).rows);
    demand(actual.length === plan.producers.length && actual.every((row, i) => row.producer_sha256 === plan.producers[i].producerSha256 &&
      row.source_sha === plan.sourceCommit && row.role_oid === plan.producers[i].role.oid));
    const runtimeRoles = [...new Map(plan.producers.map(producer => [producer.role.name, producer.role])).values()];
    const runtime = (await client.query(`SELECT oid::text,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit
      FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`, [runtimeRoles.map(role => role.name)])).rows;
    demand(runtime.length === runtimeRoles.length && runtime.every(row => row.rolcanlogin === true &&
      runtimeRoles.some(role => role.name === row.rolname && role.oid === row.oid) &&
      ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "rolinherit"].every(key => row[key] === false)));
    await dependencies.verifySession();
  };
  const boundary = async stage => {
    await verifyRetired(); const admission = await observe();
    demand(admission.uncertain === 0);
    await dependencies.verifyBoundary(stage, admission); await dependencies.verifySession();
    return admission;
  };
  await dependencies.record("frontend-restoration-started.json", { ...base, status: "FRONTEND_RESTORATION_STARTED", epoch });
  try {
    const initial = await boundary("restoration-closed"); demand(initial.ledgerDrained === true);
    for (const [stage, flags] of [["recovery", { newWork: false, recovery: selected.recovery }], ["new-work", { newWork: selected.newWork, recovery: selected.recovery }]]) {
      // Even a selected false/no-op is recorded explicitly; avoid an unnecessary
      // epoch mutation so an interrupted action has fewer uncertain commits.
      const before = await boundary(`restoration-before-${stage}`);
      if (before.newWork !== flags.newWork || before.recovery !== flags.recovery) {
        phase = `restore-${stage}`;
        await dependencies.record(`frontend-restoration-${stage}-intent.json`, { ...base, phase, expectedEpoch: epoch, ...flags });
        await dependencies.verifySession(); mutationAttempted = true;
        const changed = await dependencies.withOwner(() => changeFrontendAdmission(client, target, epoch, flags));
        epoch = changed.epoch; mutationAttempted = false;
        await dependencies.verifySession();
        const actual = await observe(); demand(actual.newWork === flags.newWork && actual.recovery === flags.recovery && actual.uncertain === 0);
        await dependencies.record(`frontend-restoration-${stage}-verified.json`, { ...base, phase, ...actual });
      }
      verifiedAdmission = await boundary(`restoration-after-${stage}`);
    }
    demand(verifiedAdmission.newWork === selected.newWork && verifiedAdmission.recovery === selected.recovery);
    const result = { ...base, status: "FRONTEND_ADMISSION_RESTORATION_VERIFIED", epoch,
      newWork: verifiedAdmission.newWork, recovery: verifiedAdmission.recovery, admissionRestored: true };
    await dependencies.record("frontend-restoration-outcome.json", result); return result;
  } catch {
    // A lost COMMIT acknowledgement or process death cannot be repaired by
    // guessing the epoch or reissuing the opening. Read-only recovery observes
    // actual state before a separately reviewed new action does anything.
    try { await dependencies.record("frontend-restoration-outcome.json", { ...base, status: "FAILED_REQUIRES_REVIEW", phase, epoch,
      admissionRestored: false, mutationOutcomeUncertain: mutationAttempted, admissionNewWork: null, admissionRecovery: null }); } catch { /* original evidence stays exclusive */ }
    throw new Error("FRONTEND_RESTORATION_FAILED_REVIEW_REQUIRED");
  }
}
