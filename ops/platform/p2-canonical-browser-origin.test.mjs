import assert from "node:assert/strict";
import test from "node:test";
import { P2_CANONICAL_BROWSER_ORIGIN, validateP2CanonicalBrowserObservation } from "./p2-canonical-browser-origin.mjs";
function fixture() {
  const plan = { environment: "staging", actionId: "original-release", releaseId: "original-release", sourceCommit: "a".repeat(40),
    deploymentId: "dpl_owned", deploymentUrl: "https://owned.vercel.app", configurationRecordSha256: "b".repeat(64),
    featureControls: { owned: true }, writerAdmissionBinding: { owned: true } };
  const value = { ...plan, version: 1, status: "P2_CANONICAL_BROWSER_ORIGIN_VERIFIED", browserOrigin: P2_CANONICAL_BROWSER_ORIGIN,
    projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM", aliasReadbackSha256: "c".repeat(64), protectedWorkloadSha256: "d".repeat(64),
    observedAt: "2026-11-06T12:00:00.000Z", aliasReadbacks: 2, aliasRedirect: false, workloadChallengeVerified: true, tlsVerified: true,
    probeExpiryExtended: false, releaseAccepted: false };
  return { plan, value };
}
test("fixed canonical browser origin preserves separate immutable deployment provenance", () => {
  const { plan, value } = fixture(); assert.equal(validateP2CanonicalBrowserObservation(plan, value).browserOrigin, "https://staging.lashher.com");
  assert.notEqual(value.browserOrigin, value.deploymentUrl);
});
test("foreign alias, deployment, source, profile, writer binding or unverified transport refuses", () => {
  for (const change of [value => { value.browserOrigin = "https://foreign.invalid"; }, value => { value.deploymentId = "dpl_other"; },
    value => { value.releaseId = "other"; }, value => { value.sourceCommit = "f".repeat(40); }, value => { value.featureControls.owned = false; },
    value => { value.writerAdmissionBinding.owned = false; }, value => { value.aliasReadbacks = 1; }, value => { value.aliasRedirect = true; },
    value => { value.probeExpiryExtended = true; }, value => { value.tlsVerified = false; }]) {
    const { plan, value } = fixture(); value.featureControls = { ...value.featureControls }; value.writerAdmissionBinding = { ...value.writerAdmissionBinding };
    change(value); assert.throws(() => validateP2CanonicalBrowserObservation(plan, value));
  }
});
