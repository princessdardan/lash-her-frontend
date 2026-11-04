import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const transitions = new Map([
  ["attached/detached", { host: "present", address: "detached", actions: { GatewayAddress: "Modify" } }],
  ["detached/absent", { host: "absent", address: "detached", actions: { ApiHost: "Remove" } }],
  ["absent/attached", { host: "present", address: "attached", actions: { ApiHost: "Add", GatewayAddress: "Modify" } }],
]);

export function hostTemplateSha256(body) {
  assert.equal(typeof body, "string", "Actual change-set template required");
  const ordered = (v) => Array.isArray(v) ? v.map(ordered) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, ordered(v[key])])) : v;
  return createHash("sha256").update(JSON.stringify(ordered(JSON.parse(body)))).digest("hex");
}

/** Pure review gate. This module never creates or executes AWS changes. */
export function inspectHostLifecycleChangeSet(value, expected, actualTemplateBody) {
  assert.equal(expected.environment, "staging", "Staging lifecycle required");
  assert.match(expected.accountId, /^\d{12}$/u);
  assert.equal(expected.region, "us-east-1");
  assert.equal(expected.stackName, "lash-her-api-staging");
  assert.match(expected.templateSha256, /^[a-f0-9]{64}$/u);
  assert.equal(hostTemplateSha256(actualTemplateBody), expected.templateSha256, "Change-set template mismatch");
  const transition = transitions.get(`${expected.from}/${expected.to}`);
  assert.ok(transition, "Ordered detach/remove/recreate transition required");
  assert.equal(value.Status, "CREATE_COMPLETE");
  assert.equal(value.ExecutionStatus, "AVAILABLE");
  const stackPrefix = `arn:aws:cloudformation:${expected.region}:${expected.accountId}:stack/${expected.stackName}/`;
  assert.ok(value.StackId?.startsWith(stackPrefix), "Exact staging stack required");
  assert.match(value.StackId.slice(stackPrefix.length), /^[a-f0-9-]{36}$/u);
  assert.ok(value.ChangeSetId?.startsWith(`arn:aws:cloudformation:${expected.region}:${expected.accountId}:changeSet/`));
  assert.equal(value.IncludeNestedStacks ?? false, false);
  assert.equal(value.NextToken, undefined, "Complete change-set page required");
  const parameters = new Map((value.Parameters ?? []).map((p) => [p.ParameterKey, p.ParameterValue]));
  assert.equal(parameters.size, (value.Parameters ?? []).length, "Duplicate parameters refused");
  assert.equal(parameters.get("Environment"), "staging");
  assert.equal(parameters.get("HostState"), expected.to);
  for (const [key, wanted] of Object.entries(expected.parameters)) assert.equal(parameters.get(key), wanted, `Changed ${key}`);
  assert.equal(parameters.size, Object.keys(expected.parameters).length + 2, "Unreviewed parameter refused");
  assert.ok(Array.isArray(value.Changes) && value.Changes.length > 0);
  const actual = {};
  const seen = new Set();
  for (const change of value.Changes) {
    assert.equal(change.Type, "Resource");
    const r = change.ResourceChange;
    assert.ok(r && !seen.has(r.LogicalResourceId), "Unique resource change required");
    seen.add(r.LogicalResourceId);
    assert.equal(r.ResourceType, r.LogicalResourceId === "ApiHost" ? "AWS::Lightsail::Instance" : "AWS::Lightsail::StaticIp");
    assert.ok(["ApiHost", "GatewayAddress"].includes(r.LogicalResourceId), "Unreviewed resource refused");
    assert.ok(r.Replacement === undefined || r.Replacement === "False", "Replacement refused");
    assert.ok(r.PolicyAction === undefined || r.PolicyAction === "Delete", "Unreviewed deletion policy refused");
    if (r.Action === "Modify") {
      assert.ok(Array.isArray(r.Scope) && r.Scope.length > 0);
      if (r.LogicalResourceId === "GatewayAddress") {
        assert.ok(r.Scope.every((s) => ["Properties", "Metadata"].includes(s)) && r.Scope.includes("Properties"));
        const details = r.Details ?? [];
        assert.ok(details.some((d) => d.Target?.Attribute === "Properties" && d.Target.Name === "AttachedTo"));
        for (const d of details) {
          assert.ok(d.Target?.Attribute === "Metadata" || (d.Target?.Attribute === "Properties" && d.Target.Name === "AttachedTo"));
          assert.ok(d.Target.RequiresRecreation === undefined || d.Target.RequiresRecreation === "Never");
        }
      } else {
        // First adoption may update context; never accept a host property change.
        assert.equal(expected.from, "attached");
        assert.equal(expected.to, "detached");
        assert.deepEqual(r.Scope, ["Metadata"]);
        assert.ok((r.Details ?? []).every((d) => d.Target?.Attribute === "Metadata"));
        continue;
      }
    }
    actual[r.LogicalResourceId] = r.Action;
  }
  assert.deepEqual(actual, transition.actions, "Exact lifecycle changes required");
  return { status: "STAGING_LIFECYCLE_CHANGE_SET_REVIEWED", from: expected.from, to: expected.to,
    changeSetId: value.ChangeSetId, stackId: value.StackId, templateSha256: expected.templateSha256,
    requiredPostcondition: { host: transition.host, staticIp: transition.address, allocationPreserved: true },
    executionAuthorized: false, infrastructureChanged: false };
}
