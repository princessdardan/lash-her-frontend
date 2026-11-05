// Explicitly owns a fresh loopback TLS cluster and HTTP provider model. No
// configured URL/credential/live adapter is accepted. Never run on staging.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { createServer as netServer } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, cpSync, symlinkSync, realpathSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { frontendMigrationArtifact } from "./frontend-migration.mjs";
import { readMigrationCatalog } from "./frontend-schema.mjs";
import { withFrontendEnvironmentLock } from "./frontend-environment-lock.mjs";

const source = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
let phase = "initialization";

function adapterSource(port) {
  // This fixture adapter is copied into an isolated committed source tree; it
  // cannot be loaded by the real checkout's absent live adapter path.
  return `import { request } from 'node:http';
import { createHash } from 'node:crypto';
const hash=v=>createHash('sha256').update(Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
async function call(method,path,value) {
  return new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:${port},method,path,timeout:2000},res=>{
      const chunks=[];let size=0;res.on('data',b=>{size+=b.length;if(size>2000000)req.destroy(new Error('OWNED_TOO_LARGE'));else chunks.push(b);});
      res.on('end',()=>{try{if(res.statusCode!==200)throw new Error();const bytes=Buffer.concat(chunks);resolve({value:JSON.parse(bytes),bytes});}catch{reject(new Error('OWNED_RESPONSE_REFUSED'));}});
      res.on('error',()=>reject(new Error('OWNED_RESPONSE_FAILED')));
    }); req.on('error',()=>reject(new Error('OWNED_PROVIDER_UNCERTAIN')));req.on('timeout',()=>req.destroy(new Error('OWNED_TIMEOUT')));req.end(value?JSON.stringify(value):undefined);
  });
}
export async function fenceFrontendExternalProducers(c){await c.verifyLockedSession();await call('POST','/fence',{actionId:c.plan.actionId});await c.verifyLockedSession();await c.record('owned-provider-fenced.json',{status:'OWNED_FENCED',actionId:c.plan.actionId});}
export async function deployAdmissionCompatibleFrontend(c){
 await c.verifyLockedSession();await call('POST','/bootstrap-build',{actionId:c.plan.actionId,sourceCommit:c.plan.sourceCommit,schema:c.preapplicationSchema});
 await c.verifyLockedSession();await call('POST','/bootstrap-promote',{actionId:c.plan.actionId});await c.verifyLockedSession();
}
export async function observeAdmissionCompatibleFrontend(c){
 const raw=(await call('GET','/state/'+c.plan.actionId)).value;
 const value={version:1,environment:c.plan.environment,actionId:c.plan.actionId,sourceCommit:c.plan.sourceCommit,targetSha256:c.plan.targetSha256,
  projectId:'prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM',deploymentId:'dpl_OwnedBootstrap',readyState:raw.bootstrapBuilt?'READY':null,
  aliasJobState:raw.bootstrapPromoted?'succeeded':null,aliasDeploymentId:raw.bootstrapPromoted?'dpl_OwnedBootstrap':null,nativeSchedulesEnabled:false,
  admissionNewWork:c.admissionObservation.newWork,admissionRecovery:c.admissionObservation.recovery,workloadVerified:raw.bootstrapBuilt,
  workloadReceiptSha256:hash({ownedBootstrapWorkload:raw.bootstrapBuilt}),bootstrapAdmissionVerified:raw.bootstrapBuilt&&raw.bootstrapPromoted,
  schemaCatalogSha256:raw.bootstrapSchema.schemaCatalogSha256,appliedLineageSha256:raw.bootstrapSchema.appliedLineageSha256};
 const evidence=Buffer.from(JSON.stringify(value));return {...value,evidence,evidenceSha256:hash(evidence)};
}
export async function observeFrontendExternalFences(c){
 const raw=await call('GET','/state/'+c.plan.actionId);
 return {version:1,nonce:c.nonce,actionId:c.plan.actionId,sourceCommit:c.plan.sourceCommit,targetSha256:c.plan.targetSha256,inventorySha256:c.inventorySha256,
  surfaces:c.plan.externalSurfaces.map(surface=>{
   const observation=Buffer.from(JSON.stringify({surfaceSha256:surface.surfaceSha256,providerState:raw.value}));
   const reconciliation=Buffer.from(JSON.stringify({surfaceSha256:surface.surfaceSha256,active:raw.value.active,uncertain:raw.value.uncertain,mutationCounts:raw.value.counts}));
   const state=!raw.value.fenced?'unfenced':surface.kind==='provider'?'credentials-retired-and-effects-reconciled':surface.kind==='scheduler'?'disabled-and-running-executions-reconciled':'retired-and-effects-reconciled';
   const evidence=Buffer.from(JSON.stringify({version:1,nonce:c.nonce,actionId:c.plan.actionId,sourceCommit:c.plan.sourceCommit,targetSha256:c.plan.targetSha256,...surface,
    activeExecutions:raw.value.active,uncertainEffects:raw.value.uncertain,state,observationSha256:hash(observation),reconciliationSha256:hash(reconciliation)}));
   return {surfaceSha256:surface.surfaceSha256,evidence,evidenceSha256:hash(evidence),observation,reconciliation};
  })};
}
export async function deployCompatibleFrontend(c){
 await c.verifyLockedSession();await call('POST','/build',{actionId:c.plan.actionId,sourceCommit:c.plan.sourceCommit});
 await c.record('owned-build-created.json',{actionId:c.plan.actionId,status:'OWNED_BUILD_CREATED'});
 await c.verifyLockedSession();await call('POST','/promote',{actionId:c.plan.actionId});await c.verifyLockedSession();
}
export async function observeCompatibleFrontend(c){
 const raw=(await call('GET','/state/'+c.plan.actionId)).value;
 const value={version:1,environment:c.plan.environment,actionId:c.plan.actionId,sourceCommit:c.plan.sourceCommit,targetSha256:c.plan.targetSha256,
  projectId:'prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM',deploymentId:raw.built?'dpl_OwnedCandidate':null,readyState:raw.built?'READY':null,
  aliasJobState:raw.promoted?'succeeded':null,aliasDeploymentId:raw.promoted?'dpl_OwnedCandidate':null,nativeSchedulesEnabled:!raw.fenced,
  admissionNewWork:false,admissionRecovery:false,workloadVerified:raw.built,workloadReceiptSha256:hash({ownedWorkload:raw.built})};
 const evidence=Buffer.from(JSON.stringify(value));return {...value,evidence,evidenceSha256:hash(evidence)};
}
`;
}

