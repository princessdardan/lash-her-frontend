import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { hostTemplateSha256, inspectHostLifecycleChangeSet } from "./host_lifecycle.mjs";

const templateBody = readFileSync(new URL("../aws/lightsail-host.cfn.json", import.meta.url), "utf8");
const template = JSON.parse(templateBody);
const missing = Symbol("NoValue");
function evaluate(value, parameters) {
  if (Array.isArray(value)) return value.map((v) => evaluate(v, parameters));
  if (!value || typeof value !== "object") return value;
  if (value.Ref) return value.Ref === "AWS::NoValue" ? missing : parameters[value.Ref] ?? value.Ref;
  if (value["Fn::Equals"]) { const [a, b] = evaluate(value["Fn::Equals"], parameters); return a === b; }
  if (value["Fn::Not"]) return !evaluate(value["Fn::Not"][0], parameters);
  if (value["Fn::Or"]) return evaluate(value["Fn::Or"], parameters).some(Boolean);
  if (value["Fn::If"]) { const [condition, yes, no] = value["Fn::If"]; return evaluate(evaluate(template.Conditions[condition], parameters) ? yes : no, parameters); }
  throw new Error("Unsupported test intrinsic");
}

test("staging detaches before removing compute and preserves the allocation through recreation", () => {
  const states = ["attached", "detached", "absent", "attached"].map((HostState) => {
    const p = { Environment: "staging", HostState };
    assert.equal(evaluate(template.Rules.ProductionHostRequired.Assertions[0].Assert, p), true);
    const host = evaluate(template.Conditions[template.Resources.ApiHost.Condition], p);
    assert.equal(template.Resources.GatewayAddress.Condition, undefined);
    const address = evaluate(template.Resources.GatewayAddress.Properties.AttachedTo, p);
    for (const name of ["InstanceName", "InstanceArn"]) assert.equal(evaluate(template.Conditions[template.Outputs[name].Condition], p), host);
    assert.equal(template.Outputs.GatewayIpv4.Condition, undefined);
    return { host, address };
  });
  assert.deepEqual(states, [{ host: true, address: "ApiHost" }, { host: true, address: missing }, { host: false, address: missing }, { host: true, address: "ApiHost" }]);
  assert.equal(template.Parameters.HostState.Default, "attached");
});

test("production rejects detachment and compute removal", () => {
  for (const HostState of ["detached", "absent"]) assert.equal(evaluate(template.Rules.ProductionHostRequired.Assertions[0].Assert, { Environment: "production", HostState }), false);
  assert.equal(evaluate(template.Rules.ProductionHostRequired.Assertions[0].Assert, { Environment: "production", HostState: "attached" }), true);
});

const parameters = { AvailabilityZone: "us-east-1a", BundleId: "medium_3_0", OperatorIpv4Cidr: "192.0.2.1/32", KeyPairName: "fixture", HostOperator: "operator" };
function fixture(from, to) {
  const wanted = { environment: "staging", accountId: "691588646557", region: "us-east-1", stackName: "lash-her-api-staging", templateSha256: hostTemplateSha256(templateBody), from, to, parameters };
  const modify = { Type: "Resource", ResourceChange: { LogicalResourceId: "GatewayAddress", ResourceType: "AWS::Lightsail::StaticIp", Action: "Modify", Replacement: "False", Scope: ["Properties"], Details: [{ Target: { Attribute: "Properties", Name: "AttachedTo", RequiresRecreation: "Never" } }] } };
  const host = (Action) => ({ Type: "Resource", ResourceChange: { LogicalResourceId: "ApiHost", ResourceType: "AWS::Lightsail::Instance", Action } });
  const changes = from === "attached" ? [modify] : from === "detached" ? [host("Remove")] : [host("Add"), modify];
  return [ { StackId: "arn:aws:cloudformation:us-east-1:691588646557:stack/lash-her-api-staging/43564e90-d6f4-11f1-825b-12ffd9c5e733", ChangeSetId: "arn:aws:cloudformation:us-east-1:691588646557:changeSet/fixture/123", Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE", Parameters: Object.entries({ Environment: "staging", HostState: to, ...parameters }).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })), Changes: changes }, wanted, templateBody ];
}

test("change-set inspection accepts only the ordered three staging transitions", () => {
  for (const [from, to] of [["attached", "detached"], ["detached", "absent"], ["absent", "attached"]]) {
    const result = inspectHostLifecycleChangeSet(...fixture(from, to));
    assert.equal(result.executionAuthorized, false);
    assert.equal(result.requiredPostcondition.allocationPreserved, true);
  }
});

test("provider template serialization cannot change the reviewed template semantics", () => {
  const args = fixture("attached", "detached");
  args[2] = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(args[2])).reverse())) + "\n";
  assert.equal(inspectHostLifecycleChangeSet(...args).executionAuthorized, false);
});

