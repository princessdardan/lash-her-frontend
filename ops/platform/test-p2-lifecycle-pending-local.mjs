// Explicit owned PostgreSQL 16/18 fixture. No external database or provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { frontendMigrationArtifact } from "./frontend-migration.mjs";
import { captureP2InteractiveEnrollmentBaseline, captureP2InteractiveIdentityBaseline, captureP2InteractiveLifecycleBaseline,
  observeP2InteractiveEnrollmentCase, observeP2InteractiveIdentityCase, observeP2InteractiveLifecycleCase, observeP2SuspensionPending,
  p2SuspensionEvidenceSha256, validateP2InteractiveEnrollmentEmail } from "./p2-lifecycle-pending-probe.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const run = (program, args, options = {}) => execFileSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
let phase = "owned-preflight";
async function main() {
  assert.equal(process.env.P2_LIFECYCLE_PENDING_OWNED_TEST, "true"); assert.equal(process.versions.node.split(".")[0], "24");
  const pgBin = process.env.PG_BIN, major = Number(process.env.OWNED_POSTGRES_MAJOR ?? "16");
  assert.ok(pgBin?.startsWith("/") && [16, 18].includes(major)); assert.match(run(join(pgBin, "postgres"), ["--version"]), new RegExp(`PostgreSQL\\) ${major}\\.`, "u"));
  const directory = mkdtempSync(join(tmpdir(), "p2-pending-owned-")); chmodSync(directory, 0o700);
  const data = join(directory, "data"), cert = join(directory, "server.crt"), key = join(directory, "server.key"), checks = [], clients = [];
  let started = false;
  try {
    const socket = createServer(); await new Promise((done, fail) => { socket.once("error", fail); socket.listen(0, "127.0.0.1", done); });
    const port = socket.address().port; await new Promise(done => socket.close(done));
    const env = { PATH: process.env.PATH, LC_ALL: "C", LANG: "C" };
    run(join(pgBin, "initdb"), ["-D", data, "-A", "trust", "-U", "owned_pending_admin", "-E", "UTF8", "--locale=C"], { env });
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert], { env }); chmodSync(key, 0o600);
    writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${cert}'\nssl_key_file='${key}'\n`);
    writeFileSync(join(data, "pg_hba.conf"), "hostssl all owned_pending_admin 127.0.0.1/32 trust\n");
    run(join(pgBin, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"], { env }); started = true;
    const target = { host: "localhost", port, user: "owned_pending_admin", database: "owned_suspension_pending", serverMajor: major };
    const connect = async database => {
      const client = new Client({ ...target, database, ssl: { rejectUnauthorized: true, ca: readFileSync(cert, "utf8"), servername: "localhost" }, options: "-c search_path=public" });
      clients.push(client); await client.connect(); assert.equal(client.connection.stream.encrypted, true); assert.equal(client.connection.stream.authorized, true); return client;
    };
    const control = await connect("postgres"); await control.query(`CREATE DATABASE ${target.database}`);
    const client = await connect(target.database), artifact = frontendMigrationArtifact(root);
    phase = "actual-source-migrations";
    assert.equal(artifact.migrations.length, 83);
    for (const migration of artifact.migrations) { await client.query("BEGIN"); try { for (const sql of migration.sql) await client.query(sql); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; } }
    const userId = randomUUID(), adminId = randomUUID(), commandId = randomUUID(), at = new Date(Date.now() - 1000).toISOString();
    await client.query("INSERT INTO public.admin_users(id,provider_user_id,email,email_normalized,role,status) VALUES($1,$2,'owned-owner@example.invalid','owned-owner@example.invalid','owner','active')", [adminId, randomUUID()]);
    await client.query("INSERT INTO public.customer_users(id,email,status,account_version) VALUES($1,'owned-pending@example.invalid','suspended',1)", [userId]);
    const command = { version: 1, commandId, userId, accountVersion: 1, action: "suspend", issuedAt: at };
    await client.query("INSERT INTO public.customer_account_commands(command_id,user_id,account_version,idempotency_key,action,issued_at,command,requested_by_admin_id) VALUES($1,$2,1,$3,'suspend',$4,$5,$6)", [commandId, userId, randomUUID(), at, command, adminId]);
    for (const receiver of ["course", "community"]) await client.query("INSERT INTO public.customer_account_deliveries(command_id,receiver) VALUES($1,$2)", [commandId, receiver]);
    const selection = { userId, commandId, accountVersion: 1, requestId: randomUUID(), responseObservedAt: at, controlledDenialObservedAt: at };
    const backend = (await client.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid;
    const dependencies = { verifyEnvironment: async () => {}, verifySession: async () => assert.equal((await client.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid, backend) };
    await client.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))", ["lash-her:private-db:migrations"]);
    const contender = await connect(target.database);
    assert.equal((await contender.query("SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS held", ["lash-her:private-db:migrations"])).rows[0].held, false);
    checks.push("actual-tls-physical-backend-and-exclusive-lock-contention");
    phase = "fixed-pending-observer";
    const positive = await observeP2SuspensionPending(client, target, selection, dependencies);
    assert.equal(positive.command.commandId, commandId); assert.equal(positive.requestedByAdminId, adminId);
    assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "off");
    checks.push("actual83-migrations-canonical-command-owner-attribution-and-two-pending-zero-attempts");
    const fault = async (sql, args, repair) => {
      await client.query(sql, args); await assert.rejects(observeP2SuspensionPending(client, target, selection, dependencies)); await repair();
      assert.equal((await observeP2SuspensionPending(client, target, selection, dependencies)).status, positive.status);
    };
    await fault("UPDATE public.customer_account_deliveries SET attempts=1 WHERE command_id=$1 AND receiver='course'", [commandId], () => client.query("UPDATE public.customer_account_deliveries SET attempts=0 WHERE command_id=$1", [commandId]));
    checks.push("actual-worker-attempt-before-recorder-refused-and-repair-positive");
    await fault("UPDATE public.customer_account_deliveries SET lease_id=$2,lease_until=pg_catalog.clock_timestamp()+interval '90 seconds' WHERE command_id=$1 AND receiver='community'", [commandId, randomUUID()],
      () => client.query("UPDATE public.customer_account_deliveries SET lease_id=NULL,lease_until=NULL WHERE command_id=$1", [commandId]));
    checks.push("actual-inflight-delivery-refused-and-repair-positive");
    await fault("UPDATE public.customer_account_deliveries SET status='acknowledged',attempts=1,acknowledged_at=pg_catalog.clock_timestamp() WHERE command_id=$1 AND receiver='course'", [commandId],
      () => client.query("UPDATE public.customer_account_deliveries SET status='pending',attempts=0,acknowledged_at=NULL WHERE command_id=$1", [commandId]));
    checks.push("actual-already-acknowledged-delivery-refused-and-repair-positive");
    await fault("UPDATE public.admin_users SET role='admin' WHERE id=$1", [adminId], () => client.query("UPDATE public.admin_users SET role='owner' WHERE id=$1", [adminId]));
    checks.push("actual-nonowner-attribution-refused-and-repair-positive");
    await assert.rejects(observeP2SuspensionPending(client, { ...target, user: "foreign_operator" }, selection, dependencies));
    checks.push("actual-wrong-session-identity-refused");
    phase = "actual-interactive-lifecycle-before-after";
    checks.push(...await checkInteractiveLifecycle(client, contender, target, dependencies, adminId));
    phase = "actual-interactive-identity-before-after";
    checks.push(...await checkInteractiveIdentity(client, contender, target, dependencies));
    phase = "actual-interactive-enrollment-before-after";
    checks.push(...await checkInteractiveEnrollment(client, contender, target, dependencies));
    await client.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1))", ["lash-her:private-db:migrations"]);
    await assert.rejects(observeP2SuspensionPending(client, target, selection, dependencies));
    await assert.rejects(captureP2InteractiveLifecycleBaseline(client, target, {
      actorKind: "admin", actorId: adminId, userId, operation: "restore",
    }, dependencies));
    const missingLockEmail = "owned-enrollment-no-lock@example.invalid", nonce = "b".repeat(32);
    const emailSha256 = p2SuspensionEvidenceSha256(JSON.stringify(["p2q-customer-enrollment-v1", "resend", nonce, missingLockEmail]));
    await assert.rejects(captureP2InteractiveEnrollmentBaseline(client, target,
      { provider: "resend", nonce, emailSha256 }, missingLockEmail, dependencies));
    checks.push("actual-missing-physical-lock-refused");
    return { version: 1, status: "P2_LIFECYCLE_PENDING_OWNED_PASS", postgresMajor: major, frontendMigrations: 83, checks, skipped: 0,
      actualTlsPostgres: true, actualPendingSelect: true, controlledTokenExpiryQualified: false, browserQualified: false,
      hostDockerPathQualified: false, fixtureOnly: true, providerTouched: false, releaseAccepted: false,
      sourceSha256: p2SuspensionEvidenceSha256(readFileSync(new URL("./p2-lifecycle-pending-probe.mjs", import.meta.url))) };
  } finally {
    for (const client of clients.reverse()) try { await client.end(); } catch {}
    if (started) try { run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
}

async function checkInteractiveEnrollment(client, runtime, target, dependencies) {
  const refused = /P2_LIFECYCLE_PENDING_REFUSED/u;
  const binding = (provider = "google") => {
    const email = `${randomUUID()}@example.invalid`, nonce = randomUUID().replaceAll("-", "");
    const emailSha256 = createHash("sha256").update(JSON.stringify(["p2q-customer-enrollment-v1", provider, nonce, email])).digest("hex");
    return { email, selection: { provider, emailSha256, nonce }, actorId: randomUUID() };
  };
  const capture = ({ selection, email }) => captureP2InteractiveEnrollmentBaseline(client, target, selection, email, dependencies);
  const browser = ({ actorId }) => ({ actorKind: "customer", actorId, sessionVerified: true });
  const observe = (test, baseline, identity = browser(test)) =>
    observeP2InteractiveEnrollmentCase(client, target, test.selection, baseline, identity, dependencies);
  const addUser = ({ actorId, email }, { createdAgo = "0 seconds", verified = true, status = "active", accountVersion = 0 } = {}) =>
    runtime.query(`INSERT INTO public.customer_users(id,email,created_at,email_verified,status,account_version)
      VALUES($1,$2,pg_catalog.clock_timestamp()-$3::interval,CASE WHEN $4 THEN pg_catalog.clock_timestamp() END,$5,$6)`,
    [actorId, email, createdAgo, verified, status, accountVersion]);
  const addSession = ({ actorId }, { createdAgo = "0 seconds", expiresIn = "1 hour" } = {}) =>
    runtime.query(`INSERT INTO public.customer_sessions(token_hash,user_id,created_at,expires)
      VALUES($1,$2,pg_catalog.clock_timestamp()-$3::interval,pg_catalog.clock_timestamp()+$4::interval)`,
    [randomUUID(), actorId, createdAgo, expiresIn]);
  const addGoogle = ({ actorId }, providerSubject = randomUUID()) =>
    runtime.query("INSERT INTO public.customer_provider_links(user_id,provider,provider_account_id,type) VALUES($1,'google',$2,'oidc')",
      [actorId, providerSubject]);
  const addMarketing = ({ email }) => runtime.query(`INSERT INTO public.marketing_contacts(email,email_normalized,source,first_consented_at,last_consented_at)
    VALUES($1,$1,'owned-enrollment-test',pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp())`, [email]);
  const addConsent = ({ email }) => runtime.query(`INSERT INTO public.marketing_consent_events(event_type,email,email_normalized,source,occurred_at)
    VALUES('opt_in',$1,$1,'owned-enrollment-test',pg_catalog.clock_timestamp())`, [email]);

  const google = binding(), resend = binding("resend");
  assert.equal(validateP2InteractiveEnrollmentEmail(google.selection, google.email), google.email);
  assert.throws(() => validateP2InteractiveEnrollmentEmail(google.selection, google.email.toUpperCase()), refused);
  assert.throws(() => validateP2InteractiveEnrollmentEmail(google.selection, ` ${google.email}`), refused);
  assert.throws(() => validateP2InteractiveEnrollmentEmail(google.selection, resend.email), refused);
  assert.throws(() => validateP2InteractiveEnrollmentEmail({ ...google.selection, provider: "resend" }, google.email), refused);
  assert.throws(() => validateP2InteractiveEnrollmentEmail({ ...google.selection, nonce: "0".repeat(32) }, google.email), refused);
  await assert.rejects(captureP2InteractiveEnrollmentBaseline(runtime, target, google.selection, google.email,
    { ...dependencies, verifySession: async () => {} }), refused);
  for (const selected of [google, resend]) {
    const before = await capture(selected);
    assert.deepEqual(Object.keys(before), []);
    assert.equal(JSON.stringify(before), "{}");
    await addUser(selected);
    await addSession(selected);
    const providerLinkCount = selected.selection.provider === "google" ? 1 : 0;
    if (providerLinkCount) await addGoogle(selected);
    await assert.rejects(observe(selected, {}), refused);
    await assert.rejects(observe(selected, before, { ...browser(selected), sessionVerified: false }), refused);
    await assert.rejects(observe(selected, before, { ...browser(selected), email: selected.email }), refused);
    await assert.rejects(observeP2InteractiveEnrollmentCase(runtime, target, selected.selection, before,
      browser(selected), dependencies), refused);
    const positive = await observe(selected, before);
    assert.deepEqual(positive, { actorKind: "customer", actorId: selected.actorId, actorActive: true, liveSessionCount: 1,
      provider: selected.selection.provider, providerLinkCount });
    assert.equal(JSON.stringify(positive).includes(selected.email), false);
    await assert.rejects(observe(selected, before), refused);
    await assert.rejects(capture(selected), refused);
  }

  for (const { user, session, extra, provider = "resend", mismatchedActor } of [
    { user: { createdAgo: "1 day" } },
    { user: { verified: false } },
    { user: { status: "suspended" } },
    { user: { accountVersion: 1 } },
    { session: { createdAgo: "1 day" } },
    { session: { expiresIn: "-1 hour" } },
    { extra: addSession },
    { extra: test => addGoogle(test, " "), provider: "google" },
    { provider: "google" },
    { extra: addGoogle },
    { extra: addMarketing },
    { extra: addConsent },
    { mismatchedActor: true },
  ]) {
    const selected = binding(provider), before = await capture(selected);
    await addUser(selected, user);
    await addSession(selected, session);
    if (extra) await extra(selected);
    await assert.rejects(observe(selected, before, mismatchedActor ? browser({ actorId: randomUUID() }) : undefined), refused);
    await assert.rejects(observe(selected, before), refused);
  }
  const absentAfter = binding("resend");
  await assert.rejects(observe(absentAfter, await capture(absentAfter)), refused);
  const priorContact = binding("resend"), priorConsent = binding("resend");
  await addMarketing(priorContact); await addConsent(priorConsent);
  await assert.rejects(capture(priorContact), refused);
  await assert.rejects(capture(priorConsent), refused);
  assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "off");
  return ["interactive-enrollment-google-and-resend-exact-first-verified-account-fresh-session-and-provider-links",
    "interactive-enrollment-rejects-stale-or-foreign-identity-session-and-retains-no-private-lookup",
    "interactive-enrollment-excludes-address-with-subscription-or-consent-before-or-after"];
}

