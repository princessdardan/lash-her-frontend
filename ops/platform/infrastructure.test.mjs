import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hostTemplateSha256 } from "./host_lifecycle.mjs";
import { infrastructureController, inspectInfrastructureState, inspectValidationEvents,
  stagingInfrastructureSpec, verifyRetirementForInfrastructure } from "./infrastructure.mjs";

const templateBody = readFileSync(new URL("../aws/lightsail-host.cfn.json", import.meta.url), "utf8");
const addressArn = "arn:aws:lightsail:us-east-1:691588646557:StaticIp/11111111-1111-4111-8111-111111111111";
const spec = stagingInfrastructureSpec(templateBody, hostTemplateSha256(templateBody), addressArn);
const newArn = spec.originalInstanceArn.replace("2e608d2c-a88f-416f-a23f-209d20e042f4", "22222222-2222-4222-8222-222222222222");
const services = ["gateway", "course-api", "course-tls", "course-publisher", "course-snapshot", "community-api", "community-tls", "community-worker"];
const retired = { status: "STAGING_RUNTIME_QUIESCED_FOR_RECREATION", environment: "staging", originalHostMachineId: spec.originalMachineId,
  candidateSha256: "a".repeat(64), trafficAuthorized: false, nativeSchedulesDisabled: true, externalProducersSuspended: true,
  publicIngressStopped: true, hostTimersStopped: true,
  stoppedContainers: services.map((service, index) => ({ service, containerId: String(index + 1).repeat(64), running: false, exitCode: 0, oomKilled: false })) };

