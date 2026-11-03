// The reviewed local parent supplies AWS transport and a durable recorder.
// No operation here can delete a stack, replace the address or widen ingress.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hostTemplateSha256, inspectHostLifecycleChangeSet } from "./host_lifecycle.mjs";

const parameters = { AvailabilityZone: "us-east-1a", BundleId: "medium_3_0", OperatorIpv4Cidr: "99.239.200.211/32", KeyPairName: "Dardan", HostOperator: "dardan" };
const scope = { environment: "staging", accountId: "691588646557", region: "us-east-1", stackName: "lash-her-api-staging",
  stackId: "arn:aws:cloudformation:us-east-1:691588646557:stack/lash-her-api-staging/43564e90-d6f4-11f1-825b-12ffd9c5e733",
  instanceName: "lash-her-api-staging-host", addressName: "lash-her-api-staging-gateway", address: "184.196.129.231",
  originalInstanceArn: "arn:aws:lightsail:us-east-1:691588646557:Instance/2e608d2c-a88f-416f-a23f-209d20e042f4",
  originalMachineId: "ec265c34b9fbf4d051aecfa185362c0a",
  initialTemplateSha256: "abd88272b43f6ca3f34b51f96aee56bf29631ca0492f90f1421997ce2fd41c8b" };
const digest = value => createHash("sha256").update(value).digest("hex");
const pairs = (items, key, value) => {
  assert.ok(Array.isArray(items));
  const result = Object.fromEntries(items.map(item => [item[key], item[value]]));
  assert.equal(Object.keys(result).length, items.length, "Duplicate provider fields refused");
  return result;
};

export function stagingInfrastructureSpec(templateBody, reviewedTemplateSha256, addressArn) {
  assert.equal(hostTemplateSha256(templateBody), reviewedTemplateSha256, "Reviewed template required");
  assert.match(addressArn, /^arn:aws:lightsail:us-east-1:691588646557:StaticIp\/[a-f0-9-]{36}$/u);
  return { ...scope, parameters: { ...parameters }, templateSha256: reviewedTemplateSha256, addressArn };
}

