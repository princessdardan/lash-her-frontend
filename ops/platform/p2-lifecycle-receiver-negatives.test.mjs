import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertReceiverNegativeBaseline, deriveReceiverNegativeCommand, postReceiverNegative, validateReceiverPostInput, verifyLifecycleReceiverRuntime } from "./p2-lifecycle-receiver-post.mjs";
import { prepareP2LifecycleReceiverPlan, verifyReceiverNegativeReadback } from "./p2-lifecycle-receiver-negatives.mjs";
import { receiverWitnessFixture, receiverPostFixture, receiverReviewedFixture, receiverFixtureUuid } from "./p2-lifecycle-receiver-negatives.fixture.mjs";

test("source-derived fixed cases do not accept a caller command, action, version or URL", () => {
  const witness = receiverWitnessFixture(), original = deriveReceiverNegativeCommand(witness, "exact-replay");
  assert.equal(original.commandId, witness.command.commandId); assert.equal(original.action, "suspend");
  assert.deepEqual(deriveReceiverNegativeCommand(witness, "changed-replay"), { ...original, action: "restore" });
  assert.deepEqual(deriveReceiverNegativeCommand(witness, "stale-restore", receiverFixtureUuid(20)), { ...original, action: "restore", commandId: receiverFixtureUuid(20) });
  assert.equal(deriveReceiverNegativeCommand(witness, "future-gap", receiverFixtureUuid(20)).accountVersion, 3);
  for (const mutate of [input => { input.origin = "https://foreign.invalid"; }, input => { input.command = original; }, input => { input.service = "other"; },
    input => { input.environment = "production"; }, input => { input.case = "restore"; }, input => { input.freshCommandId = witness.command.commandId; }]) {
    const { input } = receiverPostFixture(); mutate(input); assert.throws(() => validateReceiverPostInput(input));
  }
});

test("pending, changed, mismatched or non-head state refuses before issuing a POST", async () => {
  for (const mutate of [value => { value.frontend.pendingOrDeliveringCount = 1; }, value => { value.frontend.laterCommandCount = 1; },
    value => { value.receivers.course.status = "active"; }, value => { value.frontend.deliveries[1].status = "pending"; },
    value => { value.command.canonicalSha256 = "f".repeat(64); }, value => { value.frontend.latestCommandId = receiverFixtureUuid(22); }]) {
    const fixture = receiverPostFixture(); mutate(fixture.input.witness); let requests = 0;
    await assert.rejects(postReceiverNegative(fixture.input, { post: async () => { requests++; } })); assert.equal(requests, 0);
  }
});

test("only exact duplicate/409 conflict schemas with private no-store count", async () => {
  for (const service of ["course", "community"]) for (const caseName of ["exact-replay", "changed-replay", "stale-restore"]) {
    const { input, gateway, ca } = receiverPostFixture(caseName, service);
    const command = deriveReceiverNegativeCommand(input.witness, caseName, input.freshCommandId), duplicate = caseName === "exact-replay";
    const code = caseName === "changed-replay" ? "idempotency_conflict" : "account_version_conflict";
    const response = { status: duplicate ? 200 : 409, headers: { "cache-control": "private, no-store" }, body: duplicate
      ? { commandId: command.commandId, accountVersion: command.accountVersion, status: "duplicate" }
      : { error: { code: service === "course" ? code.toUpperCase() : code, message: "Conflict" }, ...(service === "community" ? { requestId: "owned-request" } : {}) } };
    const options = { readGateway: () => gateway, readCa: () => ca, post: async (selected, actual, token) => {
      assert.equal(selected, service); assert.deepEqual(actual, command); assert.equal(token.split(".").length, 3); return response; } };
    const receipt = await postReceiverNegative(input, options); assert.equal(receipt.httpStatus, response.status);
    for (const mutate of [value => { value.status = 401; }, value => { value.headers["cache-control"] = "public"; }, value => { value.body.extra = true; }]) {
      const changed = structuredClone(response); mutate(changed);
      await assert.rejects(postReceiverNegative(input, { ...options, post: async () => changed }));
    }
    const raw = JSON.stringify(receipt);
    for (const secret of [input.secret, input.witness.userId, command.commandId, command.issuedAt]) assert.equal(raw.includes(secret), false);
  }
});

