// Owns a fresh loopback TLS cluster and isolated provider server. No configured
// database, real credential, Docker engine or provider endpoint is accepted.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { withFrontendEnvironmentLock } from "./frontend-environment-lock.mjs";
import { restoreFrontendAdmission } from "./frontend-release-restoration.mjs";
import { frontendReleaseReceiptStore } from "./frontend-release-receipts.mjs";
import { frontendCoordinationHash as hash } from "./frontend-release-inventory.mjs";
import { observeFrontendSquareEffects } from "./frontend-square-effects.mjs";
import { decodeQualificationTargetJson, parseQualificationTargetProfileRef, requireQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as currentProfile } from "./qualification-target-profile.mjs";
import { frontendAdmissionTargetSha256, frontendAdmissionBootstrapArtifact, bootstrapFrontendAdmission } from "./frontend-admission-bootstrap.mjs";
import { prepareHistoricalFrontendLogins } from "./frontend-historical-logins.mjs";

const script = fileURLToPath(import.meta.url), root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const lockName = "lash-her:private-db:migrations";
async function child(expectedProfile = undefined) {
  if (expectedProfile !== undefined) parseQualificationTargetProfileRef(expectedProfile);
  let raw = ""; for await (const part of process.stdin) raw += part; const input = decodeQualificationTargetJson(raw, "private-packet");
  if (expectedProfile === undefined) assert.equal(Object.hasOwn(input, "qualificationTargetProfile") || Object.hasOwn(input.plan, "qualificationTargetProfile"), false);
  else requireQualificationTargetProfile(expectedProfile, input, input.plan, input.plan.restoration, input.plan.historicalLogins, input.plan.historicalLogins.target);
  const client = new Client(input.database); client.on("error", () => {}); await client.connect();
  const original = client.query.bind(client); let lose = false;
  if (input.lostCommit) client.query = async (...args) => {
    if (String(args[0]).startsWith("UPDATE frontend_admission.control")) lose = true;
    const result = await original(...args);
    if (args[0] === "COMMIT" && lose) { lose = false; throw new Error("OWNED_LOST_ACK"); }
    return result;
  };
  try {
    await withFrontendEnvironmentLock(async verifyEnvironment => {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockName]);
      const pid = client.processID;
      const verifySession = async () => {
        await verifyEnvironment(); assert.equal(client.connection.stream.encrypted, true); assert.equal(client.connection.stream.authorized, true);
        const row = (await original("SELECT pg_backend_pid() AS pid,EXISTS(SELECT1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted) AS held".replace("SELECT1", "SELECT 1"))).rows[0];
        assert.equal(row.pid, pid); assert.equal(row.held, true);
      };
      const store = frontendReleaseReceiptStore(input.receipts);
      const record = (name, value) => {
        store.record(name, value);
        if (input.killAfter === name) process.kill(process.pid, "SIGKILL");
        if (input.failAfter === name) throw new Error("OWNED_STORAGE_LOST");
      };
      const result = await restoreFrontendAdmission(input.plan, client, "1", {
        record, verifySession,
        withOwner: async work => { await original("SET ROLE restoration_owner"); try { return await work(); } finally { await original("RESET ROLE"); } },
        async verifyBoundary(stage, admission) {
          await verifySession();
          const response = await fetch(`http://127.0.0.1:${input.providerPort}/boundary/${input.plan.actionId}/${stage}/${pid}`);
          assert.equal(response.status, 200); const actual = await response.json();
          assert.equal(actual.sourceCommit, input.plan.sourceCommit); assert.equal(actual.gatewayRecovery, input.plan.restoration.recovery);
          assert.equal(actual.gatewayNewWork, input.plan.restoration.newWork); assert.equal(actual.nativeSchedulesEnabled, false);
          assert.equal(actual.historicalIngressRetired, true); assert.equal(actual.activeExecutions, 0); assert.equal(actual.uncertainEffects, 0);
          assert.equal(admission.uncertain, 0); await verifySession();
        },
      }, expectedProfile);
      process.stdout.write(JSON.stringify({ status: result.status, epoch: result.epoch }));
    }, { path: input.lockPath });
  } finally { await client.end().catch(() => {}); }
}
async function main() {
  assert.equal(process.env.FRONTEND_RESTORATION_LOCAL_TEST, "true"); assert.equal(process.versions.node.split(".")[0], "24");
  const binaries = process.env.PG_BIN; assert.ok(binaries?.startsWith("/"));
  const major = Number(run(join(binaries, "postgres"), ["--version"]).match(/PostgreSQL\) (\d+)\./u)?.[1]); assert.ok([16, 18].includes(major));
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "frontend-restoration-owned-"))), data = join(directory, "data"), clients = [], scenarios = new Map();
  let running = false, provider;
  const checks = [];
  try {
    const probe = netServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    run(join(binaries, "initdb"), ["-D", data, "-A", "trust", "-U", "restoration_admin", "-E", "UTF8", "--locale=C"]);
    const key = join(directory, "server.key"), certificate = join(directory, "server.crt");
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", certificate]); chmodSync(key, 0o600);
    writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${certificate}'\nssl_key_file='${key}'\n`);
    run(join(binaries, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"]); running = true;
    const connection = database => ({ host: "127.0.0.1", port, user: "restoration_admin", database, ssl: { rejectUnauthorized: true, ca: readFileSync(certificate, "utf8") } });
    const connect = async database => { const client = new Client(connection(database)); client.on("error", () => {}); await client.connect(); clients.push(client); return client; };
    const admin = await connect("postgres");
    await admin.query("CREATE ROLE restoration_owner NOLOGIN NOINHERIT"); await admin.query("CREATE ROLE restoration_runtime LOGIN NOINHERIT"); await admin.query("CREATE ROLE restoration_old NOLOGIN NOINHERIT");
    const roleOid = async name => (await admin.query("SELECT oid::text FROM pg_roles WHERE rolname=$1", [name])).rows[0].oid;
    const runtimeOid = await roleOid("restoration_runtime"), oldOid = await roleOid("restoration_old");
    provider = createServer(async (req, res) => {
      try {
        const [, , action, stage, pid] = req.url.split("/"); const scenario = scenarios.get(action); assert.ok(scenario);
        const controls = (await scenario.client.query("SELECT new_work,recovery FROM frontend_admission.control")).rows[0]; scenario.stages.push({ stage, ...controls });
        assert.equal((await scenario.client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockName])).rows[0].locked, false);
        await assert.rejects(withFrontendEnvironmentLock(() => assert.fail("concurrent restore entered"), { path: scenario.lockPath }));
        if (scenario.killBackendAt === stage) await admin.query("SELECT pg_terminate_backend($1,1000)", [Number(pid)]);
        const actual = { sourceCommit: scenario.plan.sourceCommit, gatewayRecovery: scenario.plan.restoration.recovery, gatewayNewWork: scenario.plan.restoration.newWork,
          nativeSchedulesEnabled: false, historicalIngressRetired: true, activeExecutions: 0, uncertainEffects: scenario.providerUncertain ? null : 0 };
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify(actual));
      } catch { res.writeHead(500); res.end("OWNED_BOUNDARY_REFUSED"); }
    });
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve)); const providerPort = provider.address().port;
    const make = async (name, extra = {}) => {
      const database = `restore_${name.replaceAll("-", "_")}`; await admin.query(`CREATE DATABASE ${database}`); const client = await connect(database);
      await client.query(`GRANT CREATE ON DATABASE ${database} TO restoration_owner`);
      const plan = { version: 1, environment: "staging", actionId: `owned-${name}`, sourceCommit: "a".repeat(40), targetSha256: "b".repeat(64),
        restoration: { version: 1, recovery: true, newWork: true, nativeSchedulesEnabled: false, providerIngress: "keep-retired", gatewayBindingSha256: "c".repeat(64) },
        historicalLogins: { retiredLogins: [{ name: "restoration_old", oid: oldOid }] }, producers: [{ producerSha256: "d".repeat(64), role: { name: "restoration_runtime", oid: runtimeOid } }] };
      if (extra.profiledCurrent) {
        plan.version = 2; plan.restoration.version = 2; plan.historicalLogins.version = 2;
        plan.historicalLogins.target = { qualificationTargetProfile: currentProfile, host: "127.0.0.1", port, database, user: "restoration_admin",
          serverMajor: major, currentRuntimeRole: "restoration_runtime", admissionOwnerRole: "restoration_owner" };
        plan.historicalLogins.environment = "staging"; plan.historicalLogins.actionId = plan.actionId; plan.historicalLogins.sourceCommit = plan.sourceCommit;
        plan.historicalLogins.clusterScopeSha256 = "c".repeat(64);
        for (const value of [plan, plan.restoration, plan.historicalLogins]) value.qualificationTargetProfile = currentProfile;
        plan.historicalLogins = prepareHistoricalFrontendLogins(plan.historicalLogins, currentProfile);
        plan.targetSha256 = frontendAdmissionTargetSha256("staging", plan.historicalLogins.target);
      }
      if (extra.profiledCurrent) {
        const bootstrapDirectory = join(directory, name + "-bootstrap"); mkdirSync(bootstrapDirectory, { mode: 0o700 });
        const bootstrapStore = frontendReleaseReceiptStore(bootstrapDirectory), bootstrapRecords = [];
        await withFrontendEnvironmentLock(async verifyEnvironment => {
          await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockName]); const pid = client.processID;
          const verifySession = async () => {
            await verifyEnvironment(); assert.equal(client.connection.stream.encrypted, true); assert.equal(client.connection.stream.authorized, true);
            const actual = (await client.query("SELECT pg_backend_pid() AS pid,EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted) AS held")).rows[0];
            assert.equal(actual.pid, pid); assert.equal(actual.held, true);
          };
          try {
            const result = await bootstrapFrontendAdmission({ version: 2, qualificationTargetProfile: currentProfile, environment: "staging", actionId: plan.actionId,
              sourceCommit: plan.sourceCommit, ...frontendAdmissionBootstrapArtifact(), inventorySha256: hash({ ownedCase: name }), targetSha256: plan.targetSha256,
              target: plan.historicalLogins.target, owner: { name: "restoration_owner", oid: await roleOid("restoration_owner") },
              producers: plan.producers.map(value => ({ ...value, sourceCommit: plan.sourceCommit })) }, client,
            { confirmation: "staging/" + plan.actionId, verifySession, record(name, value) { bootstrapStore.record(name, value); bootstrapRecords.push(value); } }, currentProfile);
            assert.equal(result.newWork, false); assert.equal(result.recovery, false); assert.equal(result.epoch, "1");
            for (const value of bootstrapRecords) { assert.equal(value.version, 2); assert.deepEqual(value.qualificationTargetProfile, currentProfile); }
          } finally { await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName]); }
        }, { path: join(directory, `${name}.lock`) });
      } else {
        await client.query("SET ROLE restoration_owner"); await client.query(readFileSync(join(root, "ops/platform/frontend-admission.sql"), "utf8"));
        await client.query("INSERT INTO frontend_admission.control(environment,target_sha256,new_work,recovery) VALUES('staging',$1,false,false)", [plan.targetSha256]);
        await client.query("INSERT INTO frontend_admission.producers(producer_sha256,source_sha,database_role,enabled) VALUES($1,$2,$3::oid,true)", [plan.producers[0].producerSha256, plan.sourceCommit, runtimeOid]); await client.query("RESET ROLE");
      }
      const receipts = join(directory, name); mkdirSync(receipts, { mode: 0o700 });
      const scenario = { client, plan, receipts, lockPath: join(directory, `${name}.lock`), stages: [], ...extra }; scenarios.set(plan.actionId, scenario);
      scenario.execute = () => new Promise((resolve, reject) => {
        const process = spawn(globalThis.process.execPath, [script, extra.profiledCurrent ? "--child-profiled-current" : "--child"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: globalThis.process.env.PATH } });
        let stdout = "", stderr = ""; process.stdout.on("data", bytes => { stdout += bytes; }); process.stderr.on("data", bytes => { stderr += bytes; }); process.once("error", reject);
        const timer = setTimeout(() => { process.kill("SIGKILL"); reject(new Error("OWNED_CHILD_TIMEOUT")); }, 15_000);
        process.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
        process.stdin.end(JSON.stringify({ ...(extra.profiledCurrent ? { qualificationTargetProfile: currentProfile } : {}), database: connection(database), plan, receipts, lockPath: scenario.lockPath, providerPort,
          killAfter: scenario.killAfter, lostCommit: scenario.lostCommit, failAfter: scenario.failAfter }));
      });
      scenario.controls = async () => (await client.query("SELECT new_work,recovery,epoch::text FROM frontend_admission.control")).rows[0];
      return scenario;
    };
    const good = await make("success"); const firstResult = await good.execute(); assert.equal(firstResult.code, 0, firstResult.stderr); assert.deepEqual(await good.controls(), { new_work: true, recovery: true, epoch: "3" });
    assert.ok(good.stages.filter(row => row.stage.includes("before-new-work")).every(row => row.new_work === false && row.recovery === true));
    checks.push("real-tls-ledger-recovery-first-new-work-last-and-both-locks-held-through-every-boundary");
    const recoveryOnly = await make("recovery-only"); recoveryOnly.plan.restoration.newWork = false; assert.equal((await recoveryOnly.execute()).code, 0);
    assert.deepEqual(await recoveryOnly.controls(), { new_work: false, recovery: true, epoch: "2" }); checks.push("reviewed-recovery-only-keeps-new-work-closed");
    for (const killAfter of ["frontend-restoration-recovery-verified.json", "frontend-restoration-new-work-intent.json"]) {
      const killed = await make(killAfter.includes("recovery") ? "death-recovery" : "death-new-intent", { killAfter }); const first = await killed.execute(); assert.equal(first.signal, "SIGKILL");
      assert.deepEqual(await killed.controls(), { new_work: false, recovery: true, epoch: "2" });
      const before = readFileSync(join(killed.receipts, killAfter)); assert.notEqual((await killed.execute()).code, 0);
      assert.deepEqual(readFileSync(join(killed.receipts, killAfter)), before); assert.deepEqual(await killed.controls(), { new_work: false, recovery: true, epoch: "2" });
    }
    checks.push("actual-process-death-after-recovery-or-before-new-work-preserves-originals-and-refuses-implicit-continuation");
    const uncertain = await make("lost-commit", { lostCommit: true }); assert.notEqual((await uncertain.execute()).code, 0);
    assert.deepEqual(await uncertain.controls(), { new_work: false, recovery: true, epoch: "2" });
    assert.equal(JSON.parse(readFileSync(join(uncertain.receipts, "frontend-restoration-outcome.json"))).mutationOutcomeUncertain, true);
    checks.push("actual-committed-recovery-with-lost-ack-is-unknown-no-repeat-or-next-opening");
    const dead = await make("backend-death", { killBackendAt: "restoration-before-new-work" }); assert.notEqual((await dead.execute()).code, 0);
    assert.deepEqual(await dead.controls(), { new_work: false, recovery: true, epoch: "2" }); checks.push("actual-backend-death-during-restoration-stops-new-work");
    const unknown = await make("provider-unknown", { providerUncertain: true }); assert.notEqual((await unknown.execute()).code, 0);
    assert.deepEqual(await unknown.controls(), { new_work: false, recovery: false, epoch: "1" }); checks.push("unknown-provider-effects-refuse-before-opening");
    const login = await make("historical-login"); await admin.query("ALTER ROLE restoration_old LOGIN"); assert.notEqual((await login.execute()).code, 0);
    assert.deepEqual(await login.controls(), { new_work: false, recovery: false, epoch: "1" }); await admin.query("ALTER ROLE restoration_old NOLOGIN"); checks.push("actual-historical-login-drift-refuses-before-opening");
    const storage = await make("storage-failure", { failAfter: "frontend-restoration-recovery-verified.json" }); assert.notEqual((await storage.execute()).code, 0);
    assert.deepEqual(await storage.controls(), { new_work: false, recovery: true, epoch: "2" }); checks.push("failed-restoration-receipt-does-not-open-next-stage");
    const profiled = await make("profiled-success", { profiledCurrent: true }); assert.equal((await profiled.execute()).code, 0);
    assert.deepEqual(await profiled.controls(), { new_work: true, recovery: true, epoch: "3" });
    const profileOutcome = JSON.parse(readFileSync(join(profiled.receipts, "frontend-restoration-outcome.json")));
    assert.equal(profileOutcome.version, 2); assert.deepEqual(profileOutcome.qualificationTargetProfile, currentProfile);
    assert.equal(profileOutcome.selected.version, 2); assert.deepEqual(profileOutcome.selected.qualificationTargetProfile, currentProfile);
    checks.push("profiled-current-actual-tls-locks-ordered-restoration-v2-profiled-outcome");
    checks.push("profiled-current-actual-closed-bootstrap-owner-oids-grants-and-v2-receipts");
    const profiledLost = await make("profiled-lost-ack", { profiledCurrent: true, lostCommit: true }); assert.notEqual((await profiledLost.execute()).code, 0);
    const profileFailure = JSON.parse(readFileSync(join(profiledLost.receipts, "frontend-restoration-outcome.json")));
    assert.equal(profileFailure.version, 2); assert.deepEqual(profileFailure.qualificationTargetProfile, currentProfile);
    assert.equal(profileFailure.mutationOutcomeUncertain, true); assert.equal(profileFailure.admissionRestored, false);
    assert.deepEqual(await profiledLost.controls(), { new_work: false, recovery: true, epoch: "2" });
    checks.push("profiled-current-actual-lost-commit-preserves-v2-uncertain-receipt-without-reopen");
    // Exercise the exact financial SQL against real PostgreSQL. No buyer or
    // credential fields exist in these owned fixtures; no domain writes occur.
    const financial = await make("financial-rows"), id = randomUUID(), refund = randomUUID();
    await financial.client.query(`CREATE TABLE public.appointment_holds(id uuid,public_reference text);
      CREATE TABLE public.checkout_orders(id uuid,order_id text,payment_provider text,currency text,square_location_id text);
      CREATE TABLE public.booking_payment_attempts(id uuid,status text,payment_provider text,operation text,idempotency_key text,provider_payment_id text,provider_order_id text,amount_cents int,currency text,hold_id uuid,checkout_order_id uuid);
      CREATE TABLE public.product_order_refunds(id uuid,status text,idempotency_key uuid,provider_refund_id text,original_transaction_id text,amount_cents int,order_id uuid)`);
    const orderId = randomUUID(); await financial.client.query("INSERT INTO public.checkout_orders VALUES($1,'public-order','square','CAD','LE2H76M5V90AM')", [orderId]);
    await financial.client.query("INSERT INTO public.booking_payment_attempts VALUES($1,'pending','square','square_charge_and_store','original-owned-key',NULL,NULL,100,'CAD',NULL,$2)", [id, orderId]);
    const idem = randomUUID(); await financial.client.query("INSERT INTO public.product_order_refunds VALUES($1,'succeeded',$2,'owned-refund','owned-payment',100,$3)", [refund, idem, orderId]);
    const expected = [{ recordKind: "booking-payment-attempt", recordId: id, databaseStatus: "pending", idempotencySha256: hash("original-owned-key"), providerKind: "payment", providerId: null,
      amountCents: 100, currency: "CAD", providerOrderId: null, referenceId: "public-order" },
      { recordKind: "product-refund", recordId: refund, databaseStatus: "succeeded", idempotencySha256: hash(idem), providerKind: "refund", providerId: "owned-refund", amountCents: 100, currency: "CAD", originalPaymentId: "owned-payment" }];
    const reviewed = { environment: "sandbox", locationId: "LE2H76M5V90AM", effects: expected.map(row => ({ recordKind: row.recordKind, recordId: row.recordId, databaseRowSha256: hash(row) })) };
    const rows = await observeFrontendSquareEffects(financial.client, reviewed, async () => { assert.equal(financial.client.connection.stream.authorized, true); });
    assert.deepEqual(rows, expected.map(row => ({ ...row, databaseRowSha256: hash(row) })));
    await financial.client.query("UPDATE public.booking_payment_attempts SET amount_cents=200 WHERE id=$1", [id]);
    await assert.rejects(observeFrontendSquareEffects(financial.client, reviewed, async () => {}));
    checks.push("actual-readonly-financial-idempotency-and-sandbox-row-readback-refuses-real-stored-intent-drift");
    console.log(JSON.stringify({ status: "FRONTEND_RESTORATION_OWNED_POSTGRES_PASS", postgresMajor: major, checks, providerTouched: false, liveQualified: false }));
  } finally {
    if (provider) await new Promise(resolve => provider.close(resolve));
    for (const client of clients.reverse()) await client.end().catch(() => {});
    if (running) { try { run(join(binaries, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); } catch { /* disposable owned cleanup */ } }
    rmSync(directory, { recursive: true, force: true });
  }
}
try {
  if (process.argv.length === 3 && process.argv[2] === "--child-profiled-current") await child(currentProfile);
  else if (process.argv.includes("--child")) await child(); else await main();
}
catch { console.error("FRONTEND_RESTORATION_OWNED_TEST_REFUSED"); process.exitCode = 1; }
