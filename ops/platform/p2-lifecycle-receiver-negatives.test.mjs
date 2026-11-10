import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertReceiverNegativeBaseline, deriveProfiledReceiverPostCommand, deriveReceiverNegativeCommand, postProfiledReceiverNegative,
  postReceiverNegative, validateReceiverPostInput, verifyLifecycleReceiverRuntime } from "./p2-lifecycle-receiver-post.mjs";
import { prepareP2LifecycleReceiverPlan, verifyReceiverNegativeReadback } from "./p2-lifecycle-receiver-negatives.mjs";
import { receiverWitnessFixture, receiverPostFixture, receiverReviewedFixture, receiverFixtureUuid } from "./p2-lifecycle-receiver-negatives.fixture.mjs";
import { p2LifecycleStateWitnessSha256 } from "./p2-lifecycle-state-witness.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const profiledPostFixture = (caseName, service) => {
  const fixture = receiverPostFixture(caseName, service);
  return { ...fixture, input: { ...fixture.input, version: 2, qualificationTargetProfile: profile } };
};

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
  assert.equal(plan.operatorSourceCommit, receiverReviewedFixture().persistence.plan.sources.frontend);
  assert.equal(plan.operatorSourceEligibility, "same-as-immutable-frontend-candidate");
  assert.equal(JSON.stringify(plan).includes(receiverWitnessFixture().userId), false);
  const changed = receiverReviewedFixture(); changed.quiescence = { held: true }; assert.throws(() => prepareP2LifecycleReceiverPlan(changed));
});

test("receiver reviewed source count accepts 512 and refuses 513 without weakening the source digest", () => {
  const reviewed = structuredClone(receiverReviewedFixture());
  const files = reviewed.operatorSourceFiles;
  while (Object.keys(files).length < 512) files[`ops/platform/count-bound-${Object.keys(files).length}.mjs`] = "a".repeat(64);
  reviewed.persistence.operatorSourceFiles = structuredClone(files);
  const bind = () => {
    reviewed.persistence.plan.operatorSourceSha256 = createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.keys(files).sort()
      .map(name => [name, files[name]])))).digest("hex");
  };
  bind(); prepareP2LifecycleReceiverPlan(reviewed);
  files["ops/platform/count-overflow.mjs"] = "b".repeat(64);
  reviewed.persistence.operatorSourceFiles = structuredClone(files); bind();
  assert.throws(() => prepareP2LifecycleReceiverPlan(reviewed));
});

test("even the private POST entry refuses a future gap without making a network request", async () => {
  const fixture = receiverPostFixture("future-gap"); let requests = 0;
  await assert.rejects(postReceiverNegative(fixture.input, { post: async () => { requests++; } }), /P2_LIFECYCLE_RECEIVER_REFUSED/u);
  assert.equal(requests, 0);
});

test("reviewed receiver envelopes derive all four commands for both services and refuse stale or caller-selected input", async () => {
  for (const service of ["course", "community"]) {
    for (const name of ["exact-replay", "changed-replay", "stale-restore", "future-gap"]) {
      const { input } = profiledPostFixture(name, service);
      const command = await deriveProfiledReceiverPostCommand(input, profile);
      assert.deepEqual(command, deriveReceiverNegativeCommand(input.witness, name, input.freshCommandId));
      assert.equal(command.accountVersion, input.witness.command.accountVersion + (name === "future-gap" ? 2 : 0));
    }
  }
  const { input } = profiledPostFixture("future-gap", "community");
  const mismatched = { ...profile, sha256: "a".repeat(64) };
  for (const tampered of [{ ...input, quiescent: true }, { ...input, origin: "https://foreign.invalid" }, { ...input, command: {} },
    { ...input, runtimeEnvironment: {} }, { ...input, qualificationTargetProfile: mismatched }, { ...input, freshCommandId: [input.freshCommandId] },
    { ...input, freshCommandId: input.witness.command.commandId }, { ...input, bindingSha256: "0".repeat(64) },
    { ...input, witness: { ...input.witness, frontend: { ...input.witness.frontend, pendingOrDeliveringCount: 1 } } }]) {
    await assert.rejects(deriveProfiledReceiverPostCommand(tampered, profile));
  }
  await assert.rejects(deriveProfiledReceiverPostCommand(input, mismatched));
  await assert.rejects(deriveProfiledReceiverPostCommand(input, undefined));
});

