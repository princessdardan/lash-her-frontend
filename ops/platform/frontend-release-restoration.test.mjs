import assert from "node:assert/strict";
import test from "node:test";
import { prepareFrontendRestoration } from "./frontend-release-restoration.mjs";

test("restoration selects exact ordered frontend controls while native and retired ingress remain closed", () => {
  const input = { version: 1, newWork: true, recovery: true, nativeSchedulesEnabled: false, providerIngress: "keep-retired", gatewayBindingSha256: "a".repeat(64) };
  assert.deepEqual(prepareFrontendRestoration(input), input);
  for (const change of [v => { v.recovery = false; }, v => { v.nativeSchedulesEnabled = true; }, v => { v.providerIngress = "restore-old"; },
    v => { delete v.gatewayBindingSha256; }, v => { v.gatewayBindingSha256 = "0".repeat(64); }, v => { v.newWork = "true"; }]) {
    const copy = structuredClone(input); change(copy); assert.throws(() => prepareFrontendRestoration(copy));
  }
});
