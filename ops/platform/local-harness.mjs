import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { generateKeyPair, exportJWK, exportPKCS8, SignJWT } from "../gateway/node_modules/jose/dist/webapi/index.js";
import { privateTlsPolicies } from "./configuration.mjs";
import { localImageId } from "./local-images.mjs";

const root = resolve(import.meta.dirname, "../..");
const runId = randomUUID();
const project = `lash-p1-${runId}`;
const directory = mkdtempSync(join(tmpdir(), `${project}-`));
chmodSync(directory, 0o755);
const output = join(directory, "out");
mkdirSync(output, { mode: 0o777 }); chmodSync(output, 0o777);
const secret = () => randomBytes(32).toString("hex");
const password = secret(), frontendSecret = secret(), publisherSecret = secret(), readerSecret = secret(), muxSecret = secret();
const courseId = randomUUID(), userId = randomUUID();
const image = (name) => localImageId((command, args) => execFileSync(command, args, { encoding: "utf8" }), `lash-her-${name}:p1-local`);
const images = Object.fromEntries(["gateway", "course-runtime", "course-migration", "community-runtime", "community-migration"].map((name) => [name, image(name)]));
const environment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
Object.assign(environment, {
  APP_ENV: "staging", RELEASE_DIR: directory, GATEWAY_IMAGE: images.gateway,
  COURSE_RUNTIME_IMAGE: images["course-runtime"], COURSE_MIGRATION_IMAGE: images["course-migration"],
  COMMUNITY_RUNTIME_IMAGE: images["community-runtime"], COMMUNITY_MIGRATION_IMAGE: images["community-migration"],
});
const composeArgs = ["compose", "--project-name", project, "-f", join(import.meta.dirname, "compose.yaml"), "-f", join(directory, "override.yaml")];
const logPath = join(directory, "harness.log");
const log = openSync(logPath, "a", 0o600);
let started = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env: environment, stdio: ["ignore", log, log], timeout: 180_000, ...options });
  if (result.status !== 0) throw new Error("Isolated harness command failed");
  return result;
}
function compose(args, options) { return run("docker", [...composeArgs, ...args], options); }
function write(name, value, mode = 0o644) {
  const target = join(directory, name); mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value, null, 2), { mode });
}
function envFile(name, values) { write(name, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", 0o600); }
async function waitFor(name, check, milliseconds = 60_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (existsSync(join(output, "results.json"))) throw new Error(`Harness ended before ${name}`);
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
  copyFileSync(join(import.meta.dirname, "prometheus.staging.yml"), join(directory, "prometheus.yml"));
  mkdirSync(join(directory, "alerts"));
  for (const name of ["driver", "observer", "authority"]) copyFileSync(join(import.meta.dirname, `harness/${name}.mjs`), join(directory, `${name}.mjs`));
  write("transport-entry.mjs", `export { createGatewayTransport } from ${JSON.stringify(join(root, "src/lib/api-integration/gateway-transport.ts"))};\nexport { runGatewaySmoke } from ${JSON.stringify(join(root, "src/lib/api-integration/gateway-smoke.ts"))};\n`);
  await build({ entryPoints: [join(directory, "transport-entry.mjs")], outfile: join(directory, "transport.mjs"), bundle: true,
    platform: "node", format: "esm", tsconfig: join(root, "tsconfig.json"),
    alias: { "server-only": join(root, "node_modules/server-only/empty.js") },
    banner: { js: 'import { createRequire as harnessCreateRequire } from "node:module"; const require = harnessCreateRequire(import.meta.url);' } });
  const database = (name) => ({ DATABASE_TARGET: "test", TEST_DATABASE_URL: `postgresql://postgres:${password}@postgres:5432/lash_her_${name}_p1_test?sslmode=disable` });
  const muxPair = await generateKeyPair("RS256", { extractable: true });
  envFile("course-api.env", { ...database("course"), FIRST_PARTY_AUTH_SECRET: secret(), INTERNAL_SERVICE_JWT_SECRET: frontendSecret,
    INTERNAL_SERVICE_JWT_ISSUER: "lash-her-frontend", INTERNAL_SERVICE_JWT_AUDIENCE: "lash-her-course-api", INTERNAL_SERVICE_JWT_ALLOWED_SUBJECTS: "lash-her-frontend",
    COURSE_COMMUNITY_READ_JWT_CURRENT_SECRET: readerSecret, MUX_TOKEN_ID: "isolated-fixture", MUX_TOKEN_SECRET: secret(), MUX_WEBHOOK_SECRET: muxSecret,
    MUX_SIGNING_KEY_ID: "isolated-fixture", MUX_SIGNING_PRIVATE_KEY: Buffer.from(await exportPKCS8(muxPair.privateKey)).toString("base64") });
  envFile("course-publisher.env", { ...database("course"), COMMUNITY_ENROLLMENT_PUBLISHER_JWT_CURRENT_SECRET: publisherSecret });
  envFile("course-snapshot.env", database("course"));
  envFile("community-api.env", { ...database("community"), COURSE_PUBLISHER_JWT_CURRENT_SECRET: publisherSecret, COMMUNITY_READER_JWT_CURRENT_SECRET: readerSecret });
  envFile("community-worker.env", { ...database("community"), COMMUNITY_READER_JWT_CURRENT_SECRET: readerSecret });
  envFile("driver.env", { VERCEL_OIDC_TOKEN_FILE: "/test/oidc.token", HARNESS_FRONTEND_SECRET: frontendSecret, HARNESS_MUX_SECRET: muxSecret });
  envFile("postgres.env", { POSTGRES_PASSWORD: password });
  const mounts = `      - ${directory}:/test:ro\n      - ${output}:/test/out:rw\n`;
  const appOverride = (name) => `  ${name}:\n    environment: {NODE_ENV: development}\n    networks: {test_database: {}}\n    volumes:\n${mounts}`;
  write("override.yaml", `services:\n  postgres:\n    image: postgres:16\n    env_file: [${directory}/postgres.env]\n    ports: ["127.0.0.1::5432"]\n    networks: [test_database]\n  gateway:\n    restart: "no"\n    ports: !reset []\n    command: [node, /test/driver.mjs]\n    env_file: [${directory}/driver.env]\n    environment: {NODE_EXTRA_CA_CERTS: /test/tls/ca.pem}\n    networks:\n      mesh: {aliases: [gateway.test]}\n    volumes:\n${mounts}  observer:\n    restart: "no"\n    read_only: true\n    cap_drop: [ALL]\n    security_opt: [no-new-privileges:true]\n    pids_limit: 64\n    mem_limit: 128m\n    cpus: 0.25\n    networks: {mesh: {ipv4_address: 172.29.10.60}}\n    image: ${images.gateway}\n    user: "65532:65532"\n    command: [node, /test/observer.mjs]\n    environment: {NODE_EXTRA_CA_CERTS: /test/tls/ca.pem}\n    volumes:\n${mounts}${["course-api", "course-publisher", "course-snapshot", "community-api", "community-worker"].map(appOverride).join("")}networks:\n  test_database: {}\n`);
  started = true; compose(["up", "-d", "postgres"]);
  const portResult = spawnSync("docker", [...composeArgs, "port", "postgres", "5432"], { env: environment, encoding: "utf8" });
  const hostPort = portResult.stdout?.trim();
  if (!/^127\.0\.0\.1:[0-9]+$/u.test(hostPort)) throw new Error("Harness DB is not loopback-bound");
  await waitFor("postgres", () => spawnSync("docker", [...composeArgs, "exec", "-T", "postgres", "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], { env: environment, stdio: "ignore" }).status === 0);
  for (const name of ["course", "community"]) {
    compose(["exec", "-T", "postgres", "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE lash_her_${name}_p1_test`]);
    run("npm", ["run", "db:migrate"], { cwd: resolve(root, `../lash-her-${name}-api`), env: { ...environment,
      NODE_ENV: "test", DATABASE_TARGET: "test", DATABASE_URL: "", DEV_DATABASE_URL: "", STAGING_DATABASE_URL: "", PROD_DATABASE_URL: "",
      TEST_DATABASE_URL: `postgresql://postgres:${password}@${hostPort}/lash_her_${name}_p1_test?sslmode=disable` } });
  }
  compose(["exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "lash_her_course_p1_test", "-v", "ON_ERROR_STOP=1", "-c",
    `INSERT INTO users(id) VALUES('${userId}'); INSERT INTO courses(id,slug,title,status,price_cents,currency) VALUES('${courseId}','p1-fixture','P1 fixture','published',0,'CAD');`]);
  compose(["up", "-d", "observer", "course-publisher", "course-snapshot", "community-worker", "gateway"]);
  await waitFor("grant", () => existsSync(join(output, "grant.json")));
  compose(["exec", "-T", "community-api", "node", "/test/authority.mjs"]);
  await waitFor("restart readiness", () => existsSync(join(output, "restart-ready.json")));
  compose(["restart", "community-worker"]);
  write("out/restarted.json", { restarted: true });
  await waitFor("results", () => existsSync(join(output, "results.json")));
  const result = JSON.parse(readFileSync(join(output, "results.json"), "utf8"));
  process.stdout.write(JSON.stringify({ runId, images, ...result, directory }) + "\n");
  if (result.records.some((record) => !record.passed)) process.exitCode = 1;
} catch (error) {
  process.stdout.write(JSON.stringify({ runId, passed: false, reason: error.message, directory }) + "\n");
  process.exitCode = 1;
} finally {
  if (started) spawnSync("docker", [...composeArgs, "logs", "--no-color"], { env: environment, stdio: ["ignore", log, log], timeout: 10_000 });
  if (started) spawnSync("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"], { env: environment, stdio: ["ignore", log, log], timeout: 60_000 });
  closeSync(log);
  // All credentials are synthetic, but still discard them after owned cleanup.
  for (const name of ["tls", "oidc-private.pem", "oidc.token", "driver.env", "postgres.env", "course-api.env", "course-publisher.env", "course-snapshot.env", "community-api.env", "community-worker.env"]) rmSync(join(directory, name), { recursive: true, force: true });
}