function fixture(state = "detached") {
  const present = state !== "absent";
  const host = { name: spec.instanceName, arn: state === "attached" ? newArn : spec.originalInstanceArn, createdAt: "2026-11-03T00:00:00Z",
    blueprintId: "ubuntu_24_04", bundleId: spec.parameters.BundleId, sshKeyName: spec.parameters.KeyPairName,
    location: { availabilityZone: "us-east-1a", regionName: "us-east-1" }, state: { name: "running" },
    isStaticIp: state === "attached", publicIpAddress: spec.address, ipv6Addresses: ["2001:db8::1"] };
  const resource = (LogicalResourceId, ResourceType, PhysicalResourceId) => ({ LogicalResourceId, ResourceType, PhysicalResourceId, ResourceStatus: "UPDATE_COMPLETE" });
  return { identity: { Account: spec.accountId }, stacks: { Stacks: [{ StackName: spec.stackName, StackId: spec.stackId, StackStatus: "UPDATE_COMPLETE",
    Parameters: Object.entries({ Environment: "staging", HostState: state, ...spec.parameters }).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
    Outputs: Object.entries({ ApplicationEnvironment: "staging", GatewayIpv4: spec.address,
      ...(present ? { InstanceName: spec.instanceName, InstanceArn: host.arn } : {}) }).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] },
  resources: { StackResourceSummaries: [resource("GatewayAddress", "AWS::Lightsail::StaticIp", spec.addressName),
    ...(present ? [resource("ApiHost", "AWS::Lightsail::Instance", spec.instanceName)] : [])] },
  template: { TemplateBody: templateBody }, address: { staticIp: { arn: addressArn, name: spec.addressName, ipAddress: spec.address,
    isAttached: state === "attached", ...(state === "attached" ? { attachedTo: spec.instanceName } : {}) } }, instances: { instances: present ? [host] : [] },
  ports: { portStates: [22, 443].map(port => ({ protocol: "tcp", fromPort: port, toPort: port, state: "open",
    cidrs: [port === 22 ? spec.parameters.OperatorIpv4Cidr : "0.0.0.0/0"], ipv6Cidrs: [], cidrListAliases: [] })) } };
}

function changes(from, to, name) {
  const modify = { Type: "Resource", ResourceChange: { LogicalResourceId: "GatewayAddress", ResourceType: "AWS::Lightsail::StaticIp", Action: "Modify", Replacement: "False",
    Scope: ["Properties"], Details: [{ Target: { Attribute: "Properties", Name: "AttachedTo", RequiresRecreation: "Never" } }] } };
  const host = Action => ({ Type: "Resource", ResourceChange: { LogicalResourceId: "ApiHost", ResourceType: "AWS::Lightsail::Instance", Action } });
  return { StackId: spec.stackId, ChangeSetId: `arn:aws:cloudformation:us-east-1:691588646557:changeSet/${name}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE", Parameters: Object.entries({ Environment: "staging", HostState: to, ...spec.parameters }).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
    Changes: from === "attached" ? [modify] : from === "detached" ? [host("Remove")] : [host("Add"), modify] };
}
const events = change => ({ OperationEvents: [{ StackId: spec.stackId, OperationId: change.ChangeSetId.split("/").at(-1),
  OperationType: "CREATE_CHANGESET", EventType: "STACK_EVENT", OperationStatus: "SUCCEEDED" }] });

test("provider state binds the exact stack, preserved allocation, selected host and closed IPv6 ports", () => {
  for (const state of ["detached", "absent", "attached"]) {
    const result = inspectInfrastructureState(fixture(state), spec, state);
    assert.equal(result.state, state); assert.equal(result.allocationPreserved, true);
  }
});

test("other stack identity, replaced allocation, open IPv6, unreviewed resources or partial pages refuse", () => {
  for (const mutate of [r => { r.identity.Account = "000000000000"; }, r => { r.stacks.Stacks[0].StackId += "other"; },
    r => { r.address.staticIp.arn += "other"; }, r => { r.address.staticIp.ipAddress = "192.0.2.1"; },
    r => { r.ports.portStates[0].ipv6Cidrs = ["::/0"]; }, r => { r.ports.portStates.push({ fromPort: 4000 }); },
    r => { r.instances.nextPageToken = "more"; }, r => { r.resources.NextToken = "more"; },
    r => { r.resources.StackResourceSummaries.push({ LogicalResourceId: "Other" }); },
    r => { r.instances.instances[0].arn = newArn; }, r => { r.instances.instances[0].sshKeyName = "other"; }]) {
    const raw = fixture(); mutate(raw); assert.throws(() => inspectInfrastructureState(raw, spec, "detached"));
  }
});

test("service validation must be complete, successful and tied to the exact operation", () => {
  const change = changes("attached", "detached", "p1-recreate-fixture-detach");
  assert.equal(inspectValidationEvents(events(change), change, spec).validationErrors, 0);
  for (const mutate of [r => { r.NextToken = "more"; }, r => { r.OperationEvents = []; },
    r => { r.OperationEvents[0].OperationId = "other"; }, r => { r.OperationEvents[0].ValidationStatus = "FAILED"; },
    r => { r.OperationEvents[0].EventType = "VALIDATION_ERROR"; }]) {
    const value = events(change); mutate(value); assert.throws(() => inspectValidationEvents(value, change, spec));
  }
});

function driver(from, to, options = {}) {
  const calls = [], records = []; let current = from, clock = 0;
  const name = `p1-recreate-fixture-${to}`, change = changes(from, to, name);
  const aws = async request => {
    calls.push(request);
    if (request.operation === "CreateChangeSet") return { StackId: spec.stackId, Id: change.ChangeSetId };
    if (request.operation === "DescribeChangeSet") return options.badChange ?? change;
    if (request.operation === "DescribeEvents") return events(change);
    if (request.operation === "ExecuteChangeSet") {
      assert.equal(records.at(-1)[0], name + "-execute-started");
      assert.equal(request.params.DisableRollback, true);
      if (options.uncertain) throw new Error("Ambiguous provider acknowledgement");
      current = to; return {};
    }
    const raw = fixture(current);
    const key = { GetCallerIdentity: "identity", DescribeStacks: "stacks", ListStackResources: "resources", GetTemplate: "template",
      GetStaticIp: "address", GetInstances: "instances", GetInstancePortStates: "ports" }[request.operation];
    assert.ok(key); return raw[key];
  };
  const controller = infrastructureController({ spec, templateBody, aws, record: async (...record) => records.push(record), now: () => clock, sleep: async ms => { clock += ms; } });
  return { controller, calls, records, name };
}

test("each reviewed transition executes once, checks postconditions and records before mutation", async () => {
  for (const [from, to] of [["attached", "detached"], ["detached", "absent"], ["absent", "attached"]]) {
    const owned = driver(from, to);
    const result = await owned.controller.step(from, to, owned.name, "a".repeat(64), retired);
    assert.equal(result.state, to); assert.equal(result.infrastructureChanged, true);
    assert.equal(owned.calls.filter(c => c.operation === "CreateChangeSet").length, 1);
    assert.equal(owned.calls.filter(c => c.operation === "ExecuteChangeSet").length, 1);
    assert.ok(owned.records[0][0].endsWith("-create-started"));
    assert.ok(owned.records.at(-1)[0].endsWith("-completed"));
    assert.ok(!owned.calls.some(c => ["DeleteStack", "UpdateStack", "DeleteInstance", "ReleaseStaticIp"].includes(c.operation)));
  }
});

test("an uncertain execution is never retried or followed by another provider mutation", async () => {
  const owned = driver("attached", "detached", { uncertain: true });
  await assert.rejects(owned.controller.step("attached", "detached", owned.name, "a".repeat(64), retired), /Ambiguous/u);
  assert.equal(owned.calls.filter(c => c.operation === "ExecuteChangeSet").length, 1);
  assert.equal(owned.calls.at(-1).operation, "ExecuteChangeSet");
  assert.ok(!owned.records.some(([name]) => name.endsWith("-completed")));
});

test("replacement or incomplete retirement prevents execution", async () => {
  const bad = changes("attached", "detached", "p1-recreate-fixture-detached"); bad.Changes[0].ResourceChange.Replacement = "True";
  const owned = driver("attached", "detached", { badChange: bad });
  await assert.rejects(owned.controller.step("attached", "detached", owned.name, "a".repeat(64), retired));
  assert.equal(owned.calls.filter(c => c.operation === "ExecuteChangeSet").length, 0);
  for (const modify of [r => { r.stoppedContainers[0].exitCode = 137; }, r => { r.publicIngressStopped = false; },
    r => { r.stoppedContainers[0].service = "other"; }, r => { r.originalHostMachineId = "0".repeat(32); }]) {
    const value = structuredClone(retired); modify(value);
    assert.throws(() => verifyRetirementForInfrastructure(value, "a".repeat(64)));
  }
});
