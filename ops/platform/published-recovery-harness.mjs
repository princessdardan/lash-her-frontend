import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { generateKeyPair, exportJWK, exportPKCS8, SignJWT } from "jose";
import { parseArgs } from "node:util";
import { localImageId } from "./local-images.mjs";
import { courseHarnessAuth, disabledCourseWorkerEnvironment, phase2Workers } from "./phase2-harness-profile.mjs";
import { verifyRecoveredWork } from "./host/staging_work.mjs";

// Supplemental owned test; never deploys or connects to a staging database.
const { values: args } = parseArgs({ options: {
  "source-root": { type: "string" }, candidate: { type: "string" }, "rollback-candidate": { type: "string" },
  "docker-host": { type: "string" }, output: { type: "string" },
} });
if (Object.values(args).length !== 5 || !args["docker-host"]?.startsWith("unix://") || existsSync(args.output)) throw new Error("Explicit source/candidates/local socket and new receipt required");
const root = resolve(args["source-root"]);
const selected = JSON.parse(readFileSync(args.candidate, "utf8"));
const previous = JSON.parse(readFileSync(args["rollback-candidate"], "utf8"));
const phase = selected.contractPhase === "p2" ? "p2" : "p1";
if ((previous.contractPhase === "p2" ? "p2" : "p1") !== phase) throw new Error("Compatible harness contract phases required");
const additionalWorkers = phase === "p2" ? phase2Workers : [];
if (execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== selected.sources.frontend) throw new Error("Exact qualified frontend source required");
execFileSync("git", ["-C", root, "diff", "--quiet", "HEAD"]);
const { privateTlsPolicies } = await import(join(root, "ops/platform/configuration.mjs"));
const component = { gateway: "gateway", "course-runtime": "courseRuntime", "course-migration": "courseMigration", "community-runtime": "communityRuntime", "community-migration": "communityMigration" };
for (const candidate of [selected, previous]) for (const key of Object.values(component)) {
  if (!/^ghcr\.io\/princessdardan\/lash-her-platform-[a-z-]+@sha256:[a-f0-9]{64}$/u.test(candidate.images?.[key] ?? "")) throw new Error("Immutable reviewed images required");
}
const postgresImage = "postgres@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6";
const runId = randomUUID();
const project = `lash-p1-${runId}`;
const directory = mkdtempSync(join(tmpdir(), `${project}-`));
chmodSync(directory, 0o755);
const output = join(directory, "out");
mkdirSync(output, { mode: 0o777 }); chmodSync(output, 0o777);
const secret = () => randomBytes(32).toString("hex");
const password = secret(), frontendSecret = secret(), publisherSecret = secret(), readerSecret = secret(), muxSecret = secret(), firstPartySecret = secret(), learnerSecret = secret();
const courseId = randomUUID(), userId = randomUUID();
const cached = (reference) => localImageId((command, commandArgs) => execFileSync(command,
  ["--host", args["docker-host"], ...commandArgs], { encoding: "utf8" }), reference);
const image = (name) => cached(selected.images[component[name]]);
for (const key of ["gateway", "courseRuntime", "communityRuntime"]) cached(previous.images[key]);
const images = Object.fromEntries(["gateway", "course-runtime", "course-migration", "community-runtime", "community-migration"].map((name) => [name, image(name)]));
const environment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
Object.assign(environment, {
  OWNED_DOCKER_SOCKET: args["docker-host"], APP_ENV: "staging", RELEASE_DIR: directory, GATEWAY_IMAGE: images.gateway,
  COURSE_RUNTIME_IMAGE: images["course-runtime"], COURSE_MIGRATION_IMAGE: images["course-migration"],
  COMMUNITY_RUNTIME_IMAGE: images["community-runtime"], COMMUNITY_MIGRATION_IMAGE: images["community-migration"],
});
const composeArgs = ["--host", args["docker-host"], "compose", "--env-file", join(directory, "compose.env"), "--project-name", project, "-f", join(root, "ops/platform/compose.yaml"), "-f", join(directory, "override.yaml")];
const logPath = join(directory, "harness.log");
const log = openSync(logPath, "a", 0o600);
let started = false;
const rounds = [], sqlReceipts = [], transitions = [];
let resultReceipt = { status: "PUBLISHED_RECOVERY_HARNESS_FAILED", runId, currentRelease: selected.releaseId, rollbackRelease: previous.releaseId, contractPhase: phase };