async function checkInteractiveIdentity(client, runtime, target, dependencies) {
  const admin = { actorKind: "admin", actorId: randomUUID() }, customer = { actorKind: "customer", actorId: randomUUID() };
  const otherCustomer = { actorKind: "customer", actorId: randomUUID() };
  const challenge = createHash("sha256").update(randomUUID()).digest("hex");
  const provider = 'owned-actor-"\\é';
  const baseline = selection => captureP2InteractiveIdentityBaseline(client, target, selection, challenge, dependencies);
  const browser = selection => ({ ...selection, sessionVerified: true });
  const observe = (selection, before, receipt = browser(selection)) =>
    observeP2InteractiveIdentityCase(client, target, selection, before, receipt, dependencies);
  const refused = /P2_LIFECYCLE_PENDING_REFUSED/u;
  await runtime.query("INSERT INTO public.admin_users(id,provider_user_id,email,email_normalized,role,status) VALUES($1,$2,'owned-identity@example.invalid','owned-identity@example.invalid','owner','active')",
    [admin.actorId, provider]);
  for (const { actorId } of [customer, otherCustomer]) {
    await runtime.query("INSERT INTO public.customer_users(id,email) VALUES($1,$2)", [actorId, `${actorId}@example.invalid`]);
  }
  const addSession = (actorId, expiresIn) => runtime.query(`INSERT INTO public.customer_sessions(token_hash,user_id,expires)
    VALUES($1,$2,pg_catalog.clock_timestamp()+$3::interval)`, [randomUUID(), actorId, expiresIn]);
  await addSession(customer.actorId, "1 hour");

  await assert.rejects(captureP2InteractiveIdentityBaseline(client, target, admin, "foreign-challenge", dependencies), refused);
  await assert.rejects(captureP2InteractiveIdentityBaseline(runtime, target, admin, challenge, { ...dependencies, verifySession: async () => {} }), refused);
  const beforeOwner = await baseline(admin);
  const digest = createHash("sha256").update(JSON.stringify(["p2q-interactive-owner-v1", challenge, admin.actorId, provider])).digest("hex");
  assert.equal(beforeOwner.ownerSubjectSha256, digest);
  assert.deepEqual(Object.keys(beforeOwner), []);
  assert.equal(JSON.stringify(beforeOwner), "{}");
  await assert.rejects(observe(admin, {}, browser(admin)), refused);
  await assert.rejects(observe(admin, beforeOwner, { ...browser(admin), actorId: randomUUID() }), refused);
  await assert.rejects(observe(admin, beforeOwner, { ...browser(admin), providerUserId: provider }), refused);
  await assert.rejects(observeP2InteractiveIdentityCase(runtime, target, admin, beforeOwner, browser(admin), dependencies), refused);
  assert.deepEqual(await observe(admin, beforeOwner), { ...admin, actorActive: true, ownerMappingVerified: true });
  await assert.rejects(observe(admin, beforeOwner), refused);
  const oldBinding = await baseline(admin);
  await runtime.query("UPDATE public.admin_users SET provider_user_id=$2 WHERE id=$1", [admin.actorId, "different-provider"]);
  await assert.rejects(observe(admin, oldBinding), refused);
  await runtime.query("UPDATE public.admin_users SET provider_user_id=$2 WHERE id=$1", [admin.actorId, "pending:owned"]);
  await assert.rejects(baseline(admin), refused);
  await runtime.query("UPDATE public.admin_users SET provider_user_id=$2,role='admin' WHERE id=$1", [admin.actorId, provider]);
  await assert.rejects(baseline(admin), refused);
  await runtime.query("UPDATE public.admin_users SET role='owner',status='disabled' WHERE id=$1", [admin.actorId]);
  await assert.rejects(baseline(admin), refused);

  const oldCustomer = await baseline(customer);
  assert.equal(Object.hasOwn(oldCustomer, "ownerSubjectSha256"), false);
  assert.equal(JSON.stringify(oldCustomer), "{}");
  await addSession(otherCustomer.actorId, "1 hour");
  await addSession(customer.actorId, "-1 hour");
  await assert.rejects(observe(customer, oldCustomer), refused);
  const beforeCustomer = await baseline(customer);
  await addSession(customer.actorId, "1 hour");
  await assert.rejects(observe(customer, beforeCustomer, { ...browser(customer), sessionVerified: false }), refused);
  await assert.rejects(observe(customer, beforeCustomer, browser(otherCustomer)), refused);
  assert.deepEqual(await observe(customer, beforeCustomer), { ...customer, actorActive: true, liveSessionCount: 2 });
  const beforeSuspension = await baseline(customer);
  await addSession(customer.actorId, "1 hour");
  await runtime.query("UPDATE public.customer_users SET status='suspended' WHERE id=$1", [customer.actorId]);
  await assert.rejects(observe(customer, beforeSuspension), refused);
  assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "off");
  return ["interactive-identity-owner-private-challenge-binding-role-and-drift", "interactive-identity-customer-fresh-live-session-selected-uuid"];
}