test("first adoption permits one host metadata update and refuses duplicate or property updates", () => {
  const args = fixture("attached", "detached");
  const metadata = { Type: "Resource", ResourceChange: { LogicalResourceId: "ApiHost", ResourceType: "AWS::Lightsail::Instance", Action: "Modify", Replacement: "False", Scope: ["Metadata"], Details: [] } };
  args[0].Changes.push(metadata);
  assert.equal(inspectHostLifecycleChangeSet(...args).executionAuthorized, false);
  args[0].Changes.push(structuredClone(metadata));
  assert.throws(() => inspectHostLifecycleChangeSet(...args));
  args[0].Changes.pop(); metadata.ResourceChange.Scope = ["Properties"];
  assert.throws(() => inspectHostLifecycleChangeSet(...args));
});

test("change-set inspection refuses replacement, address deletion and unrelated or ambiguous changes", () => {
  const mutations = [
    (v) => { v.Changes[0].ResourceChange.Replacement = "True"; },
    (v) => { v.Changes[0].ResourceChange.Replacement = "Conditional"; },
    (v) => { v.Changes[0].ResourceChange.Action = "Remove"; },
    (v) => { v.Changes[0].ResourceChange.Details[0].Target.Name = "StaticIpName"; },
    (v) => { v.Changes[0].ResourceChange.Details[0].Target.RequiresRecreation = "Conditionally"; },
    (v) => { v.Changes.push(structuredClone(v.Changes[0])); },
    (v) => { v.Changes[0].ResourceChange.LogicalResourceId = "Other"; },
    (v) => { v.Changes[0].ResourceChange.Scope.push("Tags"); },
    (v) => { v.NextToken = "another-page"; },
    (v) => { v.ExecutionStatus = "EXECUTE_IN_PROGRESS"; },
    (v) => { v.Parameters.find((p) => p.ParameterKey === "BundleId").ParameterValue = "large_3_0"; },
    (v) => { v.Parameters.push({ ParameterKey: "Other", ParameterValue: "value" }); },
    (v) => { v.StackId = v.StackId.replace("691588646557", "000000000000"); },
  ];
  for (const mutate of mutations) { const args = fixture("attached", "detached"); mutate(args[0]); assert.throws(() => inspectHostLifecycleChangeSet(...args)); }
  for (const [from, to] of [["attached", "absent"], ["detached", "attached"], ["absent", "absent"]]) assert.throws(() => inspectHostLifecycleChangeSet(...fixture(from, to)));
  const args = fixture("attached", "detached"); args[1].environment = "production"; assert.throws(() => inspectHostLifecycleChangeSet(...args));
  const changed = fixture("attached", "detached"); const body = JSON.parse(changed[2]); body.Description = "Unreviewed change"; changed[2] = JSON.stringify(body); assert.throws(() => inspectHostLifecycleChangeSet(...changed));
  const omitted = fixture("attached", "detached"); omitted.pop(); assert.throws(() => inspectHostLifecycleChangeSet(...omitted));
});
