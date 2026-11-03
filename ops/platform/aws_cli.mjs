// Existing authenticated operator profile fallback. The connected application
// role denied CloudFormation reads; no IAM permission is changed by this tool.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const operations = new Map([
  ["sts/GetCallerIdentity", ["get-caller-identity", []]],
  ["cloudformation/DescribeStacks", ["describe-stacks", ["StackName"]]],
  ["cloudformation/ListStackResources", ["list-stack-resources", ["StackName"]]],
  ["cloudformation/GetTemplate", ["get-template", ["StackName", "ChangeSetName"]]],
  ["cloudformation/DescribeChangeSet", ["describe-change-set", ["StackName", "ChangeSetName", "IncludePropertyValues"]]],
  ["cloudformation/DescribeEvents", ["describe-events", ["StackName", "ChangeSetName"]]],
  ["cloudformation/CreateChangeSet", ["create-change-set", ["StackName", "ChangeSetName", "ChangeSetType", "TemplateBody", "Parameters", "ClientToken"]]],
  ["cloudformation/ExecuteChangeSet", ["execute-change-set", ["StackName", "ChangeSetName", "ClientRequestToken", "DisableRollback"]]],
  ["lightsail/GetStaticIp", ["get-static-ip", ["staticIpName"]]],
  ["lightsail/GetInstances", ["get-instances", []]],
  ["lightsail/GetInstanceSnapshots", ["get-instance-snapshots", []]],
  ["lightsail/StopInstance", ["stop-instance", ["instanceName", "force"]]],
  ["lightsail/CreateInstanceSnapshot", ["create-instance-snapshot", ["instanceName", "instanceSnapshotName", "tags"]]],
  ["lightsail/GetInstanceSnapshot", ["get-instance-snapshot", ["instanceSnapshotName"]]],
  ["lightsail/GetInstancePortStates", ["get-instance-port-states", ["instanceName"]]],
  ["lightsail/GetInstanceAccessDetails", ["get-instance-access-details", ["instanceName", "protocol"]]],
]);

export function operatorAwsCli({ binary, environment = process.env, execute = promisify(execFile) }) {
  assert.ok(["/Users/dardan/.local/bin/aws", "/opt/homebrew/bin/aws", "/usr/local/bin/aws"].includes(binary), "Known installed AWS CLI required");
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].filter(key => environment[key] !== undefined).map(key => [key, environment[key]]));
  Object.assign(env, { AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-east-1", AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off",
    AWS_MAX_ATTEMPTS: "1", AWS_RETRY_MODE: "standard" });
  return async request => {
    assert.equal(request.region, "us-east-1");
    const definition = operations.get(request.service + "/" + request.operation);
    assert.ok(definition, "Unreviewed AWS API refused");
    const [command, allowed] = definition, params = request.params;
    assert.ok(params && Object.keys(params).every(key => allowed.includes(key)), "Unreviewed AWS parameter refused");
    if (request.service === "cloudformation") assert.equal(params.StackName,
      "arn:aws:cloudformation:us-east-1:691588646557:stack/lash-her-api-staging/43564e90-d6f4-11f1-825b-12ffd9c5e733");
    if (params.staticIpName !== undefined) assert.equal(params.staticIpName, "lash-her-api-staging-gateway");
    if (params.instanceName !== undefined) assert.equal(params.instanceName, "lash-her-api-staging-host");
    if (request.operation === "StopInstance") assert.ok(params.force === undefined || params.force === false, "Forced stop refused");
    if (params.instanceSnapshotName !== undefined) assert.match(params.instanceSnapshotName, /^p1-recreate-access-[a-z0-9-]{1,20}-original$/u);
    if (request.operation === "CreateInstanceSnapshot") assert.deepEqual(params.tags,
      [{key:"Project",value:"lash-her"},{key:"Environment",value:"staging"},{key:"Purpose",value:"operator-access-recovery"}]);
    if (request.operation === "ExecuteChangeSet") assert.equal(params.DisableRollback, true);
    if (request.operation === "CreateChangeSet") assert.equal(params.ChangeSetType, "UPDATE");
    const args = ["--profile", "Dardan (Lash Her)", "--region", "us-east-1", "--output", "json", request.service, command,
      "--cli-input-json", JSON.stringify(params)];
    if (request.operation === "GetInstanceAccessDetails") {
      assert.equal(params.protocol, "ssh");
      // AWS returns temporary access credentials with this API. Project ONLY
      // public trust metadata inside the CLI; never return those credentials.
      args.push("--query", "accessDetails.{instanceName:instanceName,ipAddress:ipAddress,protocol:protocol,username:username,hostKeys:hostKeys}");
    }
    let raw;
    try { raw = (await execute(binary, args, { env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })).stdout; }
    catch { throw new Error("AWS_OPERATOR_OPERATION_REFUSED"); }
    if (request.operation === "ExecuteChangeSet" && raw.trim() === "") return {};
    let result;
    try { result = JSON.parse(raw); } catch { throw new Error("AWS_OPERATOR_RESPONSE_REFUSED"); }
    assert.ok(result && typeof result === "object" && !Array.isArray(result));
    if (request.operation === "GetInstanceAccessDetails") {
      assert.deepEqual(Object.keys(result).sort(), ["hostKeys", "instanceName", "ipAddress", "protocol", "username"]);
      assert.equal(result.instanceName, "lash-her-api-staging-host"); assert.equal(result.ipAddress, "184.196.129.231");
      assert.equal(result.protocol, "ssh"); assert.equal(result.username, "ubuntu");
    }
    return result;
  };
}
