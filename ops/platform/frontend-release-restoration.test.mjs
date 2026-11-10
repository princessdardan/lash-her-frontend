import assert from "node:assert/strict";
import test from "node:test";
import { prepareFrontendRestoration, restoreFrontendAdmission } from "./frontend-release-restoration.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as current } from "./qualification-target-profile.mjs";

test("restoration selects exact ordered frontend controls while native and retired ingress remain closed", () => {
  const input = { version: 1, newWork: true, recovery: true, nativeSchedulesEnabled: false, providerIngress: "keep-retired", gatewayBindingSha256: "a".repeat(64) };
  assert.deepEqual(prepareFrontendRestoration(input), input);
  for (const change of [v => { v.recovery = false; }, v => { v.nativeSchedulesEnabled = true; }, v => { v.providerIngress = "restore-old"; },
    v => { delete v.gatewayBindingSha256; }, v => { v.gatewayBindingSha256 = "0".repeat(64); }, v => { v.newWork = "true"; }]) {
    const copy = structuredClone(input); change(copy); assert.throws(() => prepareFrontendRestoration(copy));
  }
});

test("profiled restoration binds selection and owning historical context before any query or receipt", async () => {
  const input = { version: 2, qualificationTargetProfile: current, newWork: true, recovery: true, nativeSchedulesEnabled: false,
    providerIngress: "keep-retired", gatewayBindingSha256: "a".repeat(64) };
  assert.deepEqual(prepareFrontendRestoration(input, current), input);
  assert.throws(() => prepareFrontendRestoration(input), /QUALIFICATION_TARGET_PROFILE_REFUSED/u);
  const legacy = { ...input, version: 1 }; delete legacy.qualificationTargetProfile;
  assert.throws(() => prepareFrontendRestoration(legacy, current), /QUALIFICATION_TARGET_PROFILE_REQUIRED/u);
  const plan = { version: 2, qualificationTargetProfile: current, restoration: input, historicalLogins: { version: 1 } };
  let hooks = 0; const client = { query() { hooks++; } }, dependencies = { record() { hooks++; }, verifySession() { hooks++; }, withOwner() { hooks++; } };
  await assert.rejects(restoreFrontendAdmission(plan, client, "1", dependencies, current), /QUALIFICATION_TARGET_PROFILE_REQUIRED/u);
  await assert.rejects(restoreFrontendAdmission(plan, client, "1", dependencies), /QUALIFICATION_TARGET_PROFILE_REFUSED/u);
  await assert.rejects(restoreFrontendAdmission(undefined, client, "1", dependencies, null), /QUALIFICATION_TARGET_PROFILE_REFUSED/u);
  assert.equal(hooks, 0);
});
