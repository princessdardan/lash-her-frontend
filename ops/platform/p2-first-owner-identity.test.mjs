import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import test from "node:test";
import { frontendMigrationArtifact, FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";
import { openOwnedFrontendReplacementCluster } from "./harness/owned-frontend-replacement-cluster.mjs";
import { p2FirstOwnerDiscoveryEmailSha256, p2FirstOwnerIdentitySha256, readP2FirstOwnerSelectionHandoff,
  validP2FirstOwnerDiscoverySelection, validP2FirstOwnerSelection } from "./p2-first-owner-identity.mjs";
import { captureP2InteractiveFirstOwnerBaseline, captureP2InteractiveFirstOwnerDiscoveryBaseline,
  observeP2InteractiveFirstOwnerCase, observeP2InteractiveFirstOwnerDiscoveryCase } from "./p2-lifecycle-pending-probe.mjs";

const nonce = "9".repeat(32);
const email = "owned-owner@example.invalid", subject = "owned-google-subject";
const firstOwner = { nonce, identitySha256: p2FirstOwnerIdentitySha256(nonce, email, subject) };

test("first-owner review binds normalized email, Google subject and a nonzero nonce", () => {
  assert.ok(validP2FirstOwnerSelection(firstOwner));
  assert.equal(validP2FirstOwnerSelection({ ...firstOwner, identitySha256: "0".repeat(64) }), false);
  assert.equal(validP2FirstOwnerSelection({ ...firstOwner, email }), false);
  assert.equal(p2FirstOwnerIdentitySha256(nonce, email.toUpperCase(), subject), null);
  assert.equal(p2FirstOwnerIdentitySha256(nonce, email, subject + "\n"), null);
  assert.notEqual(p2FirstOwnerIdentitySha256(nonce, email, "other-google-subject"), firstOwner.identitySha256);
  assert.notEqual(p2FirstOwnerIdentitySha256("8".repeat(32), email, subject), firstOwner.identitySha256);
});

test("first-owner discovery binds only a normalized allowlisted email until Google supplies the subject", () => {
  const discovery = { nonce, emailSha256: p2FirstOwnerDiscoveryEmailSha256(nonce, email) };
  assert.ok(validP2FirstOwnerDiscoverySelection(discovery));
  assert.equal(validP2FirstOwnerDiscoverySelection({ ...discovery, identitySha256: firstOwner.identitySha256 }), false);
  assert.equal(p2FirstOwnerDiscoveryEmailSha256(nonce, email.toUpperCase()), null);
  assert.notEqual(p2FirstOwnerDiscoveryEmailSha256("8".repeat(32), email), discovery.emailSha256);
});

test("private first-owner selection handoff requires an owned mode-0600 regular file", () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "p2-first-owner-handoff-"));
  try {
    chmodSync(directory, 0o700);
    const path = join(directory, "selection.json");
    writeFileSync(path, JSON.stringify({ version: 1, firstOwner }) + "\n", { mode: 0o600 });
    assert.deepEqual(readP2FirstOwnerSelectionHandoff(path), firstOwner);
    const hardlink = join(directory, "hardlink.json");
    linkSync(path, hardlink);
    assert.equal(readP2FirstOwnerSelectionHandoff(path), null);
    unlinkSync(hardlink);
    const symlink = join(directory, "symlink.json");
    symlinkSync(path, symlink);
    assert.equal(readP2FirstOwnerSelectionHandoff(symlink), null);
    chmodSync(path, 0o644);
    assert.equal(readP2FirstOwnerSelectionHandoff(path), null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("owned TLS runtime DML role can lock and create exactly the first owner through the app store", {
  skip: process.env.P2_FIRST_OWNER_OWNED_TEST !== "true", timeout: 120_000,
}, async () => {
  const pgBin = process.env.PG_BIN;
  assert.ok(pgBin?.startsWith("/"));
  const postgres = execFileSync(join(pgBin, "postgres"), ["--version"], { encoding: "utf8" });
  const serverMajor = Number(postgres.match(/PostgreSQL\) (16|18)\./u)?.[1]);
  assert.ok([16, 18].includes(serverMajor));
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), "p2-first-owner-"));
  chmodSync(workspace, 0o700);
  const clusterDirectory = join(workspace, "cluster"), key = join(workspace, "server.key"), cert = join(workspace, "server.crt");
  mkdirSync(clusterDirectory, { mode: 0o700 });
  const originalCa = getCACertificates("default"), originalUrl = process.env.DATABASE_URL;
  const originalAdmission = process.env.FRONTEND_WRITER_ADMISSION_MODE;
  let cluster, admin, closePrivateDbPool;
  try {
    execFileSync("openssl", ["req", "-new", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1", "-keyout", key, "-out", cert,
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
    chmodSync(key, 0o600);
    const user = "owned_frontend_migration", runtime = "owned_frontend_runtime", database = "owned_first_owner";
    const password = randomBytes(32).toString("hex");
    cluster = await openOwnedFrontendReplacementCluster(clusterDirectory, pgBin, user, key, cert);
    const control = await cluster.connect("postgres");
    try {
      await control.query(`CREATE ROLE ${runtime} LOGIN NOINHERIT PASSWORD '${password}'`);
      await control.query(`CREATE DATABASE ${database}`);
      await control.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${runtime}`);
    } finally { await control.end(); }
    admin = await cluster.connect(database);
    for (const migration of frontendMigrationArtifact().migrations) {
      await admin.query("BEGIN");
      try {
        for (const statement of migration.sql) await admin.query(statement);
        await admin.query("COMMIT");
      } catch (error) { await admin.query("ROLLBACK"); throw error; }
    }
    await admin.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${runtime};
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${runtime};
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtime}`);
    await admin.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))", [FRONTEND_MIGRATION_LOCK]);
    const target = { host: "127.0.0.1", port: cluster.port, user, database, serverMajor };
    const verify = async () => {};
    const dependencies = { verifyEnvironment: verify, verifySession: verify };
    const discovery = { nonce, emailSha256: p2FirstOwnerDiscoveryEmailSha256(nonce, email) };
    const discoveryBaseline = await captureP2InteractiveFirstOwnerDiscoveryBaseline(admin, target, discovery, dependencies);
    const discoveryReceipt = { firstOwner, sessionVerified: true };
    assert.deepEqual(await observeP2InteractiveFirstOwnerDiscoveryCase(admin, target, discovery, discoveryBaseline,
      discoveryReceipt, dependencies), { adminUserCount: 0, firstOwnerDiscoveryVerified: true,
      firstOwnerIdentitySha256: firstOwner.identitySha256 });
    const forgedBaseline = await captureP2InteractiveFirstOwnerDiscoveryBaseline(admin, target, discovery, dependencies);
    await assert.rejects(observeP2InteractiveFirstOwnerDiscoveryCase(admin, target, discovery, forgedBaseline,
      { ...discoveryReceipt, firstOwner: { ...firstOwner, nonce: "8".repeat(32) } }, dependencies), /P2_LIFECYCLE_PENDING_REFUSED/u);
    const confusedBaseline = await captureP2InteractiveFirstOwnerDiscoveryBaseline(admin, target, discovery, dependencies);
    await assert.rejects(observeP2InteractiveFirstOwnerDiscoveryCase(admin, target, discovery, confusedBaseline,
      { ...discoveryReceipt, firstOwner: { nonce, identitySha256: discovery.emailSha256 } }, dependencies), /P2_LIFECYCLE_PENDING_REFUSED/u);
    const alternate = { ...firstOwner, identitySha256: p2FirstOwnerIdentitySha256(nonce, email, "different-subject") };
    const baseline = await captureP2InteractiveFirstOwnerBaseline(admin, target, firstOwner, dependencies);
    const wrongSubjectBaseline = await captureP2InteractiveFirstOwnerBaseline(admin, target, alternate, dependencies);
    const wrongActorBaseline = await captureP2InteractiveFirstOwnerBaseline(admin, target, firstOwner, dependencies);
    setDefaultCACertificates([...originalCa, readFileSync(cert, "utf8")]);
    process.env.DATABASE_URL = `postgresql://${runtime}:${password}@127.0.0.1:${cluster.port}/${database}?sslmode=verify-full`;
    process.env.FRONTEND_WRITER_ADMISSION_MODE = "off";
    const { createDrizzleAdminUserRepository } = await import("../../src/lib/admin/admin-user-store.ts");
    ({ closePrivateDbPool } = await import("../../src/lib/private-db/client.ts"));
    const repository = createDrizzleAdminUserRepository();
    const identity = { email, emailVerified: true, providerUserId: subject, displayName: "Owned owner" };
    const [owner, concurrent] = await Promise.all([
      repository.createBootstrapOwner(identity, { requireEmpty: true }),
      repository.createBootstrapOwner(identity, { requireEmpty: true }),
    ]);
    assert.deepEqual(concurrent, owner);
    const receipt = { actorKind: "admin", actorId: owner.id, sessionVerified: true };
    await assert.rejects(observeP2InteractiveFirstOwnerCase(admin, target, alternate, wrongSubjectBaseline, receipt, dependencies), /P2_LIFECYCLE_PENDING_REFUSED/u);
    await assert.rejects(observeP2InteractiveFirstOwnerCase(admin, target, firstOwner, wrongActorBaseline, { ...receipt, actorId: randomUUID() }, dependencies),
      /P2_LIFECYCLE_PENDING_REFUSED/u);
    const verified = await observeP2InteractiveFirstOwnerCase(admin, target, firstOwner, baseline, receipt, dependencies);
    assert.deepEqual(verified, { actorKind: "admin", actorId: owner.id, actorActive: true, ownerMappingVerified: true, firstOwnerVerified: true });
    await assert.rejects(captureP2InteractiveFirstOwnerBaseline(admin, target, firstOwner, dependencies), /P2_LIFECYCLE_PENDING_REFUSED/u);
    await assert.rejects(captureP2InteractiveFirstOwnerDiscoveryBaseline(admin, target, discovery, dependencies), /P2_LIFECYCLE_PENDING_REFUSED/u);
    await assert.rejects(repository.createBootstrapOwner({ email: "other@example.invalid", emailVerified: true, providerUserId: "other-subject",
      displayName: null }, { requireEmpty: true }), /First-owner bootstrap requires an empty admin store/u);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM public.admin_users")).rows[0].count, 1);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM public.admin_user_resources WHERE admin_user_id=$1", [owner.id])).rows[0].count, 1);
  } finally {
    try {
      await closePrivateDbPool?.();
      await admin?.end();
      await cluster?.stop();
    } finally {
      if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl;
      if (originalAdmission === undefined) delete process.env.FRONTEND_WRITER_ADMISSION_MODE; else process.env.FRONTEND_WRITER_ADMISSION_MODE = originalAdmission;
      setDefaultCACertificates(originalCa);
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});
