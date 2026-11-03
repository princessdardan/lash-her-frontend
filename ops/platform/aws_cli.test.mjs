import assert from "node:assert/strict";
import test from "node:test";
import { operatorAwsCli } from "./aws_cli.mjs";

const stack = "arn:aws:cloudformation:us-east-1:691588646557:stack/lash-her-api-staging/43564e90-d6f4-11f1-825b-12ffd9c5e733";
test("operator AWS fallback binds profile/region and removes ambient credentials and SDK retries", async () => {
  const calls = [];
  const aws = operatorAwsCli({ binary: "/opt/homebrew/bin/aws", environment: { PATH: "/bin", HOME: "/owned", AWS_SECRET_ACCESS_KEY: "must-not-inherit", AWS_CONFIG_FILE: "/other" },
    execute: async (...args) => { calls.push(args); return { stdout: '{"Stacks":[]}' }; } });
  await aws({ service: "cloudformation", operation: "DescribeStacks", region: "us-east-1", params: { StackName: stack } });
  const [, args, options] = calls[0];
  assert.equal(args[1], "Dardan (Lash Her)"); assert.equal(args[3], "us-east-1");
  assert.equal(options.env.AWS_MAX_ATTEMPTS, "1"); assert.equal(options.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(options.env.AWS_CONFIG_FILE, undefined); assert.equal(options.env.HOME, "/owned");
});

test("unsupported APIs, production stacks and unreviewed parameters never reach AWS", async () => {
  const aws = operatorAwsCli({ binary: "/opt/homebrew/bin/aws", execute: async () => assert.fail("AWS called") });
  for (const request of [
    { service: "cloudformation", operation: "DeleteStack", params: { StackName: stack } },
    { service: "cloudformation", operation: "DescribeStacks", params: { StackName: stack.replace("staging", "production") } },
    { service: "cloudformation", operation: "ExecuteChangeSet", params: { StackName: stack, DisableRollback: false } },
    { service: "lightsail", operation: "GetInstances", params: { unexpected: true } },
  ]) await assert.rejects(aws({ ...request, region: "us-east-1" }));
});

test("SSH trust lookup projects public metadata without returning temporary credentials", async () => {
  let args;
  const response = { instanceName: "lash-her-api-staging-host", ipAddress: "184.196.129.231", username: "ubuntu", protocol: "ssh", hostKeys: [] };
  const aws = operatorAwsCli({ binary: "/opt/homebrew/bin/aws", execute: async (_binary, values) => { args = values; return { stdout: JSON.stringify(response) }; } });
  assert.deepEqual(await aws({ service: "lightsail", operation: "GetInstanceAccessDetails", region: "us-east-1", params: { instanceName: response.instanceName, protocol: "ssh" } }), response);
  const query = args[args.indexOf("--query") + 1];
  assert.ok(query.includes("hostKeys")); assert.ok(!query.includes("privateKey")); assert.ok(!query.includes("certKey"));
  response.privateKey = "must-not-return";
  await assert.rejects(aws({ service: "lightsail", operation: "GetInstanceAccessDetails", region: "us-east-1", params: { instanceName: response.instanceName, protocol: "ssh" } }));
});

test("an empty execute acknowledgement is accepted once; arbitrary errors stay sanitized", async () => {
  let count = 0;
  const aws = operatorAwsCli({ binary: "/opt/homebrew/bin/aws", execute: async () => { count++; return { stdout: "" }; } });
  assert.deepEqual(await aws({ service: "cloudformation", operation: "ExecuteChangeSet", region: "us-east-1", params: { StackName: stack, DisableRollback: true } }), {});
  assert.equal(count, 1);
  const failing = operatorAwsCli({ binary: "/opt/homebrew/bin/aws", execute: async () => { throw new Error("private-error-payload"); } });
  await assert.rejects(failing({ service: "sts", operation: "GetCallerIdentity", region: "us-east-1", params: {} }), /^Error: AWS_OPERATOR_OPERATION_REFUSED$/u);
});