test("profiled private POST uses only the pinned TLS destinations and exact reviewed replies", async t => {
  let fixture, command, response, envelope;
  const readFile = fs.readFileSync;
  const files = t.mock.method(fs, "readFileSync", (path, ...args) => {
    if (path === "/config/gateway.json") return fixture.gateway;
    if (path === "/tls/ca.pem") return fixture.ca;
    return readFile(path, ...args);
  });
  const wire = t.mock.method(https, "request", (options, handleResponse) => {
    const { input, ca } = fixture;
    assert.deepEqual({ protocol: options.protocol, hostname: options.hostname, port: options.port, servername: options.servername,
      method: options.method, path: options.path, ca: options.ca, rejectUnauthorized: options.rejectUnauthorized, minVersion: options.minVersion },
    { protocol: "https:", hostname: input.service + "-tls", port: 8443, servername: input.service + "-tls", method: "POST",
      path: "/v1/internal/accounts/commands", ca, rejectUnauthorized: true, minVersion: "TLSv1.2" });
    const [header, payload, signature] = options.headers.authorization.slice("Bearer ".length).split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "HS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(payload, "base64url"));
    assert.equal(claims.iss, "lash-her-frontend");
    assert.equal(claims.aud, `lash-her-${input.service}-api:account-lifecycle`);
    assert.equal(claims.sub, "frontend-account-lifecycle");
    assert.equal(claims.exp - claims.iat, 120);
    assert.equal(signature, createHmac("sha256", input.secret).update(header + "." + payload).digest("base64url"));
    assert.equal(options.headers["x-idempotency-key"], command.commandId);
    const request = new EventEmitter();
    request.end = body => {
      assert.deepEqual(JSON.parse(body), envelope ?? command);
      assert.equal(options.headers["content-length"], String(body.length));
      const stream = Object.assign(new EventEmitter(), { statusCode: response.status, headers: response.headers });
      handleResponse(stream);
      stream.emit("data", Buffer.from(JSON.stringify(response.body)));
      stream.emit("end");
    };
    return request;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const service of ["course", "community"]) for (const name of ["exact-replay", "changed-replay", "stale-restore"]) {
    fixture = profiledPostFixture(name, service);
    const { input } = fixture;
    command = deriveReceiverNegativeCommand(input.witness, name, input.freshCommandId);
    const duplicate = name === "exact-replay";
    const code = duplicate ? "duplicate" : name === "changed-replay" ? "idempotency_conflict" : "account_version_conflict";
    response = { status: duplicate ? 200 : 409, headers: { "cache-control": "private, no-store" }, body: duplicate
      ? { commandId: command.commandId, accountVersion: command.accountVersion, status: "duplicate" }
      : { error: { code: service === "course" ? code.toUpperCase() : code, message: "Owned conflict" },
        ...(service === "community" ? { requestId: "owned-request" } : {}) } };
    const receipt = await postProfiledReceiverNegative(input, profile);
    assert.deepEqual(receipt, { version: 2, qualificationTargetProfile: profile, status: "P2_LIFECYCLE_RECEIVER_CASE_PASS", service, case: name,
      bindingSha256: input.bindingSha256, witnessSha256: p2LifecycleStateWitnessSha256(input.witness), httpStatus: response.status, result: code,
      domainStatePreservationRequiresReadback: true, globallyReadOnly: false, oidcVerified: false, releaseAccepted: false });
    for (const privateValue of [input.secret, command.userId, command.commandId, command.issuedAt, "owned-request"]) {
      assert.equal(JSON.stringify(receipt).includes(privateValue), false);
    }
  }
  assert.equal(wire.mock.callCount(), 6);
  const privateFileReads = () => files.mock.calls.filter(({ arguments: [path] }) => path === "/config/gateway.json" || path === "/tls/ca.pem").length;
  assert.equal(privateFileReads(), 12);
  for (const service of ["course", "community"]) {
    fixture = profiledPostFixture("future-gap", service);
    await assert.rejects(postProfiledReceiverNegative(fixture.input, profile), { check: "live-future-gap-quiescence-unproved" });
    await assert.rejects(postProfiledReceiverNegative({ ...fixture.input, quiescent: true }, profile), { check: "private-input-shape" });
  }
  assert.equal(wire.mock.callCount(), 6);
  assert.equal(privateFileReads(), 12);
  for (const service of ["course", "community"]) {
    fixture = profiledPostFixture("future-gap", service);
    const { input } = fixture;
    command = deriveReceiverNegativeCommand(input.witness, "future-gap", input.freshCommandId);
    const { accountVersion, commandId, canonicalSha256 } = input.witness.command;
    envelope = { version: 2, command, expectedHead: { accountVersion, commandId, canonicalSha256 } };
    const course = service === "course";
    const errorBody = code => ({ error: { code: course ? code.toUpperCase() : code, message: "Owned conflict" },
      ...(course ? {} : { requestId: "owned-request" }) });
    response = { status: 409, headers: { "cache-control": "private, no-store" }, body: errorBody("account_version_conflict") };
    const receipt = await postProfiledReceiverNegative(input, profile, true);
    assert.equal(receipt.result, "account_version_conflict");
    assert.equal(receipt.case, "future-gap");
    response.body = errorBody("account_head_changed");
    await assert.rejects(postProfiledReceiverNegative(input, profile, true), { check: "exact-conflict-receipt-required" });
    response.status = 400;
    response.body = errorBody("bad_request");
    await assert.rejects(postProfiledReceiverNegative(input, profile, true), { check: "exact-http-status-required" });
  }
  assert.equal(wire.mock.callCount(), 12);
});

test("the actual private stdin entry selects v2 only from the fixed launcher and emits no private inputs", () => {
  const childUrl = new URL("./p2-lifecycle-receiver-post.mjs", import.meta.url).href;
  const run = (raw, expectedProfile, environment = {}) => {
    const entry = `import(${JSON.stringify(childUrl)}).then(module=>module.runPrivateReceiverPostFromStdin(${JSON.stringify(expectedProfile) ?? ""}))`;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", entry],
      { input: raw, encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, ...environment } });
    assert.equal(child.stderr, "");
    assert.equal(child.stdout.includes("OWNED-PRIVATE"), false);
    return { status: child.status, record: JSON.parse(child.stdout) };
  };
  for (const service of ["course", "community"]) {
    const runtimeEnvironment = { DATABASE_TARGET: "staging", STAGING_DATABASE_URL: "OWNED-PRIVATE-DATABASE",
      [service.toUpperCase() + "_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET"]: "OWNED-PRIVATE-KEY".repeat(4) };
    const environment = { ...runtimeEnvironment, NODE_ENV: "production" };
    const input = { version: 2, qualificationTargetProfile: profile, mode: "runtime-binding", environment: "staging", service,
      bindingSha256: "a".repeat(64), runtimeEnvironment };
    assert.deepEqual(run(JSON.stringify(input), profile, environment), { status: 0, record: { version: 2,
      qualificationTargetProfile: profile, status: "P2_LIFECYCLE_RECEIVER_RUNTIME_BOUND", service, bindingSha256: input.bindingSha256,
      runtimeConfigurationVerified: true, globallyReadOnly: true, releaseAccepted: false } });
    assert.equal(run(JSON.stringify(input), undefined, environment).record.version, 1);
    const legacy = { ...input };
    delete legacy.qualificationTargetProfile;
    assert.equal(run(JSON.stringify({ ...legacy, version: 1 }), profile, environment).status, 1);
    const duplicate = JSON.stringify(input).replace('"version":2', '"version":2,"version":2');
    const oversized = "x".repeat(262145);
    const { input: gap } = profiledPostFixture("future-gap", service);
    for (const [raw, check] of [[duplicate, "private-receiver-case-failed"], [oversized, "private-input-bound"],
      [JSON.stringify(gap), "live-future-gap-quiescence-unproved"]]) {
      assert.deepEqual(run(raw, profile, environment), { status: 1, record: { version: 2, qualificationTargetProfile: profile,
        status: "P2_LIFECYCLE_RECEIVER_CASE_FAILED", check, globallyReadOnly: false, oidcVerified: false, releaseAccepted: false } });
    }
  }
});

test("corrected reader context requires host identity, recomputed targets, immutable images and the same full source map", () => {
  for (const mutate of [row => { delete row.persistence.plan.hostMachineId; }, row => { row.persistence.plan.targets.course.targetSha256 = "f".repeat(64); },
    row => { row.persistence.plan.containerImages.course = "sha256:" + "6".repeat(64); }, row => { row.persistence.operatorFiles = {}; },
    row => { row.operatorSourceFiles = { ...row.operatorSourceFiles, "ops/platform/foreign.mjs": "e".repeat(64) }; },
    row => { row.persistence.plan.operatorSourceSha256 = "f".repeat(64); }]) {
    const fixture = structuredClone(receiverReviewedFixture()); mutate(fixture); assert.throws(() => prepareP2LifecycleReceiverPlan(fixture));
  }
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