async function main() {
  assert.equal(process.env.FRONTEND_RELEASE_LOCAL_TEST, "true");
  assert.equal(process.versions.node.split(".")[0], "24");
  const binaries = process.env.PG_BIN; assert.ok(binaries?.startsWith("/"));
  const version = run(join(binaries, "postgres"), ["--version"]), major = Number(version.match(/PostgreSQL\) (\d+)\./u)?.[1]);
  assert.ok([16, 18].includes(major));
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "frontend-release-owned-"))), data = join(directory, "data"), app = join(directory, "app");
  const password = `owned-${randomUUID()}`, connections = [], providerState = new Map(), onFence = new Map(), onBuild = new Map(), onPromote = new Map(), onBootstrapBuild = new Map(); let running = false, provider;
  const checks = [];
  try {
    const probe = netServer(); await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    phase = "owned-cluster";
    run(join(binaries, "initdb"), ["-D", data, "-A", "trust", "-U", "release_test_admin", "-E", "UTF8", "--locale=C"]);
    const key = join(directory, "server.key"), certificate = join(directory, "server.crt");
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", certificate]); chmodSync(key, 0o600);
    writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${certificate}'\nssl_key_file='${key}'\npassword_encryption='scram-sha-256'\n`);
    writeFileSync(join(data, "pg_hba.conf"), "local all all trust\nhostssl all release_test_admin 127.0.0.1/32 trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n");
    run(join(binaries, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"]); running = true;
    const connect = async (database, user = "release_test_admin", options = {}) => {
      const client = new Client({ host: "127.0.0.1", port, user, database, password, ssl: { rejectUnauthorized: true, ca: readFileSync(certificate, "utf8") }, ...options });
      connections.push(client); client.on("error", () => {}); await client.connect(); return client;
    };
    const admin = await connect("postgres");
    await admin.query(`CREATE ROLE release_runtime LOGIN NOINHERIT PASSWORD '${password}'`);
    await admin.query("CREATE ROLE release_admission_owner NOLOGIN NOINHERIT");
    const ownerOid = (await admin.query("SELECT 'release_admission_owner'::regrole::oid::text AS oid")).rows[0].oid;
    const runtimeOid = (await admin.query("SELECT 'release_runtime'::regrole::oid::text AS oid")).rows[0].oid;
    const createDatabase = async database => {
      await admin.query(`CREATE DATABASE ${database}`);
      const client = await connect(database);
      await client.query(`GRANT CREATE ON DATABASE ${database} TO release_admission_owner`);
      await client.query("GRANT USAGE ON SCHEMA public TO release_runtime");
      await client.query("ALTER DEFAULT PRIVILEGES FOR ROLE release_test_admin IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO release_runtime");
      await client.query("ALTER DEFAULT PRIVILEGES FOR ROLE release_test_admin IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO release_runtime");
      return client;
    };
    phase = "owned-provider";
    const getState = actionId => {
      if (!providerState.has(actionId)) providerState.set(actionId, { fenced: false, active: 0, uncertain: 0, built: false, promoted: false,
        bootstrapBuilt: false, bootstrapPromoted: false, counts: { fence: 0, build: 0, promote: 0 } });
      return providerState.get(actionId);
    };
    provider = httpServer(async (req, res) => {
      try {
        if (req.method === "GET" && req.url.startsWith("/state/")) { res.end(JSON.stringify(getState(req.url.slice(7)))); return; }
        const parts = []; for await (const bytes of req) parts.push(bytes); const body = JSON.parse(Buffer.concat(parts).toString());
        const state = getState(body.actionId);
        if (req.method !== "POST") throw new Error();
        if (req.url === "/bootstrap-build") {
          assert.equal(state.fenced, false); state.bootstrapBuilt = true; state.bootstrapSchema = body.schema;
          if (onBootstrapBuild.has(body.actionId)) await onBootstrapBuild.get(body.actionId)();
        }
        else if (req.url === "/bootstrap-promote") {
          assert.equal(state.bootstrapBuilt, true); state.bootstrapPromoted = true;
          if (body.actionId === "owned-bootstrap-uncertain-promotion") { req.socket.destroy(); return; }
        }
        else if (req.url === "/fence") { state.fenced = true; state.counts.fence++; if (onFence.has(body.actionId)) await onFence.get(body.actionId)(); }
        else if (req.url === "/build") {
          assert.equal(state.fenced, true); state.built = true; state.sourceCommit = body.sourceCommit; state.counts.build++;
          if (onBuild.has(body.actionId)) await onBuild.get(body.actionId)();
        }
        else if (req.url === "/promote") {
          assert.equal(state.built, true); state.promoted = true; state.counts.promote++;
          if (onPromote.has(body.actionId)) await onPromote.get(body.actionId)();
          if (body.actionId === "owned-lost-promotion") { req.socket.destroy(); return; }
        } else throw new Error();
        res.end(JSON.stringify({ accepted: true }));
      } catch { res.statusCode = 400; res.end("{}"); }
    });
    await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
    phase = "source-pinned-fixture";
    mkdirSync(app);
    for (const name of ["src", "scripts", "ops", "contracts", "drizzle"]) cpSync(join(source, name), join(app, name), { recursive: true, filter: path => !path.includes("__pycache__") && !path.includes("node_modules") });
    writeFileSync(join(app, "package.json"), '{"type":"module","private":true}\n');
    writeFileSync(join(app, ".gitignore"), "node_modules\n");
    symlinkSync(join(source, "node_modules"), join(app, "node_modules"), "dir");
    writeFileSync(join(app, "ops/platform/frontend-release-adapters.mjs"), adapterSource(provider.address().port));
    const git = (...args) => run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Owned Release Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: app,
      env: { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "--quiet"); git("add", "."); git("commit", "--quiet", "-m", "Owned source-pinned release fixture");
    const commit = git("rev-parse", "HEAD").trim();
    const load = file => import(pathToFileURL(join(app, "ops/platform", file)).href);
    const coordinator = await load("frontend-release-coordinator.mjs"), recovery = await load("frontend-release-recovery.mjs");
    const { frontendWriterInventory } = await load("frontend-writer-inventory.mjs");
    const { frontendCandidateSurfaces } = await load("frontend-release-inventory.mjs");
    const { frontendAdmissionTargetSha256 } = await load("frontend-admission-bootstrap.mjs");
    const { runFrontendWriterOperation } = await load("frontend-admission.mjs");
    const artifact = frontendMigrationArtifact(app);
    const baselineClient = await createDatabase("release_baseline");
    await baselineClient.query("CREATE SCHEMA drizzle");
    await baselineClient.query("CREATE TABLE drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of artifact.migrations) {
      await baselineClient.query("BEGIN");
      try { for (const statement of migration.sql) await baselineClient.query(statement); await baselineClient.query("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)", [migration.hash, migration.folderMillis]); await baselineClient.query("COMMIT"); }
      catch (error) { await baselineClient.query("ROLLBACK"); throw error; }
    }
    const baseline = { version: 1, serverMajor: major, sqlArtifactSha256: artifact.sqlArtifactSha256, catalog: await readMigrationCatalog(baselineClient) };
    const sourceInventory = frontendWriterInventory(app), candidateSurfaces = frontendCandidateSurfaces(sourceInventory);
    const adapterSha256 = hash(readFileSync(join(app, "ops/platform/frontend-release-adapters.mjs")));
    const make = async (suffix, admissionMode = "bootstrap", budget = 300, recoveryAfterCompatibleBuild = false) => {
      const actionId = `owned-${suffix}`, database = `release_${suffix.replaceAll("-", "_")}`, historicalRole = `old_${suffix.replaceAll("-", "_")}`;
      const client = await createDatabase(database);
      await admin.query(`CREATE ROLE ${historicalRole} LOGIN NOINHERIT PASSWORD '${password}'`);
      const historicalOid = (await admin.query("SELECT oid::text FROM pg_roles WHERE rolname=$1", [historicalRole])).rows[0].oid;
      const old = await connect(database, historicalRole); let historicalEnded = false; old.once("end", () => { historicalEnded = true; });
      const job = { version: 1, operator: "Dardan", environment: "staging", releaseId: actionId, sourceCommit: commit,
        migrationImageDigest: `sha256:${"b".repeat(64)}`, contractManifestSha256: artifact.contractManifestSha256,
        sqlArtifactSha256: artifact.sqlArtifactSha256, schemaBaselineSha256: hash(baseline), recoveryRef: "owned/recovery",
        target: { host: "127.0.0.1", port, database, user: "release_test_admin", runtimeRole: "release_runtime", serverMajor: major,
          allowEmptyBootstrap: true, approvedPendingTags: artifact.migrations.map(m => m.tag) } };
      const candidate = { version: 2, environment: "staging", releaseId: actionId, integration: { state: "passed" },
        sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309" },
        sources: { frontend: { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit, requiredChecks: "passed" } },
        artifacts: { frontendMigration: { image: `ghcr.io/princessdardan/lash-her-platform-frontend-migration@${job.migrationImageDigest}` } },
        contractManifestSha256: artifact.contractManifestSha256, frontendMigration: { sourceCommit: commit, sqlArtifactSha256: artifact.sqlArtifactSha256,
          contractManifestSha256: artifact.contractManifestSha256, schemaBaselines: { [major]: job.schemaBaselineSha256 } } };
      const producerSha256 = "5".repeat(64), targetSha256 = frontendAdmissionTargetSha256("staging", job.target);
      const inventory = { version: 1, environment: "staging", actionId, sourceCommit: commit, targetSha256,
        sourceInventorySha256: hash(sourceInventory), reviewSha256: "3".repeat(64), adaptersSha256: adapterSha256,
        observationBudgetSeconds: budget, admissionMode, ...(admissionMode === "bootstrap" ? {
          bootstrapSqlSha256: hash(readFileSync(join(app, "ops/platform/frontend-admission.sql"))),
          bootstrapCompatibility: { version: 1, schemaCatalogSha256: hash(await readMigrationCatalog(client)), appliedLineageSha256: hash([]),
            appliedCount: 0, validationEvidenceSha256: "9".repeat(64), runtimeProducerSha256: producerSha256, recoveryAfterCompatibleBuild },
        } : {}), expectedEpoch: "1", owner: { name: "release_admission_owner", oid: ownerOid },
        producers: [{ producerSha256, role: { name: "release_runtime", oid: runtimeOid } }],
        candidateCoverage: candidateSurfaces.map(row => ({ surfaceSha256: row.surfaceSha256, disposition: "admitted", producerSha256, evidenceSha256: "6".repeat(64) })),
        externalSurfaces: ["deployment", "provider", "scheduler", "direct-caller"].map((kind, i) => {
          const identitySha256 = String(i + 1).repeat(64); return { kind, identitySha256, surfaceSha256: hash({ kind, identitySha256 }) };
        }), historicalLogins: { version: 1, environment: "staging", actionId, sourceCommit: commit, clusterScopeSha256: "7".repeat(64),
          target: { ...job.target, currentRuntimeRole: "release_runtime", admissionOwnerRole: "release_admission_owner" }, retiredLogins: [{ name: historicalRole, oid: historicalOid }] } };
      if (admissionMode === "existing") {
        await client.query("BEGIN"); await client.query("SET LOCAL ROLE release_admission_owner");
        await client.query(readFileSync(join(app, "ops/platform/frontend-admission.sql"), "utf8"));
        await client.query("INSERT INTO frontend_admission.control(environment,target_sha256,new_work,recovery) VALUES('staging',$1,true,true)", [targetSha256]);
        await client.query("INSERT INTO frontend_admission.producers(producer_sha256,source_sha,database_role,enabled) VALUES($1,$2,$3::oid,true)", [producerSha256, commit, runtimeOid]);
        await client.query("GRANT USAGE ON SCHEMA frontend_admission TO release_runtime");
        await client.query("GRANT EXECUTE ON ALL ROUTINES IN SCHEMA frontend_admission TO release_runtime"); await client.query("COMMIT");
      }
      const prepared = coordinator.prepareFrontendReleaseCoordination(candidate, job, baseline, inventory);
      const output = join(directory, `${actionId}-receipts`); mkdirSync(output, { mode: 0o700 });
      let migrationClient;
      const dependencies = { directory: output, lockPath: join(directory, "environment.lock"), confirmation: `staging/${actionId}`,
        getUrl: () => `postgresql://release_test_admin:${password}@127.0.0.1:${port}/${database}?sslmode=verify-full`,
        createClient(options) { const result = new Client({ ...options, ssl: { ...options.ssl, ca: readFileSync(certificate, "utf8") } }); migrationClient = result; connections.push(result); return result; } };
      const current = await connect(database, "release_runtime");
      return { prepared, dependencies, client, current, historicalEnded: () => historicalEnded, migrationClient: () => migrationClient, output,
        target: { environment: "staging", targetSha256 }, operation: () => ({ id: randomUUID(), epoch: "1", kind: "new-work", producerSha256, sourceSha: commit }),
        run: () => coordinator.runFrontendReleaseCoordination(prepared, dependencies) };
    };
    phase = "bootstrap-release-success";
    const first = await make("bootstrap");
    let locksObserved = 0;
    const verifyBothLocks = async () => {
      assert.equal((await first.client.query("SELECT pg_try_advisory_lock(hashtext('lash-her:private-db:migrations')) AS locked")).rows[0].locked, false);
      await assert.rejects(withFrontendEnvironmentLock(() => assert.fail("concurrent release entered"), { path: first.dependencies.lockPath }));
      locksObserved++;
    };
    onBuild.set("owned-bootstrap", verifyBothLocks); onPromote.set("owned-bootstrap", verifyBothLocks);
    onBootstrapBuild.set("owned-bootstrap", async () => {
      await verifyBothLocks();
      assert.equal((await first.client.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present")).rows[0].present, false);
      assert.deepEqual((await first.client.query("SELECT new_work,recovery FROM frontend_admission.control")).rows[0], { new_work: false, recovery: false });
    });
    // Prepared objects are data, never an executable SQL authority. The
    // parent must reconstruct the artifact from the pinned source.
    first.prepared.migration.artifact.migrations[0].sql = ["SELECT 'owned-mutated-prepared-artifact'"];
    const outcome = await first.run(); assert.equal(locksObserved, 3);
    assert.equal(outcome.status, "FRONTEND_SQL_AND_COMPATIBLE_DEPLOYMENT_VERIFIED_HELD");
    assert.equal(outcome.trafficAuthorized, false); assert.equal(outcome.admissionRestored, false); assert.equal(outcome.nativeSchedulesRestored, false);
    assert.equal(first.historicalEnded(), true);
    const controls = (await first.client.query("SELECT new_work,recovery FROM frontend_admission.control")).rows[0];
    assert.deepEqual(controls, { new_work: false, recovery: false });
    assert.equal((await first.client.query("SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations")).rows[0].count, artifact.migrations.length);
    checks.push("closed-bootstrap-real-login-retirement-migrations-compatible-http-promotion-and-held-controls");
    phase = "bootstrap-schema-refusal";
    const badSchema = await make("bootstrap-schema-mismatch");
    await badSchema.client.query("CREATE TABLE public.unreviewed_schema_drift(id int)");
    await assert.rejects(badSchema.run(), /FRONTEND_RELEASE_COORDINATION_FAILED_REVIEW_REQUIRED/u);
    assert.equal(getState("owned-bootstrap-schema-mismatch").bootstrapBuilt, false);
    assert.equal((await badSchema.client.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present")).rows[0].present, false);
    checks.push("actual-preapplication-schema-drift-refuses-before-bootstrap-build-and-sql");
    phase = "bootstrap-backend-death";
    const bootstrapDead = await make("bootstrap-backend-death");
    onBootstrapBuild.set("owned-bootstrap-backend-death", async () => {
      assert.equal((await admin.query("SELECT pg_terminate_backend($1,1000) AS stopped", [bootstrapDead.migrationClient().processID])).rows[0].stopped, true);
    });
    await assert.rejects(bootstrapDead.run(), /FRONTEND_RELEASE_COORDINATION_FAILED_REVIEW_REQUIRED/u);
    assert.equal(getState("owned-bootstrap-backend-death").bootstrapPromoted, false);
    assert.equal(getState("owned-bootstrap-backend-death").counts.fence, 0);
    assert.equal((await bootstrapDead.client.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present")).rows[0].present, false);
    assert.deepEqual((await bootstrapDead.client.query("SELECT new_work,recovery FROM frontend_admission.control")).rows[0], { new_work: false, recovery: false });
    checks.push("actual-backend-death-during-bootstrap-stops-promotion-fencing-and-application-sql-with-closed-controls");
    phase = "bootstrap-uncertain-promotion";
    const bootstrapUncertain = await make("bootstrap-uncertain-promotion");
    await assert.rejects(bootstrapUncertain.run(), /FRONTEND_RELEASE_COORDINATION_FAILED_REVIEW_REQUIRED/u);
    assert.equal(getState("owned-bootstrap-uncertain-promotion").bootstrapPromoted, true);
    assert.equal(getState("owned-bootstrap-uncertain-promotion").counts.fence, 0);
    assert.equal((await bootstrapUncertain.client.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present")).rows[0].present, false);
    const bootstrapFailure = JSON.parse(readFileSync(join(bootstrapUncertain.output, "frontend-release-outcome.json")));
    assert.equal(bootstrapFailure.bootstrapFrontendDomainsPromoted, null); assert.equal(bootstrapFailure.databaseVerified, false);
    assert.deepEqual((await bootstrapUncertain.client.query("SELECT new_work,recovery FROM frontend_admission.control")).rows[0], { new_work: false, recovery: false });
    checks.push("lost-bootstrap-promotion-response-retains-uncertainty-without-application-sql-replay-or-control-reopening");
    phase = "bootstrap-budget-placement";
    const slowBootstrap = await make("bootstrap-slow", "bootstrap", 1);
    onBootstrapBuild.set("owned-bootstrap-slow", async () => { await new Promise(resolve => setTimeout(resolve, 1200)); });
    await slowBootstrap.run();
    checks.push("drain-budget-starts-after-locked-bootstrap-build-and-independent-verification");
    phase = "reviewed-bootstrap-recovery-stage";
    const eligibleBootstrap = await make("bootstrap-eligible-recovery", "bootstrap", 300, true);
    onBootstrapBuild.set("owned-bootstrap-eligible-recovery", async () => {
      assert.deepEqual((await eligibleBootstrap.client.query("SELECT new_work,recovery FROM frontend_admission.control")).rows[0], { new_work: false, recovery: false });
    });
    onFence.set("owned-bootstrap-eligible-recovery", async () => {
      assert.deepEqual((await eligibleBootstrap.client.query("SELECT new_work,recovery FROM frontend_admission.control")).rows[0], { new_work: false, recovery: true });
      assert.equal(getState("owned-bootstrap-eligible-recovery").bootstrapPromoted, true);
    });
    await eligibleBootstrap.run();
    assert.deepEqual((await eligibleBootstrap.client.query("SELECT new_work,recovery FROM frontend_admission.control")).rows[0], { new_work: false, recovery: false });
    checks.push("explicit-reviewed-recovery-only-stage-follows-verified-bootstrap-and-closes-before-sql");
    phase = "deferred-admitted-operation";
    const deferred = await make("deferred", "existing");
    let releaseWork, startedWork; const workHeld = new Promise(resolve => { releaseWork = resolve; }), workStarted = new Promise(resolve => { startedWork = resolve; });
    const pending = runFrontendWriterOperation(deferred.current, deferred.target, deferred.operation(), ({ defer }) => { defer(async () => { startedWork(); await workHeld; }); });
    await workStarted;
    let timer, heldDuringClosure = false;
    onFence.set("owned-deferred", async () => {
      assert.equal((await deferred.client.query("SELECT new_work FROM frontend_admission.control")).rows[0].new_work, false);
      assert.equal((await deferred.client.query("SELECT count(*)::int AS count FROM frontend_admission.operations WHERE state='active'")).rows[0].count, 1);
      assert.equal((await deferred.client.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present")).rows[0].present, false);
      heldDuringClosure = true; timer = setTimeout(releaseWork, 150);
    });
    try { await deferred.run(); await pending; } finally { clearTimeout(timer); releaseWork(); }
    assert.equal(heldDuringClosure, true);
    assert.equal((await deferred.client.query("SELECT count(*)::int AS count FROM frontend_admission.operations WHERE state<>'completed'")).rows[0].count, 0);
    checks.push("actual-ledger-deferred-work-drains-before-reviewed-sql");
    phase = "uncertain-ledger-refusal";
    const uncertain = await make("uncertain", "existing", 1);
    await assert.rejects(runFrontendWriterOperation(uncertain.current, uncertain.target, uncertain.operation(), () => { throw new Error("owned-failure"); }));
    await assert.rejects(uncertain.run(), /FRONTEND_RELEASE_COORDINATION_FAILED_REVIEW_REQUIRED/u);
    assert.equal((await uncertain.client.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present")).rows[0].present, false);
    assert.equal((await uncertain.client.query("SELECT state FROM frontend_admission.operations")).rows[0].state, "uncertain");
    assert.equal(getState("owned-uncertain").counts.build, 0);
    await assert.rejects(uncertain.run());
    checks.push("uncertain-never-expires-and-budget-refuses-before-sql-with-exclusive-replay-refusal");
    phase = "current-source-producer-mismatch";
    const mismatch = await make("producer-mismatch", "existing");
    await mismatch.client.query("UPDATE frontend_admission.producers SET source_sha=$1", ["f".repeat(40)]);
    await assert.rejects(mismatch.run(), /FRONTEND_RELEASE_COORDINATION_FAILED_REVIEW_REQUIRED/u);
    assert.equal((await mismatch.client.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present")).rows[0].present, false);
    assert.equal(getState("owned-producer-mismatch").counts.build, 0);
    checks.push("mismatched-current-source-registration-refuses-before-sql-without-silent-adoption");
    phase = "missing-durable-database-receipt";
    const missing = await make("missing-receipt");
    onFence.set("owned-missing-receipt", () => mkdirSync(join(missing.output, "database-receipt.json")));
    await assert.rejects(missing.run(), /FRONTEND_RELEASE_COORDINATION_FAILED_REVIEW_REQUIRED/u);
    assert.equal((await missing.client.query("SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations")).rows[0].count, artifact.migrations.length);
    assert.equal(getState("owned-missing-receipt").counts.build, 0);
    assert.equal(JSON.parse(readFileSync(join(missing.output, "job-outcome.json"))).status, "FAILED_REQUIRES_REVIEW");
    checks.push("missing-durable-database-receipt-retains-committed-sql-and-refuses-deployment");
    phase = "actual-migration-backend-death";
    const dead = await make("backend-death");
    onBuild.set("owned-backend-death", async () => {
      assert.equal((await admin.query("SELECT pg_terminate_backend($1,1000) AS stopped", [dead.migrationClient().processID])).rows[0].stopped, true);
    });
    await assert.rejects(dead.run(), /FRONTEND_RELEASE_COORDINATION_FAILED_REVIEW_REQUIRED/u);
    assert.equal(JSON.parse(readFileSync(join(dead.output, "database-receipt.json"))).status, "DATABASE_VERIFIED");
    assert.equal(getState("owned-backend-death").counts.promote, 0);
    assert.equal((await dead.client.query("SELECT new_work,recovery FROM frontend_admission.control")).rows[0].new_work, false);
    checks.push("actual-locked-backend-death-after-sql-stops-promotion-and-retains-closed-admission");
    phase = "actual-environment-lock-loss";
    const lostEnvironment = await make("environment-lock-loss");
    onBuild.set("owned-environment-lock-loss", () => {
      rmSync(lostEnvironment.dependencies.lockPath); writeFileSync(lostEnvironment.dependencies.lockPath, "", { mode: 0o600 });
    });
    await assert.rejects(lostEnvironment.run(), /FRONTEND_RELEASE_COORDINATION_FAILED_REVIEW_REQUIRED/u);
    assert.equal(JSON.parse(readFileSync(join(lostEnvironment.output, "database-receipt.json"))).status, "DATABASE_VERIFIED");
    assert.equal(getState("owned-environment-lock-loss").counts.promote, 0);
    checks.push("environment-lock-loss-fences-physical-client-and-refuses-promotion");
    phase = "promotion-response-loss";
    const lost = await make("lost-promotion");
    await assert.rejects(lost.run(), /FRONTEND_RELEASE_COORDINATION_FAILED_REVIEW_REQUIRED/u);
    const databaseReceipt = readFileSync(join(lost.output, "database-receipt.json"));
    assert.equal(JSON.parse(databaseReceipt).status, "DATABASE_VERIFIED");
    assert.equal(getState("owned-lost-promotion").counts.promote, 1);
    assert.equal(getState("owned-lost-promotion").promoted, true);
    assert.equal((await lost.client.query("SELECT new_work,recovery FROM frontend_admission.control")).rows[0].recovery, false);
    const original = new Map(readdirSync(lost.output).map(name => [name, hash(readFileSync(join(lost.output, name)))]));
    const recoveryDirectory = join(directory, "deliberate-recovery"); mkdirSync(recoveryDirectory, { mode: 0o700 });
    const recoveryPlan = recovery.prepareFrontendReleaseRecovery(lost.prepared, { version: 1, environment: "staging", actionId: "owned-deliberate-recovery",
      originalActionId: "owned-lost-promotion", originalIntentSha256: hash(readFileSync(join(lost.output, "frontend-release-started.json"))), reconciliationReviewSha256: "8".repeat(64) });
    const recoveryOutcome = await recovery.observeFrontendReleaseRecovery(recoveryPlan, { ...lost.dependencies, directory: recoveryDirectory,
      originalDirectory: lost.output, confirmation: "staging/owned-deliberate-recovery" });
    assert.equal(recoveryOutcome.status, "FRONTEND_RELEASE_STATE_OBSERVED_REVIEW_REQUIRED");
    const state = JSON.parse(readFileSync(join(recoveryDirectory, "frontend-recovery-database-observed.json")));
    assert.equal(state.lineageCurrent, true); assert.equal(state.schemaMatchesReviewedBaseline, true);
    assert.equal(JSON.parse(readFileSync(join(recoveryDirectory, "frontend-recovery-provider-state-observed.json"))).aliasJobState, "succeeded");
    for (const [name, digest] of original) assert.equal(hash(readFileSync(join(lost.output, name))), digest);
    assert.deepEqual(getState("owned-lost-promotion").counts, { fence: 1, build: 1, promote: 1 });
    checks.push("committed-sql-and-uncertain-promotion-preserved-with-new-read-only-recovery-action-and-no-replay");
    console.log(JSON.stringify({ status: "FRONTEND_RELEASE_OWNED_POSTGRES_PASS", postgresMajor: major, providerTouched: false, checks,
      liveAdapterQualified: false, migrationAuthorized: false, trafficAuthorized: false }));
  } finally {
    for (const client of connections.reverse()) { try { await client.end(); } catch { /* owned cleanup */ } }
    if (provider) await new Promise(resolve => provider.close(resolve));
    if (running) { try { run(join(binaries, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); } catch { /* owned cleanup */ } }
    rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch { console.error(JSON.stringify({ status: "FRONTEND_RELEASE_OWNED_POSTGRES_FAILED", phase, providerTouched: false })); process.exitCode = 1; }
}