async function checkInteractiveLifecycle(client, runtime, target, dependencies, adminId) {
  const otherAdmin = randomUUID(), subject = randomUUID(), otherSubject = randomUUID();
  const admin = (operation, userId = subject, actorId = adminId) => ({ actorKind: "admin", actorId, userId, operation });
  const customer = (operation, userId = otherSubject) => ({ actorKind: "customer", actorId: userId, userId, operation });
  const adminPath = userId => `/api/admin/customer-accounts/${userId}/commands`;
  const baseline = selection => captureP2InteractiveLifecycleBaseline(client, target, selection, dependencies);
  const observe = (selection, before, response) => observeP2InteractiveLifecycleCase(client, target, selection, before, response, dependencies);
  await runtime.query("INSERT INTO public.admin_users(id,provider_user_id,email,email_normalized,role,status) VALUES($1,$2,'other-owner@example.invalid','other-owner@example.invalid','owner','active')", [otherAdmin, randomUUID()]);
  for (const id of [subject, otherSubject]) {
    await runtime.query("INSERT INTO public.customer_users(id,email) VALUES($1,$2)", [id, `${id}@example.invalid`]);
    await runtime.query("INSERT INTO public.customer_sessions(token_hash,user_id,expires) VALUES($1,$2,pg_catalog.clock_timestamp()+interval '1 hour')", [randomUUID(), id]);
  }

  async function issue(selection, accountVersion) {
    const { actorKind, actorId, userId, operation } = selection;
    const commandId = randomUUID(), issuedAt = new Date().toISOString();
    const command = { version: 1, commandId, userId, accountVersion, action: operation, issuedAt };
    await runtime.query("BEGIN");
    try {
      await runtime.query(`INSERT INTO public.customer_account_commands(command_id,user_id,account_version,idempotency_key,action,issued_at,command,requested_by_admin_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [commandId, userId, accountVersion, randomUUID(), operation, issuedAt, command,
        actorKind === "admin" ? actorId : null]);
      await runtime.query("INSERT INTO public.customer_account_deliveries(command_id,receiver,next_run_at) VALUES($1,'course',$2),($1,'community',$2)", [commandId, issuedAt]);
      await runtime.query("UPDATE public.customer_users SET account_version=$2 WHERE id=$1", [userId, accountVersion]);
      if (operation === "export") {
        await runtime.query("INSERT INTO public.customer_account_exports(command_id,user_id,frontend_data) VALUES($1,$2,$3)", [commandId, userId, { synthetic: "private-export-marker" }]);
      } else {
        await runtime.query("DELETE FROM public.customer_sessions WHERE user_id=$1", [userId]);
        if (operation === "delete") {
          await runtime.query("UPDATE public.customer_users SET status='deleted',email='deleted+'||id::text||'@account.invalid' WHERE id=$1", [userId]);
          await runtime.query("DELETE FROM public.customer_provider_links WHERE user_id=$1", [userId]);
          await runtime.query("DELETE FROM public.customer_account_preferences WHERE user_id=$1", [userId]);
          await runtime.query("UPDATE public.customer_account_exports SET status='expired',data=NULL,frontend_data=NULL WHERE user_id=$1", [userId]);
        } else {
          await runtime.query("UPDATE public.customer_users SET status='suspended' WHERE id=$1", [userId]);
        }
      }
      await runtime.query("COMMIT");
    } catch (error) { await runtime.query("ROLLBACK"); throw error; }
    return { method: "POST", pathname: actorKind === "admin" ? adminPath(userId) : "/api/account/commands",
      status: 202, requestId: randomUUID(), body: { commandId, action: operation, accountVersion, status: "pending" } };
  }

  const suspend = admin("suspend"), wrongOwner = admin("suspend", subject, otherAdmin), wrongResource = admin("suspend", otherSubject);
  const beforeSuspend = await baseline(suspend), beforeWrongOwner = await baseline(wrongOwner), beforeWrongResource = await baseline(wrongResource);
  const suspendReceipt = await issue(suspend, 1);
  await assert.rejects(observe(suspend, { ...beforeSuspend }, suspendReceipt), /P2_LIFECYCLE_PENDING_REFUSED/u);
  await assert.rejects(observe(suspend, beforeSuspend, { ...suspendReceipt, pathname: adminPath(otherSubject) }), /P2_LIFECYCLE_PENDING_REFUSED/u);
  await assert.rejects(observe(wrongOwner, beforeWrongOwner, suspendReceipt), /P2_LIFECYCLE_PENDING_REFUSED/u);
  await assert.rejects(observe(wrongResource, beforeWrongResource, { ...suspendReceipt, pathname: adminPath(otherSubject) }), /P2_LIFECYCLE_PENDING_REFUSED/u);
  const suspended = await observe(suspend, beforeSuspend, suspendReceipt);
  assert.equal(suspended.frontendStatus, "suspended");
  assert.equal(suspended.sessionsBefore, 1);
  assert.equal(suspended.sessionsAfter, 0);
  assert.deepEqual(suspended.deliveries, ["course", "community"].map(receiver => ({ receiver, status: "pending", attempts: 0 })));
  await assert.rejects(observe(suspend, beforeSuspend, suspendReceipt), /P2_LIFECYCLE_PENDING_REFUSED/u);

  const restore = admin("restore"), beforeRestore = await baseline(restore);
  const restored = await observe(restore, beforeRestore, await issue(restore, 2));
  assert.equal(restored.frontendStatus, "suspended");
  assert.equal(restored.sessionsAfter, 0);
  assert.equal(restored.accountVersion, 2);

  const preferencesReceipt = { method: "POST", pathname: "/api/account/preferences", status: 200, requestId: randomUUID(), body: { saved: true } };
  const optIn = customer("preferences-on"), wrongCustomer = { ...optIn, actorId: subject };
  await assert.rejects(baseline(wrongCustomer), /P2_LIFECYCLE_PENDING_REFUSED/u);
  const wrongPreference = await baseline(optIn), beforeOptIn = await baseline(optIn);
  await runtime.query("INSERT INTO public.customer_account_preferences(user_id,learning_updates) VALUES($1,false)", [otherSubject]);
  await assert.rejects(observe(optIn, wrongPreference, preferencesReceipt), /P2_LIFECYCLE_PENDING_REFUSED/u);
  await runtime.query("UPDATE public.customer_account_preferences SET learning_updates=true WHERE user_id=$1", [otherSubject]);
  const optedIn = await observe(optIn, beforeOptIn, preferencesReceipt);
  assert.equal(optedIn.learningUpdates, true);
  assert.equal(optedIn.accountVersion, 0);
  assert.equal(optedIn.commandId, null);
  const optOut = customer("preferences-off"), beforeOptOut = await baseline(optOut);
  await runtime.query("UPDATE public.customer_account_preferences SET learning_updates=false WHERE user_id=$1", [otherSubject]);
  assert.equal((await observe(optOut, beforeOptOut, { ...preferencesReceipt, requestId: randomUUID() })).learningUpdates, false);
  await assert.rejects(baseline(optOut), /P2_LIFECYCLE_PENDING_REFUSED/u);

  const exportAction = customer("export"), beforeExport = await baseline(exportAction);
  const exportReceipt = await issue(exportAction, 1);
  const exported = await observe(exportAction, beforeExport, exportReceipt);
  assert.equal(exported.frontendStatus, "active");
  assert.equal(exported.sessionsAfter, 1);
  assert.equal(JSON.stringify(exported).includes("private-export-marker"), false);
  const beforeReplay = await baseline(exportAction);
  await assert.rejects(observe(exportAction, beforeReplay, { ...exportReceipt, requestId: randomUUID() }), /P2_LIFECYCLE_PENDING_REFUSED/u);
  await assert.rejects(observe(exportAction, beforeReplay, { ...exportReceipt, requestId: randomUUID(),
    body: { ...exportReceipt.body, accountVersion: 2 } }), /P2_LIFECYCLE_PENDING_REFUSED/u);

  await runtime.query("INSERT INTO public.customer_provider_links(user_id,provider,provider_account_id,type) VALUES($1,'google',$2,'oidc')", [otherSubject, randomUUID()]);
  const deleteAction = customer("delete"), beforeDelete = await baseline(deleteAction);
  const deleted = await observe(deleteAction, beforeDelete, await issue(deleteAction, 2));
  assert.equal(deleted.frontendStatus, "deleted");
  assert.equal(deleted.sessionsAfter, 0);
  assert.equal(deleted.learningUpdates, false);
  assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "off");
  return ["interactive-admin-attribution-resource-session-revocation-and-restore-ordering",
    "interactive-preference-changes-and-account-binding", "interactive-export-metadata-only-old-replay-refusal-and-deletion"];
}

main().then(value => console.log(JSON.stringify(value))).catch(error => { console.error(JSON.stringify({ status: "P2_LIFECYCLE_PENDING_OWNED_FAILED", phase,
  code: error?.code ?? error?.name ?? "Error", providerTouched: false })); process.exitCode = 1; });
