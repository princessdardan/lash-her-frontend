import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeP2LessonRestorePriorFixture } from "../../tests/support/p2-lesson-restore-prior-fixture.mjs";
import { readP2LessonRestorePrior, validateP2LessonRestorePriorSelection } from "./p2-lesson-restore-prior.mjs";
import { p2NativeHash } from "./p2-lifecycle-native.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE } from "./qualification-target-profile.mjs";

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = value => createHash("sha256").update(value).digest("hex");
const refusal = /P2_LESSON_RESTORE_PRIOR_REFUSED/u;

function fixture() {
  const results = realpathSync(mkdtempSync(join(tmpdir(), "p2-lesson-restore-prior-")));
  const configuration = { "gateway.json": "a".repeat(64) };
  const selected = { courseId: id(2), lessonId: id(3), grantId: id(4) }, actorId = id(1);
  const common = {
    version: 2, qualificationTargetProfile: STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, environment: "staging",
    mode: "interactive-browser", startState: "already-closed", originalReleaseId: "owned-release",
    sourceCommit: "a".repeat(40), operatorSourceCommit: "a".repeat(40), contractPhase: "p2",
    ...Object.fromEntries(["candidateSha256", "candidateObjectSha256", "inventorySha256", "targetSha256",
      "phase2ContractManifestSha256", "originalReleaseReceiptSha256", "originalReleasePlanSha256",
      "runtimeInventorySha256", "gatewayProcessSha256", "gatewayConfigurationSha256", "operatorSourceClosureSha256"].map(key => [key, sha(key)])),
    configurationCanonicalSha256: p2NativeHash(configuration), readyReceiptSha256: { "frontend": "b".repeat(64) },
    apiJobSha256: { course: "d".repeat(64), community: "e".repeat(64) },
    nativePlan: { projectId: "owned-project", deploymentId: "owned-deployment",
      deploymentUrl: "https://owned-deployment.vercel.app", configurationRecordSha256: "c".repeat(64) },
  };
  const firstBody = { ...common, certificationActionId: "owned-rewind", initialEpoch: "3",
    scopedAction: { stage: "lesson-resume", actorId, resumeAction: { operation: "play-and-rewind", ...selected } } };
  const prior = writeP2LessonRestorePriorFixture(results, { ...firstBody, planSha256: p2NativeHash(firstBody) }, configuration);
  const plan = structuredClone({ ...common, certificationActionId: "owned-restore", initialEpoch: "7",
    scopedAction: { stage: "lesson-restore", actorId, restoreAction: { operation: "restore-resume", ...selected, prior } } });
  const identityPlan = structuredClone({ ...common, certificationActionId: "owned-fresh-identity", initialEpoch: "5",
    scopedAction: { stage: "identity", identityActor: { actorKind: "customer", actorId } } });
  const directory = join(results, prior.actionId);
  const update = (name, change) => {
    const path = join(directory, name), record = JSON.parse(readFileSync(path, "utf8"));
    change(record);
    const raw = JSON.stringify(record, null, 2) + "\n";
    writeFileSync(path, raw);
    if (name === "p2-certification-outcome.json") {
      plan.scopedAction.restoreAction.prior.outcomeSha256 = sha(raw);
      writeFileSync(join(directory, "p2-host-certification-outcome.json"), raw);
    }
  };
  return { results, plan, identityPlan, directory, update, cleanup: () => rmSync(results, { recursive: true, force: true }) };
}

test("restore selects an accepted prior rewind and a fresh adjacent identity window", () => {
  const f = fixture();
  try {
    const prior = f.plan.scopedAction.restoreAction.prior;
    assert.equal(validateP2LessonRestorePriorSelection(prior), true);
    const saved = readP2LessonRestorePrior(f);
    assert.equal(saved.progressId, prior.progressId);
    assert.equal(saved.revision, 4);
    assert.equal(saved.resumePositionSeconds, 4);
    assert.equal(saved.maxPositionSeconds, 14);
    assert.ok(Object.isFrozen(saved));
  } finally { f.cleanup(); }
});

test("restore refuses foreign, open, tampered, missing and nonadjacent rewind evidence", () => {
  const cases = {
    "stale prior digest": f => { f.plan.scopedAction.restoreAction.prior.outcomeSha256 = "1".repeat(64); },
    "wrong position": f => { f.plan.scopedAction.restoreAction.prior.resumePositionSeconds = 5; },
    "gateway uncertainty": f => f.update("p2-certification-outcome.json", row => { row.gatewayAdmission.uncertain.newWork = 1; }),
    "runtime replacement": f => f.update("p2-certification-outcome.json", row => { row.runtimeReplaced = true; }),
    "wrong release": f => f.update("p2-certification-outcome.json", row => { row.originalReleaseId = "foreign-release"; }),
    "configuration drift": f => f.update("p2-certification-outcome.json", row => { row.configurationSha256["gateway.json"] = "9".repeat(64); }),
    "other case": f => f.update("p2-certification-outcome.json", row => { row.caseStatus = "P2_INTERACTIVE_LESSON_ENTRY_JOINED"; }),
    "different identity": f => { f.identityPlan.scopedAction.identityActor.actorId = id(99); },
    "intervening epoch": f => { f.identityPlan.initialEpoch = "7"; f.plan.initialEpoch = "9"; },
    "opened before readiness": f => f.update("p2-certification-started.json", row => { row.startState = "qualified-ready"; }),
    "tampered joined receipt": f => f.update("p2-interactive-lesson-resume-joined.json", row => { row.frontendOperationCount = 3; }),
    "tampered Course witness": f => f.update("p2-interactive-lesson-resume-witness.json", row => { row.revision = 6; }),
    "tampered browser receipt": f => f.update("p2-interactive-lesson-resume-browser.json", row => { row.media.segmentObserved = false; }),
    "tampered gateway evidence": f => f.update("p2-interactive-lesson-resume-gateway.json", row => { row.gatewayAcknowledgements[9].requestId = id(99); }),
    "missing joined receipt": f => unlinkSync(join(f.directory, "p2-interactive-lesson-resume-joined.json")),
    "missing committed host terminal": f => unlinkSync(join(f.directory, "p2-host-certification-outcome.json")),
    "different committed host terminal": f => f.update("p2-host-certification-outcome.json", row => { row.caseOutcomeSha256 = "9".repeat(64); }),
    "symlinked prior outcome": f => {
      const path = join(f.directory, "p2-certification-outcome.json");
      unlinkSync(path);
      symlinkSync("p2-certification-started.json", path);
    },
  };
  for (const [name, tamper] of Object.entries(cases)) {
    const f = fixture();
    try {
      tamper(f);
      assert.throws(() => readP2LessonRestorePrior(f), refusal, name);
    } finally { f.cleanup(); }
  }
});
