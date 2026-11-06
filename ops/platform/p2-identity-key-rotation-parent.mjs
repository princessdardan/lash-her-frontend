// Fixed source parent for the config-only application-user JWT rotation.
// The transport handle is minted only by the fixed SSH transport. No caller
// callback, JSON boolean, or native-certification capability activates it.
import { setTimeout as pause } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { withRecoveryFrontendSession, observeRecoveryPhysical } from "./p2-recovery-current-probe.mjs";
import { changeFrontendAdmission, observeFrontendDrain } from "./frontend-admission.mjs";
import { withP2IdentityRotationTransport } from "./p2-identity-key-rotation-transport.mjs";
import { launchP2IdentityRotationBrowserReadRecorder, prepareP2IdentityRotationBrowserReadPlan,
  readP2IdentityRotationBrowserControllerBinding, readP2IdentityRotationBrowserReadArtifact } from "./p2-identity-key-rotation-browser-recorder.mjs";

const contexts = new WeakMap();
const authorities = new WeakMap();
const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const demand = (value, check = "P2_IDENTITY_ROTATION_PARENT_REFUSED") => { if (!value) throw new Error(check); };
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);

export function isP2IdentityRotationParentAuthority(value, plan) {
  const selected = authorities.get(value);
  return Boolean(selected && selected.active() && selected.plan === plan && selected.snapshot === canonical(plan));
}

export function prepareP2IdentityRotationParent(plan, prepared, recoveryAction, bindings, dependencies) {
  const job = prepared?.migration?.job, candidate = prepared?.migration?.candidate;
  demand(plan?.version === 1 && plan.environment === "staging" && /^p2-key-rotation-[a-z0-9-]{1,40}$/u.test(plan.actionId)
    && SHA.test(plan.bindingSha256 ?? "") && SHA.test(plan.candidateSha256 ?? "") && COMMIT.test(plan.sourceCommit ?? "")
    && candidate?.environment === "staging" && candidate.contractPhase === "p2" && job?.sourceCommit === plan.sourceCommit
    && recoveryAction?.recoveryActionId === plan.actionId && recoveryAction.candidateSha256 === plan.candidateSha256
    && SHA.test(recoveryAction.originalReceiptSha256 ?? "")
    && bindings?.sourceCommit === plan.sourceCommit && bindings.candidateSha256 === plan.candidateSha256
    && bindings.bindingSha256 === plan.bindingSha256
    && isDeepStrictEqual(bindings.configuration, plan.configuration)
    && bindings.featureControls && bindings.writerAdmissionBinding
    && dependencies && Object.keys(dependencies).sort().join() === ["getUrl", "verifyEnvironment"].sort().join()
    && typeof dependencies.getUrl === "function" && typeof dependencies.verifyEnvironment === "function",
  "P2_IDENTITY_ROTATION_PARENT_PLAN_REFUSED");
  const frozen = Object.freeze(structuredClone(plan));
  contexts.set(frozen, { prepared, recoveryAction: structuredClone(recoveryAction), bindings: structuredClone(bindings),
    dependencies: Object.freeze({ getUrl: dependencies.getUrl, verifyEnvironment: dependencies.verifyEnvironment }) });
  return frozen;
}

async function withFrontendOwner(context, client, verify, task) {
  const owner = context.prepared.plan.owner;
  demand(typeof owner?.name === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(owner.name)
    && typeof owner.oid === "string" && /^[1-9][0-9]{0,9}$/u.test(owner.oid),
  "P2_IDENTITY_ROTATION_FRONTEND_OWNER_REFUSED");
  await verify();
  const rows = (await client.query(`SELECT oid::text FROM pg_roles WHERE rolname=$1 AND NOT rolcanlogin AND NOT rolinherit
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls`, [owner.name])).rows;
  demand(rows.length === 1 && rows[0].oid === owner.oid, "P2_IDENTITY_ROTATION_FRONTEND_OWNER_REFUSED");
  await client.query(`SET ROLE "${owner.name}"`);
  try { return await task(); }
  finally { await client.query("RESET ROLE"); await verify(); }
}

async function drainFrontendWindow(context, state, client, verify, deadline) {
  while (true) {
    const observed = await withFrontendOwner(context, client, verify,
      () => observeFrontendDrain(client, state.target, state.epoch));
    if (observed.ledgerDrained === true && observed.active === 0 && observed.uncertain === 0) return observed;
    demand(Date.now() < deadline, "P2_IDENTITY_ROTATION_FRONTEND_DRAIN_UNRESOLVED");
    await pause(Math.min(250, Math.max(0, deadline - Date.now())));
  }
}

