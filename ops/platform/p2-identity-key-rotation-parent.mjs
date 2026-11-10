// Fixed source parent for the config-only application-user JWT rotation.
// The transport handle is minted only by the fixed SSH transport. No caller
// callback, JSON boolean, or native-certification capability activates it.
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { withRecoveryFrontendSession, observeRecoveryPhysical } from "./p2-recovery-current-probe.mjs";
import { closeFrontendInteractiveAdmission, observeFrontendDrain, openFrontendInteractiveAdmission,
  prepareFrontendInteractiveProducer } from "./frontend-admission.mjs";
import { frontendPrivateReceiptDirectory, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { writeFrontendReceipt } from "./frontend-migration.mjs";
import { p2NativeHash } from "./p2-lifecycle-native.mjs";
import { readP2IdentityRotationReplacementCustody, selectIdentityRotationWriter,
  withP2IdentityRotationReplacementLease } from "./p2-identity-key-rotation-replacement.mjs";
import { requireQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";
import { P2_IDENTITY_ROTATION_TRANSPORT, withP2IdentityRotationTransport } from "./p2-identity-key-rotation-transport.mjs";
import { launchP2IdentityRotationBrowserReadRecorder, prepareP2IdentityRotationBrowserReadPlan,
  readP2IdentityRotationBrowserControllerBinding, readP2IdentityRotationBrowserReadArtifact } from "./p2-identity-key-rotation-browser-recorder.mjs";

const contexts = new WeakMap();
const authorities = new WeakMap();
const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const demand = (value, check = "P2_IDENTITY_ROTATION_PARENT_REFUSED") => { if (!value) throw new Error(check); };
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
const freeze = value => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const planFields = ["version", "environment", "actionId", "bindingSha256", "candidateSha256", "hostMachineId",
  "sourceCommit", "originalReleaseId", "courseId", "subjects", "configuration", "featureControls", "writerAdmissionBinding",
  "nativePlanSha256", "recoveryActionSha256", "readyReceiptSha256", "sqlAuthorized", "rolePreparationAuthorized",
  "loginChangeAuthorized", "trafficAuthorized", "communityMemberFeatureAdded", "newPublicEndpoint", "releaseAccepted"];
const controllerFields = ["version", "environment", "actionId", "bindingSha256", "candidateSha256", "sourceCommit",
  "hostMachineId", "configuration", "courseId", "subjects"];

export function isP2IdentityRotationParentAuthority(value, plan) {
  const selected = authorities.get(value);
  return Boolean(selected && selected.active() && selected.plan === plan && selected.snapshot === canonical(plan));
}

export function prepareP2IdentityRotationParent(plan, prepared, recoveryAction, bindings, dependencies) {
  const job = prepared?.migration?.job, candidate = prepared?.migration?.candidate;
  const originalReceipts = recoveryAction?.originalReceiptSha256;
  const { bindingSha256, ...reviewed } = plan ?? {};
  demand(plan && Object.getPrototypeOf(plan) === Object.prototype
    && isDeepStrictEqual(Object.keys(plan).sort(), [...planFields].sort()) && bindingSha256 === hash(reviewed)
    && planFields.slice(-7).every(key => plan[key] === false)
    && SHA.test(plan.nativePlanSha256 ?? "") && recoveryAction && plan.recoveryActionSha256 === hash(recoveryAction)
    && plan.version === 1 && plan.environment === "staging" && /^p2-key-rotation-[a-z0-9-]{1,40}$/u.test(plan.actionId)
    && SHA.test(plan.bindingSha256 ?? "") && SHA.test(plan.candidateSha256 ?? "") && COMMIT.test(plan.sourceCommit ?? "")
    && candidate?.environment === "staging" && candidate.contractPhase === "p2" && job?.sourceCommit === plan.sourceCommit
    && candidate.releaseId === plan.originalReleaseId && recoveryAction?.sourceCommit === plan.sourceCommit
    && recoveryAction?.recoveryActionId === plan.actionId && recoveryAction.candidateSha256 === plan.candidateSha256
    && originalReceipts && typeof originalReceipts === "object" && !Array.isArray(originalReceipts)
    && Object.keys(originalReceipts).length >= 3 && Object.keys(originalReceipts).length <= 128
    && ["frontend-release-started.json", "database-receipt.json", "job-outcome.json"].every(name => Object.hasOwn(originalReceipts, name))
    && Object.entries(originalReceipts).every(([name, value]) => /^(?:vercel\/)?[a-z0-9][a-z0-9.-]{0,180}\.json$/u.test(name)
      && (value === null || SHA.test(value)))
    && bindings?.sourceCommit === plan.sourceCommit && bindings.candidateSha256 === plan.candidateSha256
    && bindings.bindingSha256 === plan.bindingSha256
    && isDeepStrictEqual(bindings.configuration, plan.configuration)
    && bindings.featureControls && isDeepStrictEqual(bindings.featureControls, plan.featureControls)
    && bindings.writerAdmissionBinding && isDeepStrictEqual(bindings.writerAdmissionBinding, plan.writerAdmissionBinding)
    && dependencies && Object.keys(dependencies).sort().join() === "getUrl,resultsDirectory,verifyEnvironment"
    && typeof dependencies.getUrl === "function" && typeof dependencies.verifyEnvironment === "function"
    && typeof dependencies.resultsDirectory === "string" && resolve(dependencies.resultsDirectory) === dependencies.resultsDirectory,
  "P2_IDENTITY_ROTATION_PARENT_PLAN_REFUSED");
  const frozen = freeze(structuredClone(plan));
  const resultsDirectory = dependencies.resultsDirectory;
  const actionDirectory = join(resultsDirectory, frozen.actionId);
  const controllerPlan = freeze({
    ...Object.fromEntries(controllerFields.map(key => [key, frozen[key]])),
    privateDirectory: join(actionDirectory, "controller"),
  });
  contexts.set(frozen, { prepared, recoveryAction: freeze(structuredClone(recoveryAction)), resultsDirectory, actionDirectory, controllerPlan,
    dependencies: Object.freeze({ getUrl: dependencies.getUrl, verifyEnvironment: dependencies.verifyEnvironment }) });
  return frozen;
}

export function prepareP2ManagedIdentityRotationParent(plan, lease, hostReview, privateInputBindings, dependencies) {
  const retained = readP2IdentityRotationReplacementCustody(lease);
  const custody = lease.plan;
  requireQualificationTargetProfile(profile, plan, custody, hostReview);
  const { bindingSha256, ...reviewed } = plan;
  const fields = [...planFields.filter(key => key !== "recoveryActionSha256"), "qualificationTargetProfile", "status",
    "targetSha256", "operatorSourceClosureSha256", "candidateObjectSha256", "replacementLeasePlanSha256", "frontendCustodyPlanSha256",
    "initialEpoch", "finalEpoch", "authenticationWindows", "keyRemovalVerified", "liveEligible"];
  demand(isDeepStrictEqual(Object.keys(plan).sort(), fields.sort()) && bindingSha256 === p2NativeHash(reviewed) &&
    plan.version === 2 && plan.status === "P2_IDENTITY_ROTATION_MANAGED_PLANNED" && plan.liveEligible === false &&
    plan.keyRemovalVerified === false && planFields.slice(-7).every(key => plan[key] === false) &&
    plan.actionId === custody.actionId && plan.replacementLeasePlanSha256 === custody.planSha256 &&
    ["sourceCommit", "candidateSha256", "hostMachineId", "targetSha256", "initialEpoch", "finalEpoch"].every(key => plan[key] === custody[key]) &&
    isDeepStrictEqual(plan.authenticationWindows, custody.authenticationWindows) && custody.authenticationWindows.length === 3 &&
    BigInt(plan.finalEpoch) === BigInt(plan.initialEpoch) + 6n &&
    isDeepStrictEqual(hostReview.certificationPlan, custody.frontendPlan) &&
    isDeepStrictEqual(hostReview.readyReceipts, retained.readyReceipts) && hostReview.originalReleaseReceipt === retained.originalReleaseReceipt &&
    plan.originalReleaseId === custody.frontendPlan.originalReleaseId &&
    plan.frontendCustodyPlanSha256 === hostReview.certificationPlan.planSha256 &&
    plan.nativePlanSha256 === custody.frontendPlan.nativePlan.planSha256 &&
    plan.candidateObjectSha256 === custody.frontendPlan.candidateObjectSha256 &&
    plan.operatorSourceClosureSha256 === hostReview.sourceClosureSha256 &&
    isDeepStrictEqual(plan.readyReceiptSha256, custody.frontendPlan.readyReceiptSha256) &&
    isDeepStrictEqual(plan.featureControls, custody.frontendPlan.nativePlan.featureControls) &&
    isDeepStrictEqual(plan.writerAdmissionBinding, custody.frontendPlan.nativePlan.writerAdmissionBinding) &&
    privateInputBindings?.bindingSha256 === bindingSha256 &&
    dependencies && Object.keys(dependencies).sort().join() === "getUrl,resultsDirectory,verifyEnvironment" &&
    typeof dependencies.getUrl === "function" && typeof dependencies.verifyEnvironment === "function" &&
    typeof dependencies.resultsDirectory === "string" && resolve(dependencies.resultsDirectory) === dependencies.resultsDirectory,
  "P2_IDENTITY_ROTATION_MANAGED_PARENT_PLAN_REFUSED");
  const frozen = freeze(structuredClone(plan));
  const resultsDirectory = dependencies.resultsDirectory, actionDirectory = join(resultsDirectory, frozen.actionId);
  const controllerPlan = freeze({
    ...Object.fromEntries(controllerFields.map(key => [key, frozen[key]])),
    version: 1, privateDirectory: join(actionDirectory, "controller"),
  });
  contexts.set(frozen, { lease, resultsDirectory, actionDirectory, controllerPlan, hostReview: freeze(structuredClone(hostReview)),
    privateInputBindings: freeze(structuredClone(privateInputBindings)),
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

async function drainFrontendWindow(observe, deadline) {
  while (true) {
    const observed = await observe();
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
  const managed = plan.version === 2;
  demand(options.fixture === true || (managed ? P2_IDENTITY_ROTATION_PARENT.managedLiveEligible : P2_IDENTITY_ROTATION_PARENT.liveEligible),
    "P2_IDENTITY_ROTATION_LIVE_EXECUTION_UNQUALIFIED");
  frontendPrivateReceiptDirectory(context.resultsDirectory);
  frontendPrivateReceiptDirectory(context.controllerPlan.privateDirectory);
  demand(readFrontendReleaseEvidence(context.actionDirectory, "reviewed-plan.json").equals(Buffer.from(canonical(plan) + "\n")),
    "P2_IDENTITY_ROTATION_PARENT_RETAINED_PLAN_REFUSED");
  if (managed) for (const [name, value] of [
    ["frontend-custody.json", context.hostReview], ["private-input-bindings.json", context.privateInputBindings],
  ]) demand(readFrontendReleaseEvidence(context.actionDirectory, name).equals(Buffer.from(canonical(value) + "\n")),
    "P2_IDENTITY_ROTATION_PARENT_RETAINED_PLAN_REFUSED");
  const fixture = options.fixture === true;
  const withTransport = fixture ? options.withTransport ?? withP2IdentityRotationTransport : withP2IdentityRotationTransport;
  const legacySession = fixture ? options.withSession : withRecoveryFrontendSession;
  const physical = fixture ? options.observePhysical : observeRecoveryPhysical;
  const managedOptions = fixture ? { fixture: true,
    ...(options.withSession || physical ? { withSession: options.withSession, observePhysical: physical } : {}) } : {};
  demand(typeof withTransport === "function" && (managed || typeof legacySession === "function" && typeof physical === "function"),
    "P2_IDENTITY_ROTATION_PARENT_FIXED_DEPENDENCY_REQUIRED");
  const legacyFixtureOnly = !managed && fixture && options.fixtureTerminal !== true;
  let managedEvidence;
  const outcome = await withTransport(input.transport, plan, async host => {
    const { controllerPlan } = context;
    const withSession = managed
      ? task => withP2IdentityRotationReplacementLease(context.lease, context.dependencies, task,
        { ...managedOptions, heldHost: host })
      : task => legacySession(context.prepared, context.recoveryAction, context.dependencies, task);
    const sessionResult = await withSession(async scope => {
      const { client, verify, receipt, probe } = scope;
      await verify();
      const armed = await host.arm({ receipt, probe });
      demand(armed?.status === "P2_IDENTITY_ROTATION_PARENT_ARMED" && armed.bindingSha256 === plan.bindingSha256 &&
        (!managed || armed.version === 2 && ["actionId", "sourceCommit", "candidateSha256"].every(key => armed[key] === plan[key]) &&
          armed.trafficAuthorized === false), "P2_IDENTITY_ROTATION_PARENT_ARM_REFUSED");
      if (managed) requireQualificationTargetProfile(profile, armed);
      let active = true;
      const authority = Object.freeze({});
      authorities.set(authority, { plan: controllerPlan, snapshot: canonical(controllerPlan), active: () => active && host.active() });
      const parent = Object.freeze({ sourceOwnedFixedAction: true, hostLockHeld: true, frontendPhysicalLockHeld: true,
        configOnly: true, nativeSchedulesEnabled: false, businessSchedulesEnabled: false, sqlAuthorized: false,
        rolePreparationAuthorized: false, loginChangeAuthorized: false });
      const admission = { epoch: managed ? receipt.admission.epoch : receipt.admissionEpoch,
        target: { environment: "staging", targetSha256: managed ? plan.targetSha256 : context.prepared.plan.targetSha256 } };
      const withOwner = operation => withFrontendOwner(context, client, verify, operation);
      const frontendSession = { verify, receipt, probe,
        ...(managed ? { observeCurrent: () => scope.observeCurrent(admission.epoch), currentEpoch: () => admission.epoch } : {}) };
      const hostScope = Object.freeze({ sourceCommit: plan.sourceCommit, candidateSha256: plan.candidateSha256,
        bindingSha256: plan.bindingSha256, verify() { demand(active && host.active(), "P2_IDENTITY_ROTATION_PARENT_HOST_LOST"); } });
      const wait = async (deadline, verifyBoundary) => {
        while (Date.now() < deadline) {
          await verify(); await host.check(); await verifyBoundary();
          await pause(Math.min(1_000, Math.max(0, deadline - Date.now())));
        }
        await verify(); await host.check(); await verifyBoundary();
      };
      let writerPrepared = false, writerSelection;
      const physicalState = async expected => {
        await verify(); await host.check();
        const value = managed ? await scope.observeCurrent(admission.epoch) :
          await physical({ ...probe, version: 1, operation: "observe", targetSha256: context.prepared.plan.targetSha256 },
            { getUrl: context.dependencies.getUrl });
        demand(value?.status === "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED" && value.admission?.epoch === admission.epoch
          && value.admission.newWork === expected.newWork && value.admission.recovery === false
          && value.admission.active === expected.active && value.admission.uncertain === expected.uncertain,
        "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_PHYSICAL_REFUSED");
        return value;
      };
      const prepareWriter = async () => {
        if (writerPrepared) return;
        if (managed) await scope.prepareWriter(admission.epoch);
        else {
          writerSelection = selectIdentityRotationWriter(plan.sourceCommit, admission.target.targetSha256,
            receipt.producers, plan.writerAdmissionBinding);
          admission.target.runtimeRole = writerSelection.runtimeProducer.role.name;
          await withOwner(() => prepareFrontendInteractiveProducer(client, admission.target, admission.epoch, writerSelection));
        }
        writerPrepared = true;
      };
      const withBrowserWindow = async (browserPlan, controller, kind, maximumSeconds, task) => {
        demand(kind === "authentication" && maximumSeconds === 300 || kind === "signer-read" && maximumSeconds === 60,
          "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_KIND_REFUSED");
        const source = readP2IdentityRotationBrowserControllerBinding(browserPlan, controller);
        const base = { version: 1, actionId: plan.actionId, bindingSha256: plan.bindingSha256, phase: browserPlan.phase,
          kind, maximumSeconds, source, deploymentId: browserPlan.deploymentId,
          configurationSha256: browserPlan.configurationSha256, sourceCommit: plan.sourceCommit,
          candidateSha256: plan.candidateSha256, browserOrigin: browserPlan.browserOrigin,
          canonicalAliasReadbackSha256: browserPlan.canonicalAliasReadbackSha256,
          canonicalProtectedWorkloadSha256: browserPlan.canonicalProtectedWorkloadSha256 };
        await physicalState({ newWork: false, active: 0, uncertain: 0 });
        const authentication = kind === "authentication";
        const window = managed ? plan.authenticationWindows.find(row => row.phase === browserPlan.phase) : undefined;
        if (managed) demand(window && admission.epoch === (authentication ? window.beforeEpoch : window.closedEpoch),
          "P2_IDENTITY_ROTATION_MANAGED_EPOCH_REFUSED");
        if (authentication) await prepareWriter();
        const intent = await host.beginBrowserWindow(base);
        demand(intent?.status === "P2_IDENTITY_ROTATION_BROWSER_WINDOW_INTENT" && intent.kind === kind
          && intent.phase === browserPlan.phase && intent.bindingSha256 === plan.bindingSha256
          && intent.beforeEpoch === admission.epoch && intent.expectedOpenEpoch ===
            (authentication ? (BigInt(admission.epoch) + 1n).toString() : admission.epoch),
        "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_INTENT_REFUSED");
        let opened = false, result, taskError, closeError;
        try {
          if (authentication) {
            const state = managed ? await scope.openWriter(admission.epoch) :
              await withOwner(() => openFrontendInteractiveAdmission(client, admission.target, admission.epoch, writerSelection));
            demand(state.epoch === intent.expectedOpenEpoch && state.newWork === true && state.recovery === true,
              "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_CHANGE_REFUSED");
            admission.epoch = state.epoch;
          }
          opened = true;
          const acknowledged = await host.browserWindowOpened({ ...base, epoch: admission.epoch });
          demand(acknowledged?.status === "P2_IDENTITY_ROTATION_BROWSER_WINDOW_OPENED"
            && acknowledged.epoch === admission.epoch, "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_OPEN_REFUSED");
          const deadline = Date.now() + maximumSeconds * 1000;
          const permit = await host.takeBrowserPermit({ ...base, epoch: admission.epoch });
          demand(permit?.epoch === admission.epoch, "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_PERMIT_REFUSED");
          result = await task(permit);
          demand(Date.now() <= deadline, "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_EXPIRED");
        } catch (error) { taskError = error; }
        finally {
          if (opened) {
            try {
              const closing = await host.closingBrowserWindow({ ...base, epoch: admission.epoch });
              demand(closing?.status === "P2_IDENTITY_ROTATION_BROWSER_WINDOW_CLOSING"
                && closing.epoch === admission.epoch, "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_CLOSING_REFUSED");
              if (authentication) {
                const state = managed ? await scope.closeWriter(admission.epoch) :
                  await withOwner(() => closeFrontendInteractiveAdmission(client, admission.target, admission.epoch, writerSelection));
                demand(state.epoch === (BigInt(admission.epoch) + 1n).toString() && state.newWork === false && state.recovery === false,
                  "P2_IDENTITY_ROTATION_FRONTEND_WINDOW_CHANGE_REFUSED");
                admission.epoch = state.epoch;
              }
              if (managed) demand(admission.epoch === window.closedEpoch, "P2_IDENTITY_ROTATION_MANAGED_EPOCH_REFUSED");
              const drained = await drainFrontendWindow(managed ? () => scope.observeDrain(admission.epoch)
                : () => withOwner(() => observeFrontendDrain(client, admission.target, admission.epoch)), Date.now() + 300_000);
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
        const canonicalObservation = await host.observeCanonicalOrigin(phase);
        const browserPlan = prepareP2IdentityRotationBrowserReadPlan(plan, phase, deployment, canonicalObservation);
        const controller = launchP2IdentityRotationBrowserReadRecorder(browserPlan, fixture ? options.openOwnedBrowserChild : undefined);
        try {
          await controller.initialized();
          await withBrowserWindow(browserPlan, controller, "authentication", 300,
            async permit => { await controller.authenticate(permit); return controller.authenticated(); });
          const artifact = await withBrowserWindow(browserPlan, controller, "signer-read", 60, async permit => {
            await controller.arm(permit); return controller.complete();
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
        const { runIdentityKeyRotationController: sourceController } = await import("./p2-identity-key-rotation-controller.mjs");
        const runIdentityKeyRotationController = options.fixture === true && typeof options.runController === "function"
          ? options.runController : sourceController;
        const outcome = await runIdentityKeyRotationController(controllerPlan, parent, {
          frontendSession, hostScope,
          ...(!managed ? { physicalDependencies: { getUrl: context.dependencies.getUrl }, observePhysical: physical } : {}),
          observeRuntime: () => host.observeRuntime(), observeFrontendProvider: () => host.observeFrontendProvider(),
          applyMutation: intent => host.applyMutation(intent), reconcileMutation: intent => host.reconcileMutation(intent),
          captureTokens: () => host.captureTokens(), observeProfiles: phase => host.observeProfiles(phase),
          observeFrontendSigner: fixture && typeof options.observeFrontendSigner === "function"
            ? async phase => {
              if (!managed) return options.observeFrontendSigner(phase);
              const window = plan.authenticationWindows.find(row => row.phase === phase);
              demand(window && admission.epoch === window.beforeEpoch, "P2_IDENTITY_ROTATION_MANAGED_EPOCH_REFUSED");
              await scope.observeClosed(phase, "before");
              const result = await options.observeFrontendSigner(phase, window);
              await scope.observeClosed(phase, "after");
              admission.epoch = window.closedEpoch;
              return result;
            } : observeFrontendSigner,
          wait,
          failClosed: state => host.failClosed(state),
          restoreQualified: (phase, configuration) => {
            demand(!managed, "P2_IDENTITY_ROTATION_MANAGED_RESTORATION_REQUIRES_REVIEW");
            return host.restoreQualified(phase, configuration);
          },
        }, { parentAuthority: authority, ...(options.fixture === true ? { fixture: true, nowMs: options.nowMs } : {}) });
        await verify(); await host.check();
        if (legacyFixtureOnly) return Object.freeze({ version: 1,
          status: "P2_IDENTITY_KEY_ROTATION_PARENT_FIXTURE_VALIDATED", actionId: plan.actionId,
          bindingSha256: plan.bindingSha256, sourceCommit: plan.sourceCommit, candidateSha256: plan.candidateSha256,
          sourceMechanicsQualified: outcome.sourceMechanicsQualified === true, sourceParentDispatchIntegrated: false,
          keyRemovalVerified: false, liveEligible: false, releaseAccepted: false, trafficAuthorized: false });
        if (managed) demand(admission.epoch === plan.finalEpoch, "P2_IDENTITY_ROTATION_MANAGED_EPOCH_REFUSED");
        const prepared = managed ? await scope.prepareClose(() => host.finish(outcome)) : await host.finish(outcome);
        demand(prepared?.status === "P2_IDENTITY_KEY_ROTATION_CLOSE_PREPARED" && prepared.keyRemovalVerified === false
          && prepared.actionId === plan.actionId && prepared.bindingSha256 === plan.bindingSha256
          && prepared.sourceCommit === plan.sourceCommit && prepared.candidateSha256 === plan.candidateSha256
          && prepared.sqlExecuted === false && prepared.rolesPrepared === false && prepared.loginChanged === false
          && prepared.trafficAuthorized === false && prepared.tokenBytesOutput === false
          && prepared.credentialHashesOutput === false && prepared.communityMemberFeatureAdded === false
          && prepared.newPublicEndpoint === false && prepared.frontendSessionCloseReceiptSha256 === undefined
          && (!managed || prepared.version === 2 && prepared.frontendFinalEpoch === plan.finalEpoch
            && prepared.frontendCustodyPlanSha256 === plan.frontendCustodyPlanSha256),
        "P2_IDENTITY_ROTATION_PARENT_TERMINAL_REFUSED");
        if (managed) requireQualificationTargetProfile(profile, prepared);
        return Object.freeze(prepared);
      } finally {
        active = false; authorities.delete(authority);
      }
    });
    if (legacyFixtureOnly) return sessionResult;
    const preparedClose = managed ? sessionResult.result : sessionResult;
    if (managed) {
      demand(sessionResult.frontendSessionClosed.admission.epoch === plan.finalEpoch,
        "P2_IDENTITY_ROTATION_MANAGED_EPOCH_REFUSED");
    }
    const joined = await host.frontendSessionClosed(managed ? sessionResult.frontendSessionClosed : undefined);
    const { frontendSessionCloseReceiptSha256, ...retained } = joined ?? {};
    demand(SHA.test(frontendSessionCloseReceiptSha256 ?? "")
      && isDeepStrictEqual(retained, { ...preparedClose, status: "P2_IDENTITY_KEY_ROTATION_QUALIFIED", keyRemovalVerified: true }),
    "P2_IDENTITY_ROTATION_PARENT_CLOSE_REFUSED");
    if (managed) managedEvidence = { closure: sessionResult.frontendSessionClosed, joined };
    if (fixture) return Object.freeze({ version: plan.version,
      ...(managed ? { qualificationTargetProfile: profile, frontendSessionClosedSha256: sessionResult.frontendSessionClosedSha256 } : {}),
      status: "P2_IDENTITY_KEY_ROTATION_PARENT_FIXTURE_JOINED", actionId: plan.actionId,
      bindingSha256: plan.bindingSha256, sourceCommit: plan.sourceCommit, candidateSha256: plan.candidateSha256,
      frontendSessionClosed: true, keyRemovalVerified: false, liveEligible: false,
      releaseAccepted: false, trafficAuthorized: false });
    return Object.freeze(joined);
  }, { fixture });
  if (managed) {
    demand(managedEvidence, "P2_IDENTITY_ROTATION_PARENT_CLOSE_REFUSED");
    const prefix = fixture ? "fixture-" : "";
    writeFrontendReceipt(context.actionDirectory, prefix + "frontend-session-close-observation.json", managedEvidence.closure);
    writeFrontendReceipt(context.actionDirectory, prefix + "host-rotation-joined.json", managedEvidence.joined);
  }
  return outcome;
}

export const P2_IDENTITY_ROTATION_PARENT = Object.freeze({ sourceDispatchIntegrated: true, liveEligible: false,
  get managedLiveEligible() { return P2_IDENTITY_ROTATION_TRANSPORT.managedLiveEligible; },
  requiresDedicatedSupervisorLayout: true, configOnly: true, nativeSchedulesEnabled: false,
  businessSchedulesEnabled: false, sqlAuthorized: false, rolePreparationAuthorized: false, loginChangeAuthorized: false });