test("every account/domain snapshot must remain identical; quota tables are outside the witness", () => {
  const before = receiverWitnessFixture(); assertReceiverNegativeBaseline(before);
  assert.equal(verifyReceiverNegativeReadback(before, structuredClone(before), "course", "exact-replay").accountAndDomainStateUnchanged, true);
  for (const mutate of [value => { value.domainSnapshots.course.digest = "e".repeat(64); }, value => { value.receivers.community.commandCount++; },
    value => { value.frontend.deliveries[0].attempts++; }]) {
    const after = structuredClone(before); mutate(after); assert.throws(() => verifyReceiverNegativeReadback(before, after, "course", "exact-replay"));
  }
});

test("plan leaves the live future gap OPEN and exposes no command or credential", () => {
  const plan = prepareP2LifecycleReceiverPlan(receiverReviewedFixture());
  assert.equal(plan.cases.length, 6); assert.equal(plan.openCases.length, 2); assert.ok(plan.openCases.every(row => row.status === "OPEN"));
  assert.equal(plan.networkCalled, false); assert.equal(plan.admissionChangesAuthorized, false);
  assert.equal(JSON.stringify(plan).includes(receiverWitnessFixture().userId), false);
  const changed = receiverReviewedFixture(); changed.quiescence = { held: true }; assert.throws(() => prepareP2LifecycleReceiverPlan(changed));
});

test("even the private POST entry refuses a future gap without making a network request", async () => {
  const fixture = receiverPostFixture("future-gap"); let requests = 0;
  await assert.rejects(postReceiverNegative(fixture.input, { post: async () => { requests++; } }), /P2_LIFECYCLE_RECEIVER_REFUSED/u);
  assert.equal(requests, 0);
});

test("runtime binding requires actual staging configuration and dedicated service key", () => {
  const runtimeEnvironment = { DATABASE_TARGET: "staging", STAGING_DATABASE_URL: "owned-private-placeholder", COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET: "owned-synthetic-secret".repeat(4) };
  const input = { version: 1, mode: "runtime-binding", environment: "staging", service: "course", bindingSha256: "a".repeat(64), runtimeEnvironment };
  assert.equal(verifyLifecycleReceiverRuntime(input, { ...runtimeEnvironment, NODE_ENV: "production" }).runtimeConfigurationVerified, true);
  for (const environment of [{ ...runtimeEnvironment, NODE_ENV: "test" }, { ...runtimeEnvironment, NODE_ENV: "production", DATABASE_TARGET: "prod" },
    { ...runtimeEnvironment, NODE_ENV: "production", COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET: "wrong" }]) assert.throws(() => verifyLifecycleReceiverRuntime(input, environment));
});

test("actual composed private program sanitizes malformed/oversized packets", () => {
  const host = fileURLToPath(new URL("./host/", import.meta.url)), root = fileURLToPath(new URL("../../", import.meta.url));
  const script = "import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import p2_lifecycle_receiver_negative as p;sys.stdout.buffer.write(p.private_program(Path(sys.argv[2])))";
  const composed = spawnSync("python3", ["-I", "-B", "-c", script, host, root], { encoding: "utf8", timeout: 10000 });
  assert.equal(composed.status, 0, composed.stderr);
  for (const raw of ["PRIVATE-MARKER", JSON.stringify({ secret: "PRIVATE-MARKER" }), "x".repeat(270000)]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", composed.stdout], { input: raw, encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH } });
    assert.equal(child.status, 1, child.stderr); assert.equal(child.stderr, ""); assert.equal(child.stdout.includes("PRIVATE-MARKER"), false);
    assert.equal(JSON.parse(child.stdout).status, "P2_LIFECYCLE_RECEIVER_CASE_FAILED");
  }
});