export async function runP2IdentityRotationParent(plan, input, options = {}) {
  const context = contexts.get(plan);
  demand(context && input?.confirmation === `staging/${plan.actionId}` && input.transport
    && Object.keys(input).sort().join() === ["confirmation", "transport"].sort().join(),
  "P2_IDENTITY_ROTATION_PARENT_CONTEXT_REFUSED");
  const withTransport = options.fixture === true ? options.withTransport : withP2IdentityRotationTransport;
  const withSession = options.fixture === true ? options.withSession : withRecoveryFrontendSession;
  const physical = options.fixture === true ? options.observePhysical : observeRecoveryPhysical;
  demand(typeof withTransport === "function" && typeof withSession === "function" && typeof physical === "function",
    "P2_IDENTITY_ROTATION_PARENT_FIXED_DEPENDENCY_REQUIRED");
  return withTransport(input.transport, plan, async host => withSession(context.prepared, context.recoveryAction,
    context.dependencies, async ({ client, verify, receipt, probe }) => {
      await verify();
      const armed = await host.arm({ receipt, probe });
      demand(armed?.status === "P2_IDENTITY_ROTATION_PARENT_ARMED" && armed.bindingSha256 === plan.bindingSha256,
        "P2_IDENTITY_ROTATION_PARENT_ARM_REFUSED");
      let active = true;
      const authority = Object.freeze({});
      authorities.set(authority, { plan, snapshot: canonical(plan), active: () => active && host.active() });
      const parent = Object.freeze({ sourceOwnedFixedAction: true, hostLockHeld: true, frontendPhysicalLockHeld: true,
        configOnly: true, nativeSchedulesEnabled: false, businessSchedulesEnabled: false, sqlAuthorized: false,
        rolePreparationAuthorized: false, loginChangeAuthorized: false });
      const frontendSession = { verify, receipt, probe };
      const hostScope = Object.freeze({ sourceCommit: plan.sourceCommit, candidateSha256: plan.candidateSha256,
        bindingSha256: plan.bindingSha256, verify() { demand(active && host.active(), "P2_IDENTITY_ROTATION_PARENT_HOST_LOST"); } });
      const wait = async (deadline, verifyBoundary) => {
        while (Date.now() < deadline) {
          await verify(); await host.check(); await verifyBoundary();
          await pause(Math.min(1_000, Math.max(0, deadline - Date.now())));
        }
        await verify(); await host.check(); await verifyBoundary();
      };
      const admission = { epoch: receipt.admissionEpoch,
        target: { environment: context.prepared.plan.environment, targetSha256: context.prepared.plan.targetSha256 } };
      const physicalState = async expected => {
        await verify(); await host.check();
        const value = await physical({ ...probe, version: 1, operation: "observe", targetSha256: context.prepared.plan.targetSha256 },
          { getUrl: context.dependencies.getUrl });
        demand(value?.status === "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED" && value.admission?.epoch === admission.epoch
          && value.admission.newWork === expected.newWork && value.admission.recovery === false
          && value.admission.active === expected.active && value.admission.uncertain === expected.uncertain,
        "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_PHYSICAL_REFUSED");
        return value;
      };
      const setAdmission = async newWork => {
        const changed = await withFrontendOwner(context, client, verify,
          () => changeFrontendAdmission(client, admission.target, admission.epoch, { newWork, recovery: false }));
        admission.epoch = changed.epoch;
        demand(changed.newWork === newWork && changed.recovery === false,
          "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_CHANGE_REFUSED");
        return changed;
      };
      const withBrowserWindow = async (browserPlan, controller, kind, maximumSeconds, task) => {
        demand(kind === "authentication" && maximumSeconds === 300 || kind === "signer-read" && maximumSeconds === 60,
          "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_KIND_REFUSED");
        const source = readP2IdentityRotationBrowserControllerBinding(browserPlan, controller);
        const base = { version: 1, actionId: plan.actionId, bindingSha256: plan.bindingSha256, phase: browserPlan.phase,
          kind, maximumSeconds, source, deploymentId: browserPlan.deploymentId,
          configurationSha256: browserPlan.configurationSha256, sourceCommit: plan.sourceCommit,
          candidateSha256: plan.candidateSha256 };
        await physicalState({ newWork: false, active: 0, uncertain: 0 });
        const intent = await host.beginBrowserWindow(base);
        demand(intent?.status === "P2_IDENTITY_ROTATION_BROWSER_WINDOW_INTENT" && intent.kind === kind
          && intent.phase === browserPlan.phase && intent.bindingSha256 === plan.bindingSha256,
        "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_INTENT_REFUSED");
        let opened = false, result, taskError, closeError;
        try {
          await setAdmission(true); opened = true;
          await physicalState({ newWork: true, active: 0, uncertain: 0 });
          const acknowledged = await host.browserWindowOpened({ ...base, epoch: admission.epoch });
          demand(acknowledged?.status === "P2_IDENTITY_ROTATION_BROWSER_WINDOW_OPENED"
            && acknowledged.epoch === admission.epoch, "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_OPEN_REFUSED");
          const deadline = Date.now() + maximumSeconds * 1000;
          result = await task(deadline);
          demand(Date.now() <= deadline, "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_EXPIRED");
        } catch (error) { taskError = error; }
        finally {
          if (opened) {
            try {
              const closing = await host.closingBrowserWindow({ ...base, epoch: admission.epoch });
              demand(closing?.status === "P2_IDENTITY_ROTATION_BROWSER_WINDOW_CLOSING"
                && closing.epoch === admission.epoch, "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_CLOSING_REFUSED");
              await setAdmission(false);
              const drained = await drainFrontendWindow(context, admission, client, verify, Date.now() + 300_000);
              await physicalState({ newWork: false, active: 0, uncertain: 0 });
              const closed = await host.endBrowserWindow({ ...base, epoch: admission.epoch, drain: drained });
              demand(closed?.status === "P2_IDENTITY_ROTATION_BROWSER_WINDOW_CLOSED"
                && closed.epoch === admission.epoch && closed.active === 0 && closed.uncertain === 0,
              "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_CLOSE_REFUSED");
            } catch (error) { closeError = error; }
          }
        }
        if (taskError || closeError) throw new Error("P2_IDENTITY_ROTATION_FRONTEND_WINDOW_REQUIRES_REVIEW");
        return result;
      };
      const observeFrontendSigner = async phase => {
        const deployment = await host.frontendDeployment(phase);
        const browserPlan = prepareP2IdentityRotationBrowserReadPlan(plan, phase, deployment);
        const controller = launchP2IdentityRotationBrowserReadRecorder(browserPlan);
        try {
          await controller.initialized();
          await withBrowserWindow(browserPlan, controller, "authentication", 300,
            async () => controller.authenticated());
          const artifact = await withBrowserWindow(browserPlan, controller, "signer-read", 60, async () => {
            await controller.arm(); return controller.complete();
          });
          const sourceRecord = readP2IdentityRotationBrowserReadArtifact(browserPlan, artifact);
          const retained = await host.retainFrontendSigner(phase, sourceRecord);
          demand(retained?.status === "P2_IDENTITY_ROTATION_FRONTEND_SIGNER_VERIFIED"
            && retained.phase === phase && retained.bindingSha256 === plan.bindingSha256,
          "P2_IDENTITY_ROTATION_FRONTEND_SIGNER_RETAIN_REFUSED");
          return host.observeFrontendSigner(phase);
        } finally { await controller.close().catch(() => {}); }
      };
      try {
        const { runIdentityKeyRotationController } = await import("./p2-identity-key-rotation-controller.mjs");
        const outcome = await runIdentityKeyRotationController(plan, parent, {
          frontendSession, hostScope, physicalDependencies: { getUrl: context.dependencies.getUrl }, observePhysical: physical,
          observeRuntime: () => host.observeRuntime(), observeFrontendProvider: () => host.observeFrontendProvider(),
          applyMutation: intent => host.applyMutation(intent), reconcileMutation: intent => host.reconcileMutation(intent),
          captureTokens: () => host.captureTokens(), observeProfiles: phase => host.observeProfiles(phase),
          observeFrontendSigner, wait,
          failClosed: state => host.failClosed(state), restoreQualified: (phase, configuration) => host.restoreQualified(phase, configuration),
        }, { parentAuthority: authority, ...(options.fixture === true ? { fixture: true, nowMs: options.nowMs } : {}) });
        await verify(); await host.check();
        if (options.fixture === true) return Object.freeze({ version: 1,
          status: "P2_IDENTITY_KEY_ROTATION_PARENT_FIXTURE_VALIDATED", actionId: plan.actionId,
          bindingSha256: plan.bindingSha256, sourceCommit: plan.sourceCommit, candidateSha256: plan.candidateSha256,
          sourceMechanicsQualified: outcome.sourceMechanicsQualified === true, sourceParentDispatchIntegrated: false,
          keyRemovalVerified: false, liveEligible: false, releaseAccepted: false, trafficAuthorized: false });
        const qualified = await host.finish(outcome);
        demand(qualified?.status === "P2_IDENTITY_KEY_ROTATION_QUALIFIED" && qualified.keyRemovalVerified === true
          && qualified.actionId === plan.actionId && qualified.bindingSha256 === plan.bindingSha256
          && qualified.sourceCommit === plan.sourceCommit && qualified.candidateSha256 === plan.candidateSha256
          && qualified.sqlExecuted === false && qualified.rolesPrepared === false && qualified.loginChanged === false
          && qualified.trafficAuthorized === false && qualified.tokenBytesOutput === false
          && qualified.credentialHashesOutput === false && qualified.communityMemberFeatureAdded === false
          && qualified.newPublicEndpoint === false, "P2_IDENTITY_ROTATION_PARENT_TERMINAL_REFUSED");
        return Object.freeze(qualified);
      } finally {
        active = false; authorities.delete(authority);
      }
    }));
}

export const P2_IDENTITY_ROTATION_PARENT = Object.freeze({ sourceDispatchIntegrated: false,
  requiresDedicatedSupervisorLayout: true, configOnly: true, nativeSchedulesEnabled: false,
  businessSchedulesEnabled: false, sqlAuthorized: false, rolePreparationAuthorized: false, loginChangeAuthorized: false });
