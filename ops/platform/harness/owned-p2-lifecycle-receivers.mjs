// Private owned process only. IPC is never installed as an application route.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer, request } from "node:https";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildP2LifecycleStateWitness, observePersistenceDomain } from "../p2-lifecycle-persistence-probe.mjs";
import { createReceiverPrivateTlsPost, postReceiverNegative, deriveReceiverNegativeCommand } from "../p2-lifecycle-receiver-post.mjs";
import { verifyReceiverNegativeReadback } from "../p2-lifecycle-receiver-negatives.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
function sign(service, secret) {
  const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = encode({ alg: "HS256", typ: "JWT" }) + "." + encode({ iss: "lash-her-frontend", aud: `lash-her-${service}-api:account-lifecycle`,
    sub: "frontend-account-lifecycle", iat: now, exp: now + 120, jti: randomUUID() });
  return body + "." + createHmac("sha256", secret).update(body).digest("base64url");
}

async function run(input) {
  const clients = [], pools = [], apps = [], servers = [];
  const userId = randomUUID(), commandId = randomUUID(), issuedAt = new Date().toISOString();
  const command = { version: 1, commandId, userId, accountVersion: 1, action: "suspend", issuedAt };
  const admin = {}, readers = {}, apis = {}, checks = [], httpReceipts = [];
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
      const options = { accountLifecycle: { repository, authVerifier: verifier } };
      if (service === "course") options.accountLifecycle.rateLimit = { maxPerMinute: 1000, burst: 1000, scope: "owned-account-lifecycle",
        store: new (await load("src/rate-limit/drizzle-rate-limit-store.ts")).DrizzleRateLimitStore(db) };
      else options.accountLifecycle.rateLimitStore = (await load("src/http/shared-rate-limit.ts")).createSharedRateLimitStore(db);
      const app = await (await load("src/app.ts")).buildApp(options); apps.push(app); await app.ready();
      const server = createServer({ key: input.httpsKey, cert: input.httpsCertificate }, app.routing); servers.push(server);
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
    return { checks, httpCaseCount: httpReceipts.length, quotaWritesObserved: true, fixtureOnly: true,
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