export function inspectInfrastructureState(raw, spec, expectedState, expectedInstanceState = "running") {
  assert.ok(["attached", "detached", "absent"].includes(expectedState));
  assert.ok(["running", "stopped"].includes(expectedInstanceState));
  assert.equal(raw.identity.Account, spec.accountId);
  assert.equal(raw.stacks.NextToken, undefined);
  assert.equal(raw.stacks.Stacks?.length, 1);
  const stack = raw.stacks.Stacks[0];
  assert.equal(stack.StackId, spec.stackId); assert.equal(stack.StackName, spec.stackName);
  assert.equal(stack.StackStatus, "UPDATE_COMPLETE", "Stable completed stack required");
  const actualParameters = pairs(stack.Parameters, "ParameterKey", "ParameterValue");
  const body = typeof raw.template.TemplateBody === "string" ? raw.template.TemplateBody : JSON.stringify(raw.template.TemplateBody);
  const actualTemplateSha256 = hostTemplateSha256(body);
  const legacy = actualParameters.HostState === undefined;
  assert.ok(!legacy || expectedState === "attached", "Only initial attached state can omit lifecycle parameter");
  assert.deepEqual(actualParameters, { Environment: "staging", ...(legacy ? {} : { HostState: expectedState }), ...spec.parameters });
  assert.equal(actualTemplateSha256, legacy ? spec.initialTemplateSha256 : spec.templateSha256);
  assert.equal(raw.resources.NextToken, undefined);
  const active = (raw.resources.StackResourceSummaries ?? []).filter(item => item.ResourceStatus !== "DELETE_COMPLETE");
  assert.equal(active.length, expectedState === "absent" ? 1 : 2);
  const resources = new Map(active.map(item => [item.LogicalResourceId, item]));
  assert.equal(resources.size, active.length);
  assert.deepEqual([...resources.keys()].sort(), expectedState === "absent" ? ["GatewayAddress"] : ["ApiHost", "GatewayAddress"]);
  for (const [logical, physical, type] of [["GatewayAddress", spec.addressName, "AWS::Lightsail::StaticIp"],
    ...(expectedState === "absent" ? [] : [["ApiHost", spec.instanceName, "AWS::Lightsail::Instance"]])]) {
    const value = resources.get(logical);
    assert.equal(value.PhysicalResourceId, physical); assert.equal(value.ResourceType, type);
    assert.ok(["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(value.ResourceStatus));
  }
  const address = raw.address.staticIp;
  assert.equal(address?.arn, spec.addressArn); assert.equal(address.name, spec.addressName); assert.equal(address.ipAddress, spec.address);
  assert.equal(address.isAttached, expectedState === "attached");
  assert.equal(address.attachedTo || undefined, expectedState === "attached" ? spec.instanceName : undefined);
  assert.equal(raw.instances.nextPageToken, undefined);
  const hosts = raw.instances.instances?.filter(instance => instance.name === spec.instanceName);
  assert.equal(hosts?.length, expectedState === "absent" ? 0 : 1);
  const host = hosts[0];
  const outputs = pairs(stack.Outputs, "OutputKey", "OutputValue");
  assert.deepEqual(Object.keys(outputs).sort(), expectedState === "absent"
    ? ["ApplicationEnvironment", "GatewayIpv4"] : ["ApplicationEnvironment", "GatewayIpv4", "InstanceArn", "InstanceName"]);
  assert.equal(outputs.ApplicationEnvironment, "staging"); assert.equal(outputs.GatewayIpv4, spec.address);
  if (host) {
    assert.equal(host.bundleId, spec.parameters.BundleId); assert.equal(host.blueprintId, "ubuntu_24_04");
    assert.equal(host.sshKeyName, spec.parameters.KeyPairName); assert.equal(host.location?.availabilityZone, spec.parameters.AvailabilityZone);
    assert.equal(host.location?.regionName, spec.region); assert.equal(host.state?.name, expectedInstanceState);
    assert.match(host.arn, /^arn:aws:lightsail:us-east-1:691588646557:Instance\/[a-f0-9-]{36}$/u);
    assert.equal(outputs.InstanceArn, host.arn); assert.equal(outputs.InstanceName, spec.instanceName);
    if (legacy || expectedState === "detached") assert.equal(host.arn, spec.originalInstanceArn);
    if (expectedState === "attached") { assert.equal(host.isStaticIp, true); assert.equal(host.publicIpAddress, spec.address); }
    const ports = (raw.ports.portStates ?? []).map(port => ({ protocol: port.protocol, fromPort: port.fromPort,
      toPort: port.toPort, state: port.state, cidrs: [...(port.cidrs ?? [])].sort(), ipv6Cidrs: port.ipv6Cidrs ?? [], cidrListAliases: port.cidrListAliases ?? [] }));
    assert.deepEqual(ports.sort((a, b) => a.fromPort - b.fromPort), [
      { protocol: "tcp", fromPort: 22, toPort: 22, state: "open", cidrs: [spec.parameters.OperatorIpv4Cidr], ipv6Cidrs: [],
        cidrListAliases: spec.parameters.BrowserSshAccess === "true" ? ["lightsail-connect"] : [] },
      { protocol: "tcp", fromPort: 443, toPort: 443, state: "open", cidrs: ["0.0.0.0/0"], ipv6Cidrs: [], cidrListAliases: [] },
    ]);
  }
  return { status: "STAGING_INFRASTRUCTURE_STATE_VERIFIED", state: expectedState, stackId: spec.stackId,
    addressArn: address.arn, address: address.ipAddress, templateSha256: actualTemplateSha256,
    instanceArn: host?.arn ?? null, instanceCreatedAt: host?.createdAt ?? null, instanceIpv6Addresses: host?.ipv6Addresses ?? [],
    allocationPreserved: true, infrastructureChanged: false };
}

export function inspectValidationEvents(value, changeSet, spec) {
  assert.equal(value.NextToken, undefined);
  assert.ok(Array.isArray(value.OperationEvents) && value.OperationEvents.length > 0, "Complete service validation events required");
  let completed = false;
  for (const event of value.OperationEvents) {
    assert.equal(event.StackId, spec.stackId); assert.equal(event.OperationId, changeSet.ChangeSetId.split("/").at(-1));
    assert.equal(event.OperationType, "CREATE_CHANGESET");
    assert.ok(!/FAIL|ERROR/u.test([event.EventType, event.OperationStatus, event.ResourceStatus, event.HookStatus, event.ValidationStatus].filter(Boolean).join(" ")),
      "Service validation failure refused");
    if (event.EventType === "STACK_EVENT" && event.OperationStatus === "SUCCEEDED") completed = true;
  }
  assert.ok(completed, "Successful service validation event required");
  return { status: "STAGING_SERVICE_VALIDATION_PASSED", validationErrors: 0, changeSetId: changeSet.ChangeSetId };
}

export function verifyRetirementForInfrastructure(retired, candidateSha256) {
  assert.match(candidateSha256, /^[a-f0-9]{64}$/u);
  assert.equal(retired.status, "STAGING_RUNTIME_QUIESCED_FOR_RECREATION");
  assert.equal(retired.environment, "staging"); assert.equal(retired.originalHostMachineId, scope.originalMachineId);
  assert.equal(retired.candidateSha256, candidateSha256); assert.equal(retired.trafficAuthorized, false);
  for (const key of ["nativeSchedulesDisabled", "externalProducersSuspended", "publicIngressStopped", "hostTimersStopped"]) assert.equal(retired[key], true);
  assert.equal(retired.stoppedContainers?.length, 8);
  assert.equal(new Set(retired.stoppedContainers.map(c => c.containerId)).size, 8);
  assert.deepEqual(retired.stoppedContainers.map(c => c.service).sort(), ["gateway", "course-api", "course-tls", "course-publisher",
    "course-snapshot", "community-api", "community-tls", "community-worker"].sort());
  for (const c of retired.stoppedContainers) {
    assert.match(c.containerId, /^[a-f0-9]{64}$/u); assert.equal(c.running, false); assert.equal(c.exitCode, 0); assert.equal(c.oomKilled, false);
  }
}

export function infrastructureController({ spec, templateBody, aws, record, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  assert.deepEqual(stagingInfrastructureSpec(templateBody, spec.templateSha256, spec.addressArn), spec);
  assert.equal(typeof aws, "function"); assert.equal(typeof record, "function");
  const api = async (service, operation, params) => aws({ service, operation, region: spec.region, params });
  async function state(expectedState) {
    const identity = await api("sts", "GetCallerIdentity", {});
    assert.equal(identity.Account, spec.accountId, "Selected AWS account required before resource reads");
    const [stacks, resources, template, address, instances] = await Promise.all([
      api("cloudformation", "DescribeStacks", { StackName: spec.stackId }),
      api("cloudformation", "ListStackResources", { StackName: spec.stackId }), api("cloudformation", "GetTemplate", { StackName: spec.stackId }),
      api("lightsail", "GetStaticIp", { staticIpName: spec.addressName }), api("lightsail", "GetInstances", {}),
    ]);
    const ports = expectedState === "absent" ? {} : await api("lightsail", "GetInstancePortStates", { instanceName: spec.instanceName });
    return inspectInfrastructureState({ identity, stacks, resources, template, address, instances, ports }, spec, expectedState);
  }
  async function waitChangeSet(name) {
    const deadline = now() + 180_000;
    while (now() < deadline) {
      const value = await api("cloudformation", "DescribeChangeSet", { StackName: spec.stackId, ChangeSetName: name, IncludePropertyValues: true });
      if (["CREATE_PENDING", "CREATE_IN_PROGRESS"].includes(value.Status)) { await sleep(2000); continue; }
      assert.equal(value.Status, "CREATE_COMPLETE", "Change set did not complete"); return value;
    }
    throw new Error("STAGING_CHANGE_SET_OBSERVATION_TIMEOUT");
  }
  async function step(from, to, name, candidateSha256, retired) {
    verifyRetirementForInfrastructure(retired, candidateSha256);
    assert.match(name, /^p1-recreate-[a-z0-9-]{1,90}$/u);
    const before = await state(from);
    const intent = { from, to, changeSetName: name, candidateSha256, retirementCanonicalSha256: digest(JSON.stringify(retired)),
      stackId: spec.stackId, templateSha256: spec.templateSha256, disableAutomaticRollback: true };
    // Persist once before each provider mutation; neither an ambiguous create
    // nor execute response is automatically retried with a fresh request ID.
    await record(name + "-create-started", intent);
    const created = await api("cloudformation", "CreateChangeSet", { StackName: spec.stackId, ChangeSetName: name,
      ChangeSetType: "UPDATE", TemplateBody: templateBody, ClientToken: name + "-create",
      Parameters: Object.entries({ Environment: "staging", HostState: to, ...spec.parameters }).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })) });
    assert.equal(created.StackId, spec.stackId);
    assert.ok(created.Id?.startsWith(`arn:aws:cloudformation:${spec.region}:${spec.accountId}:changeSet/${name}/`));
    const change = await waitChangeSet(created.Id);
    const fetched = await api("cloudformation", "GetTemplate", { StackName: spec.stackId, ChangeSetName: created.Id });
    assert.equal(change.StackId, spec.stackId); assert.equal(change.ChangeSetId, created.Id);
    const actualBody = typeof fetched.TemplateBody === "string" ? fetched.TemplateBody : JSON.stringify(fetched.TemplateBody);
    const review = inspectHostLifecycleChangeSet(change, { ...spec, from, to }, actualBody);
    const events = await api("cloudformation", "DescribeEvents", { StackName: spec.stackId, ChangeSetName: created.Id });
    inspectValidationEvents(events, change, spec);
    await record(name + "-review", { ...review, serviceValidation: { validationErrors: 0 }, before });
    assert.deepEqual(await state(from), before, "Infrastructure changed during change-set review");
    await record(name + "-execute-started", { ...intent, changeSetId: created.Id });
    await api("cloudformation", "ExecuteChangeSet", { StackName: spec.stackId, ChangeSetName: created.Id,
      ClientRequestToken: name + "-execute", DisableRollback: true });
    const deadline = now() + 900_000;
    let complete = false;
    while (now() < deadline) {
      const observed = await api("cloudformation", "DescribeStacks", { StackName: spec.stackId });
      assert.equal(observed.Stacks?.length, 1); assert.equal(observed.Stacks[0].StackId, spec.stackId);
      const status = observed.Stacks[0].StackStatus;
      if (status === "UPDATE_COMPLETE") { complete = true; break; }
      assert.ok(["UPDATE_IN_PROGRESS", "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS"].includes(status), "Stack operation requires review");
      await sleep(3000);
    }
    assert.equal(complete, true, "STAGING_STACK_OBSERVATION_TIMEOUT");
    const after = await state(to);
    const result = { ...after, infrastructureChanged: true, changeSetId: created.Id };
    await record(name + "-completed", result);
    return result;
  }
  return { state, step };
}
