// Private owned process only. IPC is never installed as an application route.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer, request } from "node:https";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildP2LifecycleStateWitness, observePersistenceDomain } from "../p2-lifecycle-persistence-probe.mjs";
import { createReceiverPrivateTlsPost, postReceiverNegative, deriveReceiverNegativeCommand } from "../p2-lifecycle-receiver-post.mjs";
import { verifyReceiverNegativeReadback } from "../p2-lifecycle-receiver-negatives.mjs";
import { p2LifecycleStateWitnessSha256 } from "../p2-lifecycle-state-witness.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "../qualification-target-profile.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const receiverPath = "/v1/internal/accounts/commands";
const services = ["course", "community"];
function sign(service, secret) {
  const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = encode({ alg: "HS256", typ: "JWT" }) + "." + encode({ iss: "lash-her-frontend", aud: `lash-her-${service}-api:account-lifecycle`,
    sub: "frontend-account-lifecycle", iat: now, exp: now + 120, jti: randomUUID() });
  return body + "." + createHmac("sha256", secret).update(body).digest("base64url");
}

function profiledChildProgram(guardedFutureGap = false) {
  const source = fileURLToPath(new URL("../../../", import.meta.url));
  const compose = "import sys;from pathlib import Path;root=Path(sys.argv[1]);sys.path.insert(0,str(root/'ops/platform/host'));"
    + "import p2_lifecycle_receiver_negative as receiver;from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile;"
    + "sys.stdout.buffer.write(receiver.private_program(root,profile,guarded_future_gap=sys.argv[2]=='true'))";
  return execFileSync("python3", ["-I", "-B", "-c", compose, source, String(guardedFutureGap)], { encoding: "utf8", env: { PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 131071, timeout: 10_000 });
}

function runProfiledChild(program, payload, gateway, ca, ports, expectedGuardedWireSha256 = null) {
  // Only this owned process supplies the preload. The actual composed child
  // still checks fixed paths, TLS names, SNI and trust before sending.
  const preload = `
    import assert from "node:assert/strict";
    import { createHash } from "node:crypto";
    import fs from "node:fs";
    import https from "node:https";
    import { syncBuiltinESMExports } from "node:module";
    const gateway = Buffer.from(${JSON.stringify(gateway.toString("base64"))}, "base64");
    const ca = Buffer.from(${JSON.stringify(Buffer.from(ca).toString("base64"))}, "base64");
    const ports = ${JSON.stringify(ports)};
    const expectedGuardedWireSha256 = ${JSON.stringify(expectedGuardedWireSha256)};
    const readFile = fs.readFileSync, request = https.request;
    fs.readFileSync = (path, ...args) => {
      if (path === "/config/gateway.json") return gateway;
      if (path === "/tls/ca.pem") return ca;
      return readFile(path, ...args);
    };
    https.request = (options, response) => {
      assert.equal(options.protocol, "https:");
      assert.ok(Object.hasOwn(ports, options.hostname));
      assert.equal(options.servername, options.hostname);
      assert.equal(options.port, 8443);
      assert.equal(options.method, "POST");
      assert.equal(options.path, ${JSON.stringify(receiverPath)});
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.minVersion, "TLSv1.2");
      assert.deepEqual(options.ca, ca);
      const outbound = request({ ...options, hostname: "127.0.0.1", port: ports[options.hostname] }, response);
      if (expectedGuardedWireSha256 !== null) {
        const end = outbound.end;
        outbound.end = function (body, ...args) {
          assert.ok(Buffer.isBuffer(body));
          assert.equal(createHash("sha256").update(body).digest("hex"), expectedGuardedWireSha256);
          assert.equal(options.headers["x-idempotency-key"], JSON.parse(body).command.commandId);
          return end.call(this, body, ...args);
        };
      }
      return outbound;
    };
    syncBuiltinESMExports();
  `;
  const preloadUrl = "data:text/javascript;base64," + Buffer.from(preload).toString("base64");
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ["--import", preloadUrl, "--input-type=module", "--eval", program],
      { env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10_000, maxBuffer: 8192 }, (error, stdout, stderr) => {
        const exitCode = error?.code ?? 0;
        if (stderr || ![0, 1].includes(exitCode)) return reject(new Error("OWNED_PROFILED_RECEIVER_CHILD_FAILED"));
        try { resolve({ exitCode, receipt: JSON.parse(stdout) }); }
        catch { reject(new Error("OWNED_PROFILED_RECEIVER_CHILD_OUTPUT_INVALID")); }
      });
    child.stdin.once("error", () => reject(new Error("OWNED_PROFILED_RECEIVER_STDIN_FAILED")));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function rehearseProfiledReceivers(input, gateway, observe, apis, servers, posts, guardedMode) {
  const program = profiledChildProgram();
  const guardedProgram = guardedMode ? profiledChildProgram(true) : null;
  const ports = Object.fromEntries(services.map(service => [service + "-tls", apis[service].port]));
  const ca = Buffer.from(input.ca);
  const runCase = async (service, caseName, casePorts, responseLost = false) => {
    const guarded = caseName === "future-gap";
    const before = await observe(), freshCommandId = guarded || caseName === "stale-restore" ? randomUUID() : null;
    const requireAbsent = state => {
      if (freshCommandId) assert.ok(Object.values(state.observations).every(row => row.commands.every(command => command.command_id !== freshCommandId)));
    };
    requireAbsent(before);
    const prior = { ...posts };
    const payload = { version: 2, qualificationTargetProfile: profile, environment: "staging", mode: "post", service, case: caseName,
      bindingSha256: hash("owned-profiled-receiver-wire"), witness: before.witness, freshCommandId, secret: input.keys[service],
      gatewayConfigurationSha256: hash(gateway), gatewayCaSha256: hash(ca) };
    let expectedGuardedWireSha256 = null;
    if (guarded) {
      assert.ok(guardedProgram);
      const { commandId, accountVersion, canonicalSha256, issuedAt } = before.witness.command;
      const wire = { version: 2, command: { version: 1, commandId: freshCommandId, userId: before.witness.userId,
        accountVersion: accountVersion + 2, action: "suspend", issuedAt }, expectedHead: { commandId, accountVersion, canonicalSha256 } };
      const canonicalWire = JSON.stringify(wire, (_key, value) => value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
      expectedGuardedWireSha256 = hash(canonicalWire);
    }
    const result = await runProfiledChild(guarded ? guardedProgram : program, payload, gateway, ca, casePorts, expectedGuardedWireSha256);
    assert.deepEqual(posts, { ...prior, [service]: prior[service] + 1 });
    const after = await observe();
    verifyReceiverNegativeReadback(before.witness, after.witness, service, caseName, freshCommandId);
    requireAbsent(after);
    const witnessSha256 = p2LifecycleStateWitnessSha256(before.witness);
    const duplicate = caseName === "exact-replay";
    const httpStatus = duplicate ? 200 : 409;
    const outcome = duplicate ? "duplicate" : caseName === "changed-replay" ? "idempotency_conflict" : "account_version_conflict";
    const identity = { version: 2, qualificationTargetProfile: profile };
    const disposition = { globallyReadOnly: false, oidcVerified: false, releaseAccepted: false };
    const expected = responseLost ? { ...identity, status: "P2_LIFECYCLE_RECEIVER_CASE_FAILED", check: "private-https-failed", ...disposition }
      : { ...identity, status: "P2_LIFECYCLE_RECEIVER_CASE_PASS", service, case: caseName, bindingSha256: payload.bindingSha256,
        witnessSha256, httpStatus, result: outcome, domainStatePreservationRequiresReadback: true, ...disposition };
    assert.deepEqual(result, { exitCode: responseLost ? 1 : 0, receipt: expected }, `${service} ${caseName} child receipt mismatch`);
    return { service, case: caseName, actualPostCount: 1, accountAndDomainStateUnchanged: true,
      ...(guarded && { expectedHeadBound: true, accountVersionOffset: 2, refusedCommandAbsent: true }),
      ...(responseLost ? { childStatus: expected.status, check: expected.check, refusedCommandAbsent: true } : { httpStatus, result: outcome }) };
  };
  const cases = [];
  for (const service of services) {
    for (const name of ["exact-replay", "changed-replay", "stale-restore"]) cases.push(await runCase(service, name, ports));
  }
  const forwarded = { calls: 0, completed: 0, responseSent: false, response: null, failed: false };
  const proxy = createServer({ key: input.httpsKey, cert: input.httpsCertificate }, (incoming, outgoing) => {
    forwarded.calls++;
    const upstream = request({ protocol: "https:", hostname: "127.0.0.1", port: ports["course-tls"], servername: "course-tls",
      method: incoming.method, path: incoming.url, headers: incoming.headers, ca, rejectUnauthorized: true, minVersion: "TLSv1.2" }, received => {
      const chunks = [];
      received.on("data", chunk => chunks.push(chunk));
      received.once("error", () => { forwarded.failed = true; incoming.socket.destroy(); });
      received.once("end", () => {
        forwarded.completed++;
        forwarded.response = { status: received.statusCode, body: Buffer.concat(chunks).toString(), cache: received.headers["cache-control"] };
        forwarded.responseSent ||= outgoing.headersSent;
        incoming.socket.destroy();
      });
    });
    upstream.once("error", () => { forwarded.failed = true; incoming.socket.destroy(); });
    incoming.pipe(upstream);
  });
  await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  servers.push(proxy);
  const responseLoss = await runCase("course", "stale-restore", { ...ports, "course-tls": proxy.address().port }, true);
  assert.equal(forwarded.calls, 1);
  assert.equal(forwarded.completed, 1);
  assert.equal(forwarded.failed, false);
  assert.equal(forwarded.responseSent, false);
  assert.equal(forwarded.response.status, 409);
  assert.match(forwarded.response.cache, /private, no-store/iu);
  assert.equal(JSON.parse(forwarded.response.body).error.code, "ACCOUNT_VERSION_CONFLICT");
  const guardedFutureGap = guardedProgram === null ? null : { programSha256: hash(guardedProgram), cases: [] };
  if (guardedFutureGap) {
    assert.notEqual(guardedFutureGap.programSha256, hash(program));
    for (const service of services) guardedFutureGap.cases.push(await runCase(service, "future-gap", ports));
  }
  return { qualificationTargetProfile: profile, programSha256: hash(program), cases,
    responseLoss: { ...responseLoss, receiverHttpStatus: forwarded.response.status, responseForwarded: false },
    ...(guardedFutureGap && { guardedFutureGap }) };
}

async function run(input) {
  const clients = [], pools = [], apps = [], servers = [];
  const guardedMode = process.env.P2_LIFECYCLE_RECEIVER_GUARDED_OWNED_TEST === "true";
  const userId = randomUUID(), commandId = randomUUID(), issuedAt = new Date().toISOString();
  const command = { version: 1, commandId, userId, accountVersion: 1, action: "suspend", issuedAt };
  const admin = {}, readers = {}, apis = {}, checks = [], httpReceipts = [], posts = { course: 0, community: 0 };
  try {
    for (const service of ["frontend", "course", "community"]) {
      assert.equal(input.databases[service].host, "localhost"); assert.match(input.databases[service].database, /^owned_receiver_(frontend|course|community)$/u);
      const require = createRequire(join(input.sources[service], "package.json")), { Client, Pool } = require("pg");
      const tls = { ssl: { rejectUnauthorized: true, ca: input.ca, servername: "localhost" }, enableChannelBinding: true };
      admin[service] = new Client({ ...input.databases[service], user: "receiver_admin", password: undefined, ...tls, options: "-c search_path=public" });
      readers[service] = new Client({ ...input.databases[service], ...tls, options: "-c search_path=pg_catalog,public -c default_transaction_read_only=on" });
      for (const client of [admin[service], readers[service]]) { clients.push(client); client.on("error", () => {}); await client.connect(); assert.equal(client.connection.stream.authorized, true); }
      if (service === "frontend") continue;
      const pool = new Pool({ ...input.databases[service], ...tls, max: 4, options: "-c search_path=public" }); pools.push(pool);
      const load = path => import(pathToFileURL(join(input.sources[service], path)).href);
      const { drizzle } = require("drizzle-orm/node-postgres"), schema = await load("src/db/schema.ts"), db = drizzle(pool, { schema });
      const repository = (await load("src/accounts/lifecycle-repository.ts")).createAccountLifecycleRepository(db);
      const verifier = (await load("src/accounts/lifecycle-auth.ts")).createAccountLifecycleVerifier({ currentSecret: input.keys[service] });
      const options = { accountLifecycle: { repository, authVerifier: verifier,
        ...(guardedMode && { allowSequenceGapVerification: true }) } };
      if (service === "course") options.accountLifecycle.rateLimit = { maxPerMinute: 1000, burst: 1000, scope: "owned-account-lifecycle",
        store: new (await load("src/rate-limit/drizzle-rate-limit-store.ts")).DrizzleRateLimitStore(db) };
      else options.accountLifecycle.rateLimitStore = (await load("src/http/shared-rate-limit.ts")).createSharedRateLimitStore(db);
      const app = await (await load("src/app.ts")).buildApp(options); apps.push(app); await app.ready();
      const server = createServer({ key: input.httpsKey, cert: input.httpsCertificate }, (incoming, outgoing) => {
        if (incoming.method === "POST" && incoming.url === receiverPath) posts[service]++;
        app.routing(incoming, outgoing);
      });
      servers.push(server);
      await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
      apis[service] = { port: server.address().port, app, pool };
    }
    const post = createReceiverPrivateTlsPost(input.ca, (options, handler) => {
      assert.equal(options.hostname, options.servername); assert.ok(["course-tls", "community-tls"].includes(options.hostname));
      assert.equal(options.path, "/v1/internal/accounts/commands"); assert.equal(options.port, 8443); assert.equal(options.rejectUnauthorized, true);
      return request({ ...options, hostname: "127.0.0.1", port: apis[options.hostname === "course-tls" ? "course" : "community"].port }, handler);
    });
    await admin.frontend.query("insert into customer_users(id,email,status,account_version) values($1,$2,'suspended',1)", [userId, `owned-${userId}@example.invalid`]);
    await admin.frontend.query("insert into customer_account_commands(command_id,user_id,account_version,idempotency_key,action,issued_at,command) values($1,$2,1,$1,'suspend',$3,$4::jsonb)", [commandId, userId, issuedAt, JSON.stringify(command)]);
    for (const service of ["course", "community"]) {
      const result = await post(service, command, sign(service, input.keys[service]));
      assert.equal(result.status, 200); assert.deepEqual(result.body, { commandId, accountVersion: 1, status: "accepted" });
      await admin.frontend.query("insert into customer_account_deliveries(command_id,receiver,status,attempts,next_run_at,acknowledged_at) values($1,$2,'acknowledged',1,$3,$3)", [commandId, service, issuedAt]);
    }
    checks.push("actual-source-both-receivers-accept-canonical-suspend-over-verified-tls");
    const selected = { version: 1, environment: "staging", stage: "lifecycle-account", userId, selectedCommand: { commandId, accountVersion: 1 } };
    const observe = async () => {
      const observations = Object.fromEntries(await Promise.all(["frontend", "course", "community"].map(async service => [service,
        await observePersistenceDomain(service, selected, input.plan.targets[service], readers[service])])));
      return { observations, witness: buildP2LifecycleStateWitness(input.plan, selected, observations) };
    };
    const gateway = Buffer.from(JSON.stringify({ appEnv: "staging", courseOrigin: "https://course-tls:8443", communityOrigin: "https://community-tls:8443", upstreamCaFile: "/tls/ca.pem" }));
    for (const service of ["course", "community"]) for (const caseName of ["exact-replay", "changed-replay", "stale-restore", "future-gap"]) {
      const before = await observe(), freshCommandId = ["stale-restore", "future-gap"].includes(caseName) ? randomUUID() : null;
      if (freshCommandId !== null) assert.ok(Object.values(before.observations).every(row => row.commands.every(command => command.command_id !== freshCommandId)));
      // Future gap is ONLY an owned, exclusive three-DB domain decision test.
      // No deployed quiescence/native/host-lock qualification is inferred.
      let receipt;
      if (caseName === "future-gap") {
        const gap = deriveReceiverNegativeCommand(before.witness, caseName, freshCommandId);
        const result = await post(service, gap, sign(service, input.keys[service]));
        assert.equal(result.status, 409); assert.equal(result.body.error.code, service === "course" ? "ACCOUNT_VERSION_CONFLICT" : "account_version_conflict");
        receipt = { service, case: caseName, httpStatus: result.status, fixtureOnly: true };
      } else receipt = await postReceiverNegative({ version: 1, mode: "post", environment: "staging", service, case: caseName, bindingSha256: hash("owned-binding"),
        witness: before.witness, freshCommandId, secret: input.keys[service], gatewayConfigurationSha256: hash(gateway), gatewayCaSha256: hash(input.ca) },
      { readGateway: () => gateway, readCa: () => input.ca, post });
      const after = await observe(); verifyReceiverNegativeReadback(before.witness, after.witness, service, caseName, freshCommandId);
      if (freshCommandId !== null) assert.ok(Object.values(after.observations).every(row => row.commands.every(command => command.command_id !== freshCommandId)));
      httpReceipts.push(receipt); checks.push(`${service}-${caseName}-actual-status-and-three-domain-unchanged`);
    }
    assert.ok((await admin.course.query("select count(*)::int as count from rate_limit_buckets")).rows[0].count >= 2);
    assert.ok((await admin.community.query("select request_count from http_rate_limit_windows where scope='service:account-lifecycle'")).rows[0].request_count >= 5);
    checks.push("actual-durable-quotas-write-with-account-domain-digests-unchanged");
    const current = await observe();
    for (const service of ["course", "community"]) {
      const bad = await post(service, command, sign(service, "owned-intentionally-wrong-signing-key".repeat(2)));
      assert.equal(bad.status, 401);
      await assert.rejects(postReceiverNegative({ version: 1, mode: "post", environment: "staging", service, case: "exact-replay", bindingSha256: hash("owned-binding"),
        witness: current.witness, freshCommandId: null, secret: "owned-intentionally-wrong-signing-key".repeat(2), gatewayConfigurationSha256: hash(gateway), gatewayCaSha256: hash(input.ca) },
      { readGateway: () => gateway, readCa: () => input.ca, post }));
    }
    checks.push("actual-unauthorized-responses-cannot-qualify-negative-case");
    const profiledWire = process.env.P2_LIFECYCLE_RECEIVER_PROFILED_OWNED_TEST === "true"
      ? await rehearseProfiledReceivers(input, gateway, observe, apis, servers, posts, guardedMode) : undefined;
    const beforeDelete = await observe();
    const deletion = { ...command, commandId: randomUUID(), accountVersion: 2, action: "delete" };
    for (const service of ["course", "community"]) {
      assert.equal((await post(service, deletion, sign(service, input.keys[service]))).status, 200);
      const stale = { ...deletion, commandId: randomUUID(), accountVersion: 3, action: "restore" };
      const result = await post(service, stale, sign(service, input.keys[service])); assert.equal(result.status, 409);
      assert.equal(result.body.error.code, service === "course" ? "ACCOUNT_DELETED" : "account_deleted");
      const replay = await post(service, command, sign(service, input.keys[service])); assert.equal(replay.status, 200); assert.equal(replay.body.status, "duplicate");
      assert.equal((await admin[service].query("select account_version,status from account_lifecycle_states where user_id=$1", [userId])).rows[0].status, "deleted");
    }
    checks.push("actual-terminal-delete-refuses-restore-and-preserves-exact-old-replay");
    assert.equal(beforeDelete.witness.command.action, "suspend");
    const raw = JSON.stringify(httpReceipts);
    for (const secret of [userId, commandId, issuedAt, ...Object.values(input.keys)]) assert.equal(raw.includes(secret), false);
    return { checks, httpCaseCount: httpReceipts.length, quotaWritesObserved: true, fixtureOnly: true, ...(profiledWire && { profiledWire }),
      deployedFutureGapQualified: false, hostDockerPathQualified: false, providerTouched: false };
  } finally {
    for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    for (const app of apps.reverse()) await app.close();
    for (const pool of pools.reverse()) await pool.end();
    for (const client of clients.reverse()) await client.end();
  }
}
process.once("message", async input => {
  try { const result = await run(input); process.send({ result }); }
  catch (error) { process.send({ failure: { check: error?.check ?? null, code: error?.code ?? error?.name ?? "Error",
    message: String(error?.message ?? "failure").replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gu, "{uuid}").slice(0, 180) } }); }
  finally { process.disconnect(); }
});
