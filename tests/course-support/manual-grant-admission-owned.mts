// Disposable loopback TLS/SCRAM admission fixture. No configured DB URL is read.
// Course/provider replies are modeled here; the browser fixture runs real Course.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Client } from "pg";
import { changeFrontendAdmission } from "../../ops/platform/frontend-admission.mjs";
import { createWriterAdmissionRunner } from "@/lib/writer-admission/runtime";
import { AdminAuthError, type AdminActor } from "@/lib/admin/types";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";
import { currentWriterOperationIdentity, markWriterOperationUncertain } from "@/lib/writer-admission/context";

const bins = process.env.PG_BIN;
if (!bins?.startsWith("/") || process.env.P2Q_MANUAL_GRANT_OWNED !== "true") throw new Error("OWNED_MANUAL_GRANT_CONFIGURATION_REQUIRED");
const safe = { NODE_ENV: "test" as const, ...Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : [])) };
const execute = (name: string, args: string[]) => execFileSync(name, args, { env: safe, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const major = Number(/PostgreSQL\) (16|18)\./u.exec(execute(join(bins, "postgres"), ["--version"]))?.[1]);
assert.ok([16, 18].includes(major));
const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve()));
const directory = mkdtempSync(join(tmpdir(), "p2q-grant-admission-")), data = join(directory, "data");
const password = `owned-${randomUUID()}`, sourceSha = "c".repeat(40), producerSha256 = "b".repeat(64), targetSha256 = "a".repeat(64);
let started = false, owner: Client | undefined, admin: Client | undefined;
let summary: Record<string, unknown> | undefined;
try {
  execute(join(bins, "initdb"), ["-D", data, "-A", "trust", "-U", "p2q_test_admin", "-E", "UTF8", "--locale=C"]);
  const certificate = join(directory, "server.crt"), key = join(directory, "server.key");
  execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", certificate]);
  chmodSync(key, 0o600);
  writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${certificate}'\nssl_key_file='${key}'\npassword_encryption='scram-sha-256'\n`);
  writeFileSync(join(data, "pg_hba.conf"), "local all all trust\nhostssl all p2q_test_admin 127.0.0.1/32 trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n");
  execute(join(bins, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"]); started = true;
  const tls = { rejectUnauthorized: true as const, ca: readFileSync(certificate, "utf8") };
  const base = { host: "127.0.0.1", port, ssl: tls, password, connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 1000 };
  admin = new Client({ ...base, database: "postgres", user: "p2q_test_admin" }); await admin.connect();
  await admin.query("CREATE DATABASE p2q_grant_owned");
  await admin.query("CREATE ROLE p2q_admission_owner NOLOGIN NOINHERIT");
  await admin.query(`CREATE ROLE p2q_grant_runtime LOGIN NOINHERIT PASSWORD '${password}'`);
  owner = new Client({ ...base, database: "p2q_grant_owned", user: "p2q_test_admin" }); await owner.connect();
  await owner.query("GRANT CREATE ON DATABASE p2q_grant_owned TO p2q_admission_owner");
  await owner.query("BEGIN"); await owner.query("SET LOCAL ROLE p2q_admission_owner");
  await owner.query(readFileSync(new URL("../../ops/platform/frontend-admission.sql", import.meta.url), "utf8"));
  await owner.query("INSERT INTO frontend_admission.control(environment,target_sha256) VALUES('staging',$1)", [targetSha256]);
  await owner.query("INSERT INTO frontend_admission.producers(producer_sha256,source_sha,database_role,enabled) VALUES($1,$2,'p2q_grant_runtime'::regrole::oid,true)", [producerSha256, sourceSha]);
  await owner.query("GRANT USAGE ON SCHEMA frontend_admission TO p2q_grant_runtime");
  await owner.query("GRANT EXECUTE ON ALL ROUTINES IN SCHEMA frontend_admission TO p2q_grant_runtime"); await owner.query("COMMIT");
  const run = createWriterAdmissionRunner({ getConfiguration: () => ({ target: { environment: "staging", host: "127.0.0.1", port, database: "p2q_grant_owned", user: "p2q_grant_runtime", serverMajor: major as 16 | 18, targetSha256 },
    sourceSha, producerSha256, connection: { ...base, database: "p2q_grant_owned", user: "p2q_grant_runtime", enableChannelBinding: true, application_name: "owned-manual-grant" } }) });
  // Load the actual page with only identity and Course reads modeled. Its real
  // semantic parent, runner, SQL ledger, navigation and unavailable view execute.
  const pageActor: AdminActor = { bookingProviderResourceIds: [], bookingResourceIds: [], user: {
    id: randomUUID(), email: "owned@example.invalid", emailNormalized: "owned@example.invalid", displayName: null,
    providerUserId: "owned", role: "owner", status: "active" } };
  let actor = pageActor, authError: Error | undefined, courseError: Error | undefined, uncertainAuth = false, authCalls = 0, reads = 0;
  const pageCourseId = randomUUID();
  const mocks = [
    mock.module(new URL("../../src/lib/writer-admission/runtime.ts", import.meta.url), { namedExports: { createWriterAdmissionRunner, runWriterAdmission: run } }),
    mock.module(new URL("../../src/lib/admin/auth.ts", import.meta.url), { namedExports: { requirePermission: async (permission: string) => {
      assert.equal(permission, "courses:support"); assert.ok(currentWriterOperationIdentity()); authCalls++;
      if (uncertainAuth) markWriterOperationUncertain();
      if (authError) throw authError; return actor;
    } } }),
    mock.module(new URL("../../src/lib/api-integration/course-client.ts", import.meta.url), { namedExports: { getCourseClient: () => ({ getAdminCourse: async () => {
      reads++; if (courseError) throw courseError;
      return { course: { id: pageCourseId, title: "Owned paid course", revision: 3, status: "published", accessMode: "paid" } };
    } }) } }),
    mock.module(new URL("../../src/lib/api-integration/rollout-flags.ts", import.meta.url), { namedExports: { isIntegrationFeatureEnabled: () => true } }),
  ];
  let pageCompleted = 0;
  try {
    const { default: page } = await import("../../src/app/admin/(protected)/courses/[courseId]/manual-grants/page");
    const load = () => page({ params: Promise.resolve({ courseId: pageCourseId }) });
    const unavailable = (view: Awaited<ReturnType<typeof load>>) => {
      const html = renderToStaticMarkup(view);
      assert.match(html, /Manual access unavailable/); assert.match(html, /The service is temporarily unavailable\./);
      assert.doesNotMatch(html, /Writer admission|owned internal|secret|password/u);
    };
    unavailable(await load()); assert.equal(authCalls, 0); assert.equal(reads, 0);
    assert.equal((await owner.query("SELECT count(*)::int AS count FROM frontend_admission.operations")).rows[0].count, 0);
    await changeFrontendAdmission(owner, { environment: "staging", targetSha256 }, "1", { newWork: true, recovery: false });
    actor = { ...pageActor, user: { ...pageActor.user, role: "admin" } };
    await assert.rejects(load, (error: unknown) => (error as { digest?: string }).digest === "NEXT_HTTP_ERROR_FALLBACK;404");
    assert.equal(reads, 0);
    actor = pageActor; authError = new AdminAuthError("forbidden");
    await assert.rejects(load, (error: unknown) => (error as { digest?: string }).digest === "NEXT_HTTP_ERROR_FALLBACK;404");
    assert.equal(reads, 0); authError = undefined;
    courseError = new IntegrationServiceError("not_found", 404);
    await assert.rejects(load, (error: unknown) => (error as { digest?: string }).digest === "NEXT_HTTP_ERROR_FALLBACK;404");
    courseError = new IntegrationServiceError("service_unavailable", 503);
    unavailable(await load()); courseError = undefined;
    assert.match(renderToStaticMarkup(await load()), /Manual access: Owned paid course/);
    const pageRows = (await owner.query("SELECT state FROM frontend_admission.operations ORDER BY started_at,id")).rows;
    assert.deepEqual(pageRows.map(row => row.state), Array(5).fill("completed")); pageCompleted = pageRows.length;
    assert.equal((await owner.query("SELECT count(*)::int AS count FROM frontend_admission.operations WHERE state IN ('active','uncertain')")).rows[0].count, 0,
      "nonowner, known auth denial, missing course and known upstream failure settle before safe page control flow");
  } finally { for (const entry of mocks.reverse()) entry.restore(); }
  const { body, fixture } = await import("./manual-grant-fixture");
  // The page above opened admission. The route closed-refusal check must still
  // exercise the actual closed policy rather than relying on prior local state.
  await changeFrontendAdmission(owner, { environment: "staging", targetSha256 }, "2", { newWork: false, recovery: false });
  const closed = fixture(run); assert.equal((await closed.call(body())).status, 503); assert.equal(closed.state.calls, 0);
  await changeFrontendAdmission(owner, { environment: "staging", targetSha256 }, "3", { newWork: true, recovery: false });
  const confirmed = fixture(run); assert.equal((await confirmed.call(body())).status, 200);
  let rows = (await owner.query("SELECT state FROM frontend_admission.operations ORDER BY started_at,id")).rows;
  assert.deepEqual(rows.slice(pageCompleted), [{ state: "completed" }]); assert.equal(confirmed.state.post, 1);
  const unknown = fixture(run), attempt = body(); unknown.state.lostAck = true;
  assert.equal((await unknown.call(attempt)).status, 503);
  rows = (await owner.query("SELECT state FROM frontend_admission.operations ORDER BY started_at,id")).rows;
  assert.deepEqual(rows.slice(pageCompleted).map(row => row.state), ["completed", "uncertain"]);
  unknown.state.lostAck = false; assert.equal((await unknown.call(attempt, "GET")).status, 200); assert.equal(unknown.state.post, 1);
  rows = (await owner.query("SELECT state FROM frontend_admission.operations ORDER BY started_at,id")).rows;
  assert.deepEqual(rows.slice(pageCompleted).map(row => row.state), ["completed", "uncertain", "completed"], "read reconciliation does not clear original uncertainty");
  const untrusted = fixture(run); untrusted.state.postReceiptOverride = { actorUserId: randomUUID() };
  const untrustedResponse = await untrusted.call(body()), untrustedBody = await untrustedResponse.json();
  assert.equal(untrustedResponse.status, 503); assert.equal(untrustedBody.command, undefined); assert.equal(untrusted.state.post, 1);
  assert.equal((await owner.query("SELECT count(*)::int AS count FROM frontend_admission.operations WHERE state='uncertain'")).rows[0].count, 2);
  // Unexpected auth/persistence errors are still uncertain. Settling a known
  // denial must not become a broad catch that can launder failed writes.
  // Reuse the actual page's bound authorizer via the live test closure above;
  // no new module copy or alternate page implementation is used.
  for (const error of [new Error("owned internal write outcome unknown"), new AdminAuthError("forbidden")]) {
    authError = error; uncertainAuth = error instanceof AdminAuthError;
    const { default: page } = await import("../../src/app/admin/(protected)/courses/[courseId]/manual-grants/page");
    const html = renderToStaticMarkup(await page({ params: Promise.resolve({ courseId: pageCourseId }) }));
    assert.match(html, /Manual access unavailable/); assert.doesNotMatch(html, /owned internal|Writer admission/u);
  }
  assert.equal((await owner.query("SELECT count(*)::int AS count FROM frontend_admission.operations WHERE state='uncertain'")).rows[0].count, 4,
    "both uncaught auth errors and a marked uncertain auth write followed by a known denial remain uncertain");
  assert.equal((await owner.query("SELECT bool_and(ssl) AS tls FROM pg_stat_ssl WHERE pid=pg_backend_pid()")).rows[0].tls, true);
  summary = { status: "OWNED_MANUAL_GRANT_ADMISSION_PASS", postgresMajor: major, checks: ["closed-before-auth-or-provider", "whole-operation-single-completed-ledger", "lost-ack-sticky-uncertain", "GET-readback-no-POST-or-counter-clear", "verified-TLS-SCRAM-role",
    "actual-page-nonowner-and-auth-denial-settled-404", "actual-page-missing-course-settled-404", "actual-page-known-upstream-failure-settled-safe-view", "actual-page-closed-admission-safe-view-before-auth", "actual-page-unknown-auth-write-sticky-uncertain", "mismatched-POST-receipt-sticky-uncertain-no-exposure"], providerReplies: "modeled", liveActions: false };
} finally {
  await owner?.end(); await admin?.end();
  if (started) execute(join(bins, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write(JSON.stringify(summary) + "\n");
