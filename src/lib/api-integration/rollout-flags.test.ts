import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayTransport } from "./gateway-transport";
import {
  INTEGRATION_ROLLOUT_FLAGS,
  IntegrationFeatureDisabledError,
  isIntegrationFeatureEnabled,
  withIntegrationFeature,
  type IntegrationFeature,
} from "./rollout-flags";

const features = Object.keys(INTEGRATION_ROLLOUT_FLAGS) as IntegrationFeature[];

function isolatedFlags(t: test.TestContext) {
  const saved = new Map(Object.values(INTEGRATION_ROLLOUT_FLAGS).map(name => [name, process.env[name]]));
  for (const name of saved.keys()) delete process.env[name];
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("the six integration controls are server-only names and all default off", t => {
  isolatedFlags(t);
  assert.equal(features.length, 6);
  assert.equal(new Set(Object.values(INTEGRATION_ROLLOUT_FLAGS)).size, 6);
  for (const feature of features) {
    assert.equal(isIntegrationFeatureEnabled(feature), false);
    assert.ok(!INTEGRATION_ROLLOUT_FLAGS[feature].startsWith("NEXT_PUBLIC_"));
  }
});

test("each rollout control enables only its own capability", t => {
  isolatedFlags(t);
  for (const enabled of features) {
    process.env[INTEGRATION_ROLLOUT_FLAGS[enabled]] = "true";
    for (const feature of features) assert.equal(isIntegrationFeatureEnabled(feature), feature === enabled);
    delete process.env[INTEGRATION_ROLLOUT_FLAGS[enabled]];
  }
});

test("malformed values and unknown or prototype names fail closed", async t => {
  isolatedFlags(t);
  for (const feature of features) {
    for (const value of ["", "false", "TRUE", "True", "1", "yes", " true", "true ", "private-invalid-value"]) {
      process.env[INTEGRATION_ROLLOUT_FLAGS[feature]] = value;
      await assert.rejects(withIntegrationFeature(feature, () => assert.fail("Disabled operation ran")), {
        name: "IntegrationFeatureDisabledError", code: "integration_feature_disabled", message: "Integration feature is disabled",
      });
    }
  }
  for (const value of ["constructor", "__proto__", "toString", "unknown"]) {
    assert.equal(isIntegrationFeatureEnabled(value as IntegrationFeature), false);
    await assert.rejects(withIntegrationFeature(value as IntegrationFeature, () => assert.fail("Unknown operation ran")), IntegrationFeatureDisabledError);
  }
});

test("disabled Course reads stop before workload proof or HTTP; enabled reads retain transport authorization", async t => {
  isolatedFlags(t);
  let proofs = 0, calls = 0;
  const transport = createGatewayTransport({
    origin: "https://gateway.example.test",
    getWorkloadToken: async () => { proofs++; return "owned-workload-proof"; },
    fetch: async (_url, options) => {
      calls++;
      assert.equal(new Headers(options?.headers).get("x-lash-workload-token"), "owned-workload-proof");
      assert.equal(options?.cache, "no-store");
      return Response.json({ courses: [] });
    },
  });
  const read = () => withIntegrationFeature("courseReads", () => transport({ method: "GET", path: "/v1/courses" }));
  await assert.rejects(read(), IntegrationFeatureDisabledError);
  assert.equal(proofs, 0); assert.equal(calls, 0);
  process.env.INTEGRATION_COURSE_READS_ENABLED = "true";
  assert.equal((await read()).status, 200);
  assert.equal(proofs, 1); assert.equal(calls, 1);
  await assert.rejects(withIntegrationFeature("courseReads", () => transport({ method: "GET", path: "/v1/student/courses" })), { code: "authorization" });
  assert.equal(proofs, 1); assert.equal(calls, 1);
  process.env.INTEGRATION_COURSE_READS_ENABLED = "false";
  await assert.rejects(read(), IntegrationFeatureDisabledError);
  assert.equal(proofs, 1); assert.equal(calls, 1);
});

test("closing new access and sales leaves separately enabled entitlement recovery available", async t => {
  isolatedFlags(t);
  process.env.INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED = "true";
  await assert.rejects(withIntegrationFeature("customerAccess", () => "new access"), IntegrationFeatureDisabledError);
  await assert.rejects(withIntegrationFeature("checkout", () => "new sale"), IntegrationFeatureDisabledError);
  assert.equal(await withIntegrationFeature("entitlementRecovery", () => "owned recovery callback"), "owned recovery callback");
  assert.equal(isIntegrationFeatureEnabled("communityWrites"), false);
});

test("the gate does not retry failed work or cancel work already admitted", async t => {
  isolatedFlags(t);
  process.env.INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED = "true";
  let finish!: (value: string) => void;
  const pending = withIntegrationFeature("entitlementRecovery", () => new Promise<string>(resolve => { finish = resolve; }));
  process.env.INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED = "false";
  await assert.rejects(withIntegrationFeature("entitlementRecovery", () => "new work"), IntegrationFeatureDisabledError);
  finish("already admitted"); assert.equal(await pending, "already admitted");
  process.env.INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED = "true";
  let calls = 0;
  const failure = new Error("owned operation failure");
  await assert.rejects(withIntegrationFeature("entitlementRecovery", () => { calls++; throw failure; }), error => error === failure);
  assert.equal(calls, 1);
});