function run(command, args, options = {}) {
  const result = spawnSync(command, command === "docker" ? ["--host", environment.OWNED_DOCKER_SOCKET, ...args] : args, { cwd: root, env: environment, stdio: ["ignore", log, log], timeout: 180_000, ...options });
  if (result.status !== 0) throw new Error("Isolated harness command failed");
  return result;
}
function compose(commandArgs, options) { return run("docker", [...composeArgs.slice(2), ...commandArgs], options); }
function write(name, value, mode = 0o644) {
  const target = join(directory, name); mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value, null, 2), { mode });
}
function envFile(name, values) { write(name, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", 0o600); }
async function waitFor(name, check, milliseconds = 60_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (existsSync(join(output, "results.json")) && JSON.parse(readFileSync(join(output, "results.json"), "utf8")).records.some((record) => !record.passed)) throw new Error(`Harness failed before ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Harness timeout: ${name}`);
}

try {
  mkdirSync(join(directory, "tls/gateway"), { recursive: true });
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(directory, "tls/ca-key.pem"), "-out", join(directory, "tls/ca.pem"), "-subj", "/CN=Isolated P1 fixture CA"]);
  for (const [name, dns] of [["gateway", "gateway.test"], ["course", "course-tls"], ["community", "community-tls"]]) {
    mkdirSync(join(directory, `tls/${name}`), { recursive: true });
    run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, `tls/${name}/key.pem`), "-out", join(directory, `tls/${name}/request.csr`), "-subj", `/CN=${dns}`]);
    write(`tls/${name}/extensions.cnf`, `subjectAltName=DNS:${dns}\n`);
    run("openssl", ["x509", "-req", "-in", join(directory, `tls/${name}/request.csr`), "-CA", join(directory, "tls/ca.pem"), "-CAkey", join(directory, "tls/ca-key.pem"), "-CAcreateserial", "-days", "1", "-out", join(directory, `tls/${name}/cert.pem`), "-extfile", join(directory, `tls/${name}/extensions.cnf`)]);
    chmodSync(join(directory, `tls/${name}/key.pem`), 0o644); // Synthetic one-day fixtures only.
  }
  copyFileSync(join(directory, "tls/ca.pem"), join(directory, "tls/gateway/ca.pem"));
  const pair = await generateKeyPair("RS256", { extractable: true });
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = { iss: "https://oidc.vercel.com/fixture-team", aud: "https://vercel.com/fixture-team",
    sub: "owner:fixture-team:project:fixture-project:environment:production", owner_id: "team_fixture", project_id: "prj_fixture",
    environment: "production", iat: issuedAt, nbf: issuedAt, exp: issuedAt + 3600 };
  write("oidc-private.pem", await exportPKCS8(pair.privateKey));
  write("jwks.json", { keys: [{ ...await exportJWK(pair.publicKey), kid: "fixture", alg: "RS256", use: "sig" }] });
  write("oidc.token", await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "fixture" }).sign(pair.privateKey));
  write("fixture.json", { userId, courseId, claims });
  write("gateway.json", { issuer: claims.iss, audience: claims.aud, subject: claims.sub, ownerId: claims.owner_id,
    projectId: claims.project_id, environment: "production", appEnv: "staging", publicHost: "gateway.test:8443",
    courseOrigin: "https://course-tls:8443", tlsKeyFile: "/tls/key.pem", tlsCertFile: "/tls/cert.pem", upstreamCaFile: "/tls/ca.pem" });
  const policies = privateTlsPolicies(); write("course-tls.json", policies.course); write("community-tls.json", policies.community);
  copyFileSync(join(root, "ops/platform/prometheus.staging.yml"), join(directory, "prometheus.yml"));
  mkdirSync(join(directory, "alerts"));
  for (const name of ["driver", "observer", "authority"]) copyFileSync(join(root, `ops/platform/harness/${name}.mjs`), join(directory, `${name}.mjs`));
  for (const name of ["owned-image-migrate", "owned-grant-seed", "owned-publisher-leases", "owned-admin-fixture", "owned-staging-work"]) copyFileSync(join(import.meta.dirname, `harness/${name}.mjs`), join(directory, `${name}.mjs`));
  copyFileSync(join(import.meta.dirname, "host/staging_fixture.mjs"), join(directory, "staging-fixture.mjs"));
  copyFileSync(join(import.meta.dirname, "host/staging_work.mjs"), join(directory, "staging-work.mjs"));
  write("compose.env", "");
  write("transport-entry.mjs", `export { createGatewayTransport } from ${JSON.stringify(join(root, "src/lib/api-integration/gateway-transport.ts"))};\nexport { ${phase === "p2" ? "runPhase2GatewaySmoke as runGatewaySmoke" : "runGatewaySmoke"} } from ${JSON.stringify(join(root, `src/lib/api-integration/${phase === "p2" ? "phase2-gateway-smoke" : "gateway-smoke"}.ts`))};\n`);
  await build({ entryPoints: [join(directory, "transport-entry.mjs")], outfile: join(directory, "transport.mjs"), bundle: true,
    platform: "node", format: "esm", tsconfig: join(root, "tsconfig.json"),
    alias: { "server-only": join(root, "node_modules/server-only/empty.js") },
    banner: { js: 'import { createRequire as harnessCreateRequire } from "node:module"; const require = harnessCreateRequire(import.meta.url);' } });
  const database = (name) => ({ DATABASE_TARGET: "test", TEST_DATABASE_URL: `postgresql://postgres:${password}@postgres:5432/lash_her_${name}_p1_test?sslmode=disable` });
  const muxPair = await generateKeyPair("RS256", { extractable: true });
  envFile("course-api.env", { ...database("course"), ...courseHarnessAuth(phase, { frontendSecret, adminSecret: firstPartySecret, learnerSecret }),
    COURSE_COMMUNITY_READ_JWT_CURRENT_SECRET: readerSecret,
    ...(phase === "p2" ? { MUX_ENVIRONMENT_ID: "owned-fixture", MUX_CORS_ORIGIN: "https://gateway.test:8443" } : {}), MUX_TOKEN_ID: "isolated-fixture", MUX_TOKEN_SECRET: secret(), MUX_WEBHOOK_SECRET: muxSecret,
    MUX_SIGNING_KEY_ID: "isolated-fixture", MUX_SIGNING_PRIVATE_KEY: Buffer.from(await exportPKCS8(muxPair.privateKey)).toString("base64") });
  envFile("course-publisher.env", { ...database("course"), COMMUNITY_ENROLLMENT_PUBLISHER_JWT_CURRENT_SECRET: publisherSecret });
  envFile("course-snapshot.env", database("course"));
  for (const worker of phase2Workers) envFile(`${worker}.env`, disabledCourseWorkerEnvironment(database("course").TEST_DATABASE_URL, worker));
  envFile("community-api.env", { ...database("community"), COURSE_PUBLISHER_JWT_CURRENT_SECRET: publisherSecret, COMMUNITY_READER_JWT_CURRENT_SECRET: readerSecret });
  envFile("community-worker.env", { ...database("community"), COMMUNITY_READER_JWT_CURRENT_SECRET: readerSecret });
  envFile("driver.env", { VERCEL_OIDC_TOKEN_FILE: "/test/oidc.token", HARNESS_CONTRACT_PHASE: phase, HARNESS_FRONTEND_SECRET: frontendSecret, HARNESS_MUX_SECRET: muxSecret,
    HARNESS_FIRST_PARTY_SECRET: firstPartySecret, HARNESS_COURSE_ADMIN_SECRET: firstPartySecret, OWNED_RECOVERY_FIXTURE: "1", NODE_ENV: "test" });
  envFile("postgres.env", { POSTGRES_PASSWORD: password });
  const mounts = `      - ${directory}:/test:ro\n      - ${output}:/test/out:rw\n`;
  const appOverride = (name) => `  ${name}:\n    environment: {NODE_ENV: development}\n    networks: {test_database: {}}\n    volumes:\n${mounts}`;
  write("override.yaml", `services:\n  postgres:\n    image: ${postgresImage}\n    user: "999:999"\n    cap_drop: [ALL]\n    security_opt: [no-new-privileges:true]\n    tmpfs: ["/var/lib/postgresql:rw,uid=999,gid=999"]\n    mem_limit: 768m\n    cpus: 1\n    env_file: [${directory}/postgres.env]\n    networks: [test_database]\n  gateway:\n    restart: "no"\n    ports: !reset []\n    command: [node, /test/driver.mjs]\n    env_file: [${directory}/driver.env]\n    environment: {NODE_EXTRA_CA_CERTS: /test/tls/ca.pem}\n    networks:\n      mesh: {aliases: [gateway.test]}\n    volumes:\n${mounts}  observer:\n    restart: "no"\n    read_only: true\n    cap_drop: [ALL]\n    security_opt: [no-new-privileges:true]\n    pids_limit: 64\n    mem_limit: 128m\n    cpus: 0.25\n    networks: {mesh: {ipv4_address: 172.29.10.60}}\n    image: ${images.gateway}\n    user: "65532:65532"\n    command: [node, /test/observer.mjs]\n    environment: {NODE_EXTRA_CA_CERTS: /test/tls/ca.pem}\n    volumes:\n${mounts}${["course-api", "course-publisher", "course-snapshot", "community-api", "community-worker", ...additionalWorkers].map(appOverride).join("")}networks:\n  test_database: {internal: true}\n${["gateway_egress", "course_api_egress", "publisher_egress", "snapshot_egress", "community_api_egress", "community_worker_egress", "course_media_egress", "course_export_cleanup_egress"].map((name) => `  ${name}: {internal: true}\n`).join("")}`);
  started = true;
  // Refuse a topology with any host publication before starting a container.
  const config = JSON.parse(compose(["config", "--format", "json"], { stdio: ["ignore", "pipe", log] }).stdout);
  if (Object.values(config.services).some((service) => service.ports?.length)) throw new Error("Owned fixture must publish no host port");
  compose(["up", "--pull", "never", "-d", "postgres"]);
  await waitFor("postgres", () => spawnSync("docker", [...composeArgs, "exec", "-T", "postgres", "pg_isready", "-U", "postgres"], { env: environment, stdio: "ignore" }).status === 0);
  const sql = (name, statement) => JSON.parse(compose(["exec", "-T", "postgres", "psql", "-U", "postgres", "-d", `lash_her_${name}_p1_test`, "-v", "ON_ERROR_STOP=1", "-A", "-t", "-c", statement], { stdio: ["ignore", "pipe", log] }).stdout.toString().trim());
  for (const name of ["course", "community"]) {
    compose(["exec", "-T", "postgres", "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE lash_her_${name}_p1_test`]);
    const migrated = run("docker", ["run", "--rm", "--pull=never", "--network", `${project}_test_database`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--memory=512m", "--pids-limit=128",
      "--env-file", join(directory, `${name}-api.env`), "-e", "NODE_ENV=test", "-e", "OWNED_RECOVERY_FIXTURE=1", "--mount", `type=bind,source=${directory},target=/test,readonly`, images[`${name}-migration`], "node", "/test/owned-image-migrate.mjs"], { stdio: ["ignore", "pipe", log] });
    const receipt = JSON.parse(migrated.stdout.toString());
    if (receipt.status !== "OWNED_PUBLISHED_SQL_APPLIED_ONCE") throw new Error("Owned migration did not complete");
    sqlReceipts.push(receipt);
  }
  const seed = (fixture) => compose(["exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "lash_her_course_p1_test", "-v", "ON_ERROR_STOP=1", "-c",
    `INSERT INTO users(id) VALUES('${fixture.userId}'); INSERT INTO courses(id,slug,title,status,price_cents,currency) VALUES('${fixture.courseId}','fixture-${fixture.courseId}','P1 fixture','published',0,'CAD');`]);
  const workerProbe = "Promise.all([fetch('http://127.0.0.1:'+process.env.PORT+'/ready'),fetch('http://127.0.0.1:'+process.env.PORT+'/metrics')]).then(async([r,m])=>{if(!r.ok||!m.ok||!/_enabled 0\\b/u.test(await m.text()))process.exit(1)}).catch(()=>process.exit(1))";
  const services = ["gateway", "course-api", "course-tls", "course-publisher", "course-snapshot", "community-api", "community-tls", "community-worker", ...additionalWorkers];
  const snapshots = () => ({
    course: sql("course", `SELECT json_build_object('users',(SELECT coalesce(json_agg(t),'[]') FROM (SELECT id FROM users ORDER BY id) t),'courses',(SELECT coalesce(json_agg(t),'[]') FROM (SELECT id,slug,status FROM courses ORDER BY id) t),'enrollments',(SELECT coalesce(json_agg(t),'[]') FROM (SELECT id,user_id,course_id,status,source FROM enrollments ORDER BY id) t),'grants',(SELECT coalesce(json_agg(t),'[]') FROM (SELECT * FROM entitlement_grants ORDER BY id) t))`),
    community: sql("community", `SELECT json_build_object('projections',(SELECT coalesce(json_agg(t),'[]') FROM (SELECT stream_id,user_id,course_id,state,applied_version,highest_observed_version,status FROM course_enrollment_projections ORDER BY stream_id) t),'inbox',(SELECT coalesce(json_agg(t),'[]') FROM (SELECT event_id,canonical_digest,status FROM course_enrollment_inbox ORDER BY event_id) t))`),
  });
  const preserves = (before, after) => Object.entries(before).every(([owner, tables]) => Object.entries(tables).every(([table, rows]) => rows.every((row) => after[owner][table].some((value) => JSON.stringify(value) === JSON.stringify(row)))));
  let priorData, carriedEvents, fixture = { userId, courseId };
  seed(fixture);
  for (const [index, candidate] of [selected, previous, selected].entries()) {
    environment.GATEWAY_IMAGE = candidate.images.gateway;
    environment.COURSE_RUNTIME_IMAGE = candidate.images.courseRuntime;
    environment.COMMUNITY_RUNTIME_IMAGE = candidate.images.communityRuntime;
    write("fixture.json", { ...fixture, claims });
    for (const name of ["results.json", "grant.json", "authority.json", "restart-ready.json", "restarted.json"]) rmSync(join(output, name), { force: true });
    compose(["up", "--pull", "never", "-d", "--force-recreate", "observer", "course-publisher", "course-snapshot", ...additionalWorkers, "gateway"]);
    for (const worker of additionalWorkers) await waitFor(`${worker} disabled readiness`, () => spawnSync("docker", [...composeArgs, "exec", "-T", worker, "node", "-e", workerProbe], { env: environment, stdio: "ignore" }).status === 0, 90_000);
    await waitFor("grant", () => existsSync(join(output, "grant.json")), 90_000);
    // Initial reconciliation can otherwise populate the projection before the
    // publisher, changing its valid outcome to superseded. Start that worker
    // after an actual inbox application and corresponding outbox delivery;
    // preserve the stronger original applied-event assertion deterministically.
    let initialPublication;
    await waitFor("actual publisher inbox application", () => {
      const inbox = sql("community", `SELECT coalesce(json_agg(t),'[]') FROM (SELECT event_id,canonical_digest FROM course_enrollment_inbox WHERE user_id='${fixture.userId}' AND course_id='${fixture.courseId}' AND status='applied' ORDER BY event_id) t`);
      if (!inbox.length) return false;
      const delivered = sql("course", `SELECT coalesce(json_agg(t),'[]') FROM (SELECT event_id,canonical_digest,state FROM community_enrollment_outbox WHERE event_id IN (${inbox.map((row) => `'${row.event_id}'`).join(",")}) ORDER BY event_id) t`);
      if (!inbox.every((row) => delivered.some((event) => event.event_id === row.event_id && event.canonical_digest === row.canonical_digest && event.state === "delivered"))) return false;
      initialPublication = { inboxApplied: inbox.length, sourceOutboxDelivered: delivered.length };
      return true;
    }, 90_000);
    compose(["up", "--pull", "never", "-d", "community-worker"]);
    compose(["exec", "-T", "community-api", "node", "/test/authority.mjs"]);
    await waitFor("restart readiness", () => existsSync(join(output, "restart-ready.json")), 90_000);
    compose(["restart", "community-worker"]);
    write("out/restarted.json", { restarted: true });
    await waitFor("results", () => existsSync(join(output, "results.json")), 90_000);
    const result = JSON.parse(readFileSync(join(output, "results.json"), "utf8"));
    if (result.records.some((record) => !record.passed)) throw new Error("Published cross-application check failed");
    const runningImages = services.map((service) => {
      const id = compose(["ps", "-a", "-q", service], { stdio: ["ignore", "pipe", log] }).stdout.toString().trim();
      const actual = JSON.parse(run("docker", ["inspect", "--format", '{"reference":{{json .Config.Image}},"localImageId":{{json .Image}}}', id], { stdio: ["ignore", "pipe", log] }).stdout);
      const expected = candidate.images[service === "gateway" || service.endsWith("-tls") ? "gateway" : service.startsWith("course-") ? "courseRuntime" : "communityRuntime"];
      if (actual.reference !== expected) throw new Error("Published running image differs from selected digest");
      return { service, containerId: id, ...actual };
    });
    const data = snapshots();
    if (priorData && !preserves(priorData, data)) throw new Error("Prior business data changed during application replacement");
    let recovered = [];
    if (carriedEvents) {
      recovered = sql("course", `SELECT json_agg(t) FROM (SELECT event_id,canonical_digest,state,lease_owner,lease_expires_at,delivered_at,attempts_in_cycle FROM community_enrollment_outbox WHERE event_id IN (${carriedEvents.map((event) => `'${event.eventId}'`).join(",")}) ORDER BY event_id) t`);
      for (const event of carriedEvents) {
        const row = recovered.find((row) => row.event_id === event.eventId);
        if (!row || row.canonical_digest !== event.canonicalDigest || row.state !== "delivered" || row.lease_owner !== null || row.lease_expires_at !== null || Date.parse(row.delivered_at) < Date.parse(event.notBefore) || (event.kind === "scheduled-retry" && row.attempts_in_cycle < 1)) throw new Error("Durable lease/retry recovery failed");
      }
    }
    rounds.push({ phase: ["current", "compatible-rollback", "restore-current"][index], releaseId: candidate.releaseId, records: result.records, runningImages, initialPublication,
      preservedPriorBusinessRows: !priorData || preserves(priorData, data), dataSha256: createHash("sha256").update(JSON.stringify(data)).digest("hex"), recoveredPendingEvents: recovered.length });
    priorData = data;
    // Exercise the production gateway daemon's start and SIGTERM path as well
    // as the owned request driver. Its current OIDC issuer is synthetic.
    compose(["rm", "-f", "gateway"]);
    write("gateway-daemon.yaml", "services:\n  gateway:\n    command: [node, server.mjs]\n");
    run("docker", [...composeArgs.slice(2), "-f", join(directory, "gateway-daemon.yaml"), "up", "--pull", "never", "-d", "--no-deps", "gateway"]);
    await waitFor("production gateway daemon health", () => spawnSync("docker", [...composeArgs, "exec", "-T", "gateway", "node", "-e", "fetch('http://127.0.0.1:9100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { env: environment, stdio: "ignore" }).status === 0);
    const next = [{ userId: randomUUID(), courseId: randomUUID() }, { userId: randomUUID(), courseId: randomUUID() }];
    if (index < 2) {
      compose(["stop", "-t", "30", "course-publisher"]);
      compose(["rm", "-s", "-f", "gateway"]);
      if (index === 0) {
        // Use ordinary administrator APIs rather than a SQL seed for the
        // controlled live-action fixture. Keep reconciliation stopped until
        // the actual publisher has delivered both newly created events.
        compose(["stop", "-t", "30", "community-worker"]);
        const created = compose(["run", "--rm", "--no-deps", "gateway", "node", "/test/owned-admin-fixture.mjs"], { stdio: ["ignore", "pipe", log] });
        const fixtureProof = JSON.parse(created.stdout.toString());
        if (fixtureProof.status !== "STAGING_FIXTURE_TWO_GRANTS_CREATED" || fixtureProof.grants.length !== 2) throw new Error("Ordinary API fixture failed");
        write("admin-fixture.json", fixtureProof);
        const retained = run("docker", ["run", "--rm", "--pull=never", "--network", `${project}_test_database`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--memory=256m", "--pids-limit=64", "--env-file", join(directory, "course-api.env"), "-e", "NODE_ENV=test", "-e", "OWNED_RECOVERY_FIXTURE=1", "--mount", `type=bind,source=${directory},target=/test,readonly`, candidate.images.courseRuntime, "node", "/test/owned-staging-work.mjs"], { stdio: ["ignore", "pipe", log] });
        const retainedWork = JSON.parse(retained.stdout.toString());
        if (retainedWork.status !== "STAGING_DURABLE_WORK_RETAINED") throw new Error("Exact staging-work coordinator failed");
        compose(["up", "--pull", "never", "-d", "--no-deps", "course-publisher"]);
        let delivered, inbox;
        await waitFor("ordinary administrator fixture publication", () => {
          delivered = sql("course", `SELECT coalesce(json_agg(t),'[]') FROM (SELECT o.event_id,o.canonical_digest,o.state FROM community_enrollment_outbox o JOIN community_enrollment_streams s ON s.id=o.stream_id WHERE s.course_id='${fixtureProof.courseId}' ORDER BY o.event_id) t`);
          inbox = sql("community", `SELECT coalesce(json_agg(t),'[]') FROM (SELECT event_id,canonical_digest,status FROM course_enrollment_inbox WHERE course_id='${fixtureProof.courseId}' ORDER BY event_id) t`);
          return delivered.length === 2 && inbox.length === 2 && delivered.every(event => event.state === "delivered"
            && inbox.some(row => row.event_id === event.event_id && row.canonical_digest === event.canonical_digest && row.status === "applied"));
        }, 90_000);
        const recoveredRows = sql("course", `SELECT json_agg(t) FROM (SELECT o.event_id AS "eventId",o.canonical_digest AS "canonicalDigest",o.state,o.lease_owner AS "leaseOwner",o.lease_expires_at AS "leaseExpiresAt",o.delivered_at AS "deliveredAt",o.attempts_in_cycle AS "attemptsInCycle" FROM community_enrollment_outbox o JOIN community_enrollment_streams s ON s.id=o.stream_id WHERE s.course_id='${fixtureProof.courseId}' ORDER BY o.event_id) t`);
        const recoveredWork = verifyRecoveredWork(retainedWork, recoveredRows, inbox.map(row => ({ eventId: row.event_id, canonicalDigest: row.canonical_digest, status: row.status })));
        const preserved = snapshots();
        priorData = preserved;
        rounds.at(-1).ordinaryAdminFixture = { ...fixtureProof, retainedWork, recoveredWork, outboxDelivered: delivered.length, inboxApplied: inbox.length,
          preservedDataSha256: createHash("sha256").update(JSON.stringify(preserved)).digest("hex") };
        compose(["stop", "-t", "30", "course-publisher"]);
        compose(["up", "--pull", "never", "-d", "--no-deps", "community-worker"]);
      }
      for (const value of next) seed(value);
      write("seed-grants.json", next);
      compose(["run", "--rm", "--no-deps", "gateway", "node", "/test/owned-grant-seed.mjs"]);
      const leased = run("docker", ["run", "--rm", "--pull=never", "--network", `${project}_test_database`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--memory=256m", "--pids-limit=64", "--env-file", join(directory, "course-api.env"), "-e", "NODE_ENV=test", "-e", "OWNED_RECOVERY_FIXTURE=1", "--mount", `type=bind,source=${directory},target=/test,readonly`, candidate.images.courseRuntime, "node", "/test/owned-publisher-leases.mjs"], { stdio: ["ignore", "pipe", log] });
      const leaseReceipt = JSON.parse(leased.stdout.toString());
      if (leaseReceipt.status !== "OWNED_LEASE_AND_RETRY_RETAINED") throw new Error("Owned pending state not retained");
      carriedEvents = leaseReceipt.events; fixture = next[0];
      transitions.push({ fromRelease: candidate.releaseId, pendingState: leaseReceipt });
      // Recreate the daemon before the common stop, to retain its exit status.
      run("docker", [...composeArgs.slice(2), "-f", join(directory, "gateway-daemon.yaml"), "up", "--pull", "never", "-d", "--no-deps", "gateway"]);
      await waitFor("replacement gateway daemon health", () => spawnSync("docker", [...composeArgs, "exec", "-T", "gateway", "node", "-e", "fetch('http://127.0.0.1:9100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { env: environment, stdio: "ignore" }).status === 0);
    }
    const beforeStop = Date.now();
    compose(["stop", "-t", "30", ...services]);
    const statuses = services.map((service) => {
      const id = compose(["ps", "-a", "-q", service], { stdio: ["ignore", "pipe", log] }).stdout.toString().trim();
      const state = JSON.parse(run("docker", ["inspect", "--format", "{{json .State}}", id], { stdio: ["ignore", "pipe", log] }).stdout);
      return { service, containerId: id, running: state.Running, exitCode: state.ExitCode, oomKilled: state.OOMKilled,
        startedAt: state.StartedAt, finishedAt: state.FinishedAt };
    });
    rounds.at(-1).gracefulStop = { durationMs: Date.now() - beforeStop, processes: statuses };
    const failed = statuses.filter((state) => state.running || state.exitCode !== 0 || state.oomKilled);
    if (failed.length) throw new Error(`Process failed graceful stop: ${failed.map((state) => state.service).join(",")}`);
  }
  resultReceipt = { ...resultReceipt, status: "PUBLISHED_APPLICATION_ROLLBACK_AND_DURABLE_RECOVERY_PASS", images: selected.images, rollbackImages: previous.images,
    rounds, transitions, ownedMigrations: sqlReceipts, applicationVersionOverlapped: false, strategy: "maintenance window: stop all current processes before replacing images", frontendSource: selected.sources.frontend,
    actualStagingChanged: false, productionChanged: false, vmRecreationVerified: false, nativeSchedulerVerified: false };

} catch (error) {
  resultReceipt = { ...resultReceipt, rounds, transitions, ownedMigrations: sqlReceipts, reason: error instanceof Error && /^(?:Published|Owned|Prior|Durable|Process|Isolated|Harness)/u.test(error.message) ? error.message : "Owned recovery fixture failed" };
  process.exitCode = 1;
} finally {
  if (started) spawnSync("docker", [...composeArgs, "logs", "--no-color"], { env: environment, stdio: ["ignore", log, log], timeout: 10_000 });
  const cleanup = started ? spawnSync("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"], { env: environment, stdio: ["ignore", log, log], timeout: 60_000 }) : { status: 0 };
  resultReceipt.cleanupPassed = cleanup.status === 0;
  if (!resultReceipt.cleanupPassed) { resultReceipt.status = "PUBLISHED_RECOVERY_HARNESS_CLEANUP_REQUIRES_REVIEW"; process.exitCode = 1; }
  closeSync(log);
  resultReceipt.fixtureDirectory = directory;
  // All credentials are synthetic, but still discard them after owned cleanup.
  for (const name of ["tls", "oidc-private.pem", "oidc.token", "driver.env", "postgres.env", "course-api.env", "course-publisher.env", "course-snapshot.env", "community-api.env", "community-worker.env", "course-media.env", "course-export-cleanup.env"]) rmSync(join(directory, name), { recursive: true, force: true });
}

resultReceipt.fixtureHashes = Object.fromEntries(["owned-image-migrate", "owned-grant-seed", "owned-publisher-leases", "owned-admin-fixture", "owned-staging-work"].map((name) => [name, createHash("sha256").update(readFileSync(join(import.meta.dirname, `harness/${name}.mjs`))).digest("hex")]));
resultReceipt.stagingFixtureSha256 = createHash("sha256").update(readFileSync(join(import.meta.dirname, "host/staging_fixture.mjs"))).digest("hex");
resultReceipt.stagingWorkSha256 = createHash("sha256").update(readFileSync(join(import.meta.dirname, "host/staging_work.mjs"))).digest("hex");
resultReceipt.runnerSha256 = createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex");
writeFileSync(args.output, JSON.stringify(resultReceipt, null, 2) + "\n", { flag: "wx", mode: 0o644 });
process.stdout.write(JSON.stringify(resultReceipt) + "\n");
