// Disposable PostgreSQL 16 proof only. No external URL, provider or live service.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { runOwnedPersistenceScenario } from "./harness/owned-p2-lifecycle-persistence.mjs";
import { captureP2InteractiveCourseDraftBaseline, captureP2InteractiveCourseDraftEditsBaseline, captureP2InteractiveCourseReorderBaseline,
  captureP2InteractiveCurriculumCreateBaseline, captureP2InteractivePublicationBaseline, captureP2InteractiveQuizSaveBaseline,
  captureP2InteractiveFreeEnrollmentBaseline, observeP2InteractiveFreeEnrollmentCase,
  captureP2InteractivePaidGrantBaseline, observeP2InteractivePaidGrantCase,
  captureP2InteractivePaidArchiveBaseline, observeP2InteractivePaidArchiveCase, validateP2InteractivePaidArchive,
  captureP2InteractivePaidRepublishBaseline, observeP2InteractivePaidRepublishCase, validateP2InteractivePaidRepublish,
  captureP2InteractivePaidLearnerAccessBaseline, observeP2InteractivePaidLearnerAccessCase, validateP2InteractivePaidLearnerAccess,
  captureP2InteractiveLessonEntryBaseline, observeP2InteractiveLessonEntryCase,
  captureP2InteractiveResumeBaseline, observeP2InteractiveResumeCase,
  captureP2InteractiveRestoreBaseline, observeP2InteractiveRestoreCase,
  captureP2InteractiveAckLossBaseline, observeP2InteractiveAckLossCase,
  captureP2InteractiveLessonDenialBaseline, observeP2InteractiveLessonDenialCase,
  captureP2InteractiveAssessmentBaseline, observeP2InteractiveAssessmentCase,
  captureP2InteractivePaidRevokeBaseline, observeP2InteractivePaidRevokeCase, validateP2InteractivePaidRevoke,
  observeP2InteractiveCourseDraftCase, observeP2InteractiveCourseDraftEditsCase, observeP2InteractiveCourseReorderCase,
  observeP2InteractiveCurriculumCreateCase, observeP2InteractivePublicationCase, observeP2InteractiveQuizSaveCase, p2LifecyclePersistenceTargetSha256,
  validateP2InteractiveCourseDraft, validateP2InteractiveCourseDraftEdits, validateP2InteractiveCourseReorder,
  validateP2InteractiveCurriculumCreate, validateP2InteractivePublication, validateP2InteractiveQuizSave } from "./p2-lifecycle-persistence-probe.mjs";
import { verifyP2LifecycleOwnedSourceManifest } from "./p2-lifecycle-owned-source-manifest.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const apiPins = { course: "0bb054d5a04db71c481a8b3d182db6df19782cdc", community: "8594d953a5c0e0849e7a2e5e0de21f03537c4dc4" };
const courseRevokeFixedPin = "54fd289a5a8579bfbe343afb07482f406b56ad5b";
const hash = value => createHash("sha256").update(value).digest("hex");
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
let phase = "preflight";
const POSTGRES18_MODE = "--postgres18-manifest";
async function readManifest() {
  let size = 0; const chunks = [];
  for await (const chunk of process.stdin) { size += chunk.length; assert.ok(size <= 512_000, "Source manifest too large"); chunks.push(chunk); }
  assert.ok(size > 0, "Source manifest required"); return Buffer.concat(chunks);
}

async function main() {
  assert.equal(process.env.P2_LIFECYCLE_PERSISTENCE_OWNED_TEST, "true", "Explicit owned test opt-in required");
  assert.equal(process.versions.node.split(".")[0], "24", "Node 24 required");
  const containerMode = process.argv.length === 3 && process.argv[2] === POSTGRES18_MODE;
  assert.equal(process.argv.length, containerMode ? 3 : 2, "Fixed owned mode required");
  const postgresMajor = Number(process.env.OWNED_POSTGRES_MAJOR ?? "16");
  assert.equal(postgresMajor, containerMode ? 18 : 16, "Selected PostgreSQL major required");
  const pgBin = process.env.PG_BIN; assert.ok(pgBin?.startsWith("/"));
  if (containerMode) assert.equal(pgBin, "/usr/lib/postgresql/18/bin", "Fixed PostgreSQL 18 binary directory required");
  assert.match(run(join(pgBin, "postgres"), ["--version"]), new RegExp(`PostgreSQL\\) ${postgresMajor}\\.`, "u"));
  const sources = containerMode ? { frontend: "/source", course: "/exact-sources/lash-her-course-api", community: "/exact-sources/lash-her-community-api" }
    : { frontend: root, course: resolve(process.env.P2_COURSE_SOURCE_ROOT ?? "/Users/dardan/workspace/lash-her-course-api/.worktrees/phase2-course"),
      community: resolve(process.env.P2_COMMUNITY_SOURCE_ROOT ?? "/Users/dardan/workspace/lash-her-community-api/.worktrees/phase2-community") };
  let commits, sourceManifestSha256 = null;
  if (containerMode) {
    phase = "exact-source-manifest";
    const verified = verifyP2LifecycleOwnedSourceManifest(await readManifest(), sources);
    commits = Object.fromEntries(Object.entries(verified.manifest.sources).map(([name, source]) => [name, source.revision]));
    sourceManifestSha256 = verified.sourceManifestSha256;
  } else {
    commits = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, run("git", ["rev-parse", "HEAD"], { cwd: source }).trim()]));
    for (const [name, source] of Object.entries(sources)) {
      assert.equal(run("git", ["remote", "get-url", "origin"], { cwd: source }).trim(), `https://github.com/princessdardan/lash-her-${name === "frontend" ? "frontend" : name + "-api"}.git`);
      assert.equal(run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: source }), "", `${name} source must be exact and clean`);
    }
  }
  assert.equal(commits.course, apiPins.course); assert.equal(commits.community, apiPins.community); assert.match(commits.frontend, /^[a-f0-9]{40}$/u);
  let revokeSource;
  const fixedRevokeRoot = process.env.P2_COURSE_REVOKE_FIXED_SOURCE_ROOT;
  if (fixedRevokeRoot !== undefined) {
    assert.ok(!containerMode && fixedRevokeRoot.startsWith("/"), "Fixed Course revoke fixture requires its native exact source pin");
    const cwd = resolve(fixedRevokeRoot);
    const git = (...args) => run("git", args, { cwd }).trim();
    assert.equal(git("rev-parse", "HEAD"), courseRevokeFixedPin);
    assert.equal(git("remote", "get-url", "origin"), "https://github.com/princessdardan/lash-her-course-api.git");
    assert.equal(git("status", "--porcelain", "--untracked-files=no"), "", "Fixed Course revoke source must be exact and clean");
    for (const path of ["drizzle", "src/db/schema.ts", "package.json", "package-lock.json"]) {
      assert.equal(git("rev-parse", `HEAD:${path}`), run("git", ["rev-parse", `HEAD:${path}`], { cwd: sources.course }).trim());
    }
    revokeSource = { root: cwd, revision: courseRevokeFixedPin };
  }

  const directory = mkdtempSync(join(tmpdir(), "p2-lifecycle-persistence-")); chmodSync(directory, 0o700);
  const data = join(directory, "data"), certificate = join(directory, "server.crt"), key = join(directory, "server.key");
  const clients = []; let running = false;
  try {
    phase = "owned-tls-cluster";
    const probe = createServer(); await new Promise((done, fail) => { probe.once("error", fail); probe.listen(0, "127.0.0.1", done); });
    const port = probe.address().port; await new Promise(done => probe.close(done));
    const clean = { PATH: process.env.PATH, LC_ALL: "C", LANG: "C" };
    run(join(pgBin, "initdb"), ["-D", data, "-A", "trust", "-U", "persistence_admin", "-E", "UTF8", "--locale=C"], { env: clean });
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", certificate], { env: clean }); chmodSync(key, 0o600);
    writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${certificate}'\nssl_key_file='${key}'\npassword_encryption='scram-sha-256'\n`);
    writeFileSync(join(data, "pg_hba.conf"), "local all all trust\nhostssl all persistence_admin 127.0.0.1/32 trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n");
    run(join(pgBin, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"], { env: clean }); running = true;
    const ca = readFileSync(certificate, "utf8");
    const connect = async (options, readRuntime = false) => { const client = new Client({ ...options, ssl: { rejectUnauthorized: true, ca, servername: "localhost" }, enableChannelBinding: true,
      options: `-c search_path=${readRuntime ? "pg_catalog,public" : "public,pg_catalog"}` }); clients.push(client); client.on("error", () => {}); await client.connect(); assert.equal(client.connection.stream.encrypted, true); assert.equal(client.connection.stream.authorized, true); return client; };
    const control = await connect({ host: "localhost", port, user: "persistence_admin", database: "postgres" });
    const admin = {}, runtime = {}, targets = {}, migrations = {};
    for (const name of ["frontend", "course", "community"]) {
      phase = `prepare-${name}-database`;
      const database = `owned_persistence_${name}`, role = `owned_${name}_runtime`, password = randomBytes(32).toString("hex");
      await control.query(`create role ${role} login noinherit password '${password}'`); await control.query(`create database ${database}`);
      await control.query(`revoke connect on database ${database} from public`); await control.query(`grant connect on database ${database} to ${role}`);
      admin[name] = await connect({ host: "localhost", port, user: "persistence_admin", database });
      const require = createRequire(join(sources[name], "package.json"));
      const { drizzle } = require("drizzle-orm/node-postgres"), { migrate } = require("drizzle-orm/node-postgres/migrator");
      phase = `migrate-${name}-database`;
      if (name === "frontend") {
        const { frontendMigrationArtifact } = await import(pathToFileURL(join(sources.frontend, "ops/platform/frontend-migration.mjs")).href);
        const artifact = frontendMigrationArtifact(sources.frontend); await admin[name].query("create schema drizzle");
        await admin[name].query("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
        for (const migration of artifact.migrations) { phase = `migrate-frontend-${migration.tag}`; await admin[name].query("begin"); try { for (const statement of migration.sql) await admin[name].query(statement);
          await admin[name].query("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]); await admin[name].query("commit"); }
        catch (error) { await admin[name].query("rollback"); throw error; } }
      } else await migrate(drizzle(admin[name]), { migrationsFolder: join(sources[name], "drizzle") });
      await admin[name].query(`grant usage on schema public to ${role}`); await admin[name].query(`grant select on all tables in schema public to ${role}`);
      phase = `verify-${name}-runtime`;
      runtime[name] = await connect({ host: "localhost", port, user: role, password, database }, true);
      const identity = (await runtime[name].query("select current_user::regrole::oid::text as oid")).rows[0];
      targets[name] = { host: "localhost", port, database, runtimeRole: role, runtimeRoleOid: identity.oid, serverMajor: postgresMajor };
      targets[name].targetSha256 = p2LifecyclePersistenceTargetSha256(name, targets[name]);
      migrations[name] = Number((await admin[name].query("select count(*)::int as count from drizzle.__drizzle_migrations")).rows[0].count);
    }
    assert.deepEqual(migrations, { frontend: 83, course: 22, community: 11 });
    phase = "actual-three-domain-observer";
    const plan = { candidateSha256: hash("owned-candidate"), configurationSha256: hash("owned-configuration"), sources: commits, targets };
    const result = await runOwnedPersistenceScenario({ admin, runtime, plan });
    phase = "actual-interactive-course-draft";
    const draftChecks = await runOwnedDraftWitness({ control, course: admin.course, frontend: runtime.frontend,
      target: targets.course, sourceCommit: commits.course, courseSource: sources.course, revokeSource, ca,
      community: admin.community, communityTarget: targets.community, communityCommit: commits.community, communitySource: sources.community });
    const receipt = { version: 1, status: `P2_LIFECYCLE_PERSISTENCE_OWNED_POSTGRES${postgresMajor}_PASS`, postgresMajor, frontendMigrations: 83,
      courseMigrations: 22, communityMigrations: 11, sourceCommits: commits, checks: [...result.checks, ...draftChecks], skipped: 0, readOnly: true,
      fixtureOnly: true, providerTouched: false, liveCertification: false, sourceMode: containerMode ? "parent-issued-manifest-and-mounted-readback" : "clean-git-checkouts",
      ...(revokeSource ? { courseRevokeSourceCommit: revokeSource.revision } : {}),
      sourceManifestSha256,
      sourceSha256: Object.fromEntries(["p2-lifecycle-state-witness.mjs", "p2-lifecycle-persistence-probe.mjs", "p2-lifecycle-owned-source-manifest.mjs", "harness/owned-p2-lifecycle-persistence.mjs", "test-p2-lifecycle-persistence-local.mjs"]
        .map(name => [name, hash(readFileSync(join(root, "ops/platform", name)))])) };
    console.log(JSON.stringify(receipt));
  } finally {
    for (const client of clients.reverse()) { try { await client.end(); } catch {} }
    if (running) { try { run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); } catch {} }
    rmSync(directory, { recursive: true, force: true });
  }
}

async function runOwnedDraftWitness({ control, course, frontend, target, sourceCommit, courseSource, revokeSource, ca,
  community, communityTarget, communityCommit, communitySource }) {
  const user = "owned_course_draft_migration", password = randomBytes(32).toString("hex"), database = target.database;
  await control.query(`CREATE ROLE ${user} LOGIN NOINHERIT PASSWORD '${password}'`);
  await control.query(`GRANT CONNECT ON DATABASE ${database} TO ${user}`);
  await course.query(`GRANT USAGE ON SCHEMA public TO ${user}`);
  await course.query(`GRANT SELECT ON public.courses, public.modules, public.lessons, public.quiz_revisions, public.quiz_attempts,
    public.entitlement_grants, public.enrollments, public.entitlement_idempotency_keys, public.community_enrollment_streams,
    public.community_enrollment_outbox, public.lesson_progress, public.admin_entitlement_commands,
    public.admin_entitlement_command_effects, public.entitlement_revocations, public.account_lifecycle_states,
    public.account_lifecycle_commands, public.users, public.video_assets TO ${user}`);
  const job = { schemaVersion: 2, qualificationTargetProfile: profile, kind: "operator-migration", operator: "Dardan",
    environment: "staging", contractPhase: "p2", releaseId: "owned-draft-read", sourceCommit, runtimeRole: target.runtimeRole,
    phase2ContractManifestSha256: `sha256:${hash(readFileSync(join(root, "contracts/api-integration/p2-candidate/manifest.json")))}`,
    target: { schemaVersion: 2, qualificationTargetProfile: profile, environment: "staging", service: "lash-her-course-api",
      host: target.host, port: target.port, database, user, serverMajor: target.serverMajor } };
  const communityUser = "owned_community_delivery_migration", communityPassword = randomBytes(32).toString("hex");
  await control.query(`CREATE ROLE ${communityUser} LOGIN NOINHERIT PASSWORD '${communityPassword}'`);
  await control.query(`GRANT CONNECT ON DATABASE ${communityTarget.database} TO ${communityUser}`);
  await community.query(`GRANT USAGE ON SCHEMA public TO ${communityUser}`);
  await community.query(`GRANT SELECT ON public.course_enrollment_inbox,public.course_enrollment_projections TO ${communityUser}`);
  const communityJob = { ...job, sourceCommit: communityCommit, runtimeRole: communityTarget.runtimeRole, target: { ...job.target,
    service: "lash-her-community-api", host: communityTarget.host, port: communityTarget.port, database: communityTarget.database,
    user: communityUser, serverMajor: communityTarget.serverMajor } };
  const dependencies = {
    verifyEnvironment: async () => {},
    verifySession: async () => assert.equal((await frontend.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks
      WHERE pid=pg_catalog.pg_backend_pid() AND locktype='advisory' AND granted AND mode='ExclusiveLock') AS held`)).rows[0].held, true),
    readCourseDatabaseUrl: () => `postgresql://${user}:${password}@${target.host}:${target.port}/${database}?sslmode=verify-full`,
    communityJob, readCommunityDatabaseUrl: () =>
      `postgresql://${communityUser}:${communityPassword}@${communityTarget.host}:${communityTarget.port}/${communityTarget.database}?sslmode=verify-full`,
  };
  const input = (name, changes = {}) => {
    const draft = { title: "Owned draft é", slug: `owned-draft-${name}`, description: "Description", introduction: "Introduction",
      currency: "CAD", accessMode: "paid", priceCents: 12000, cover: { url: "https://example.invalid/cover", alt: "Cover" },
      seo: { title: "SEO title", description: "SEO description", noIndex: true }, taxClassification: "txcd_10103000", status: "draft",
      ...changes };
    return { draft, selection: { slug: draft.slug, bodySha256: hash(JSON.stringify(draft)) }, courseId: randomUUID() };
  };
  const create = ({ draft, courseId }) => course.query(`INSERT INTO public.courses
    (id,slug,title,description,introduction,currency,access_mode,price_cents,cover,seo,tax_classification,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [courseId, draft.slug, draft.title, draft.description, draft.introduction, draft.currency, draft.accessMode, draft.priceCents,
    draft.cover, draft.seo, draft.taxClassification, draft.status]);
  const browser = ({ selection, courseId }) => ({ courseId, slug: selection.slug, revision: 1, status: "draft" });
  const capture = ({ selection, draft }) => captureP2InteractiveCourseDraftBaseline(job, selection, draft, dependencies);
  const observe = (fixture, baseline, receipt = browser(fixture)) =>
    observeP2InteractiveCourseDraftCase(job, fixture.selection, baseline, receipt, dependencies);
  const lock = () => frontend.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))", ["lash-her:private-db:migrations"]);
  const unlock = () => frontend.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1))", ["lash-her:private-db:migrations"]);
  const trust = getCACertificates("default");
  setDefaultCACertificates([...trust, ca]);
  await lock();
  try {
    const draft = input("rich"), reversed = Object.fromEntries(Object.entries(draft.draft).reverse());
    assert.deepEqual(validateP2InteractiveCourseDraft(draft.selection, draft.draft), draft.draft);
    assert.throws(() => validateP2InteractiveCourseDraft(draft.selection, reversed), { check: "course-draft-body-hash" });
    assert.throws(() => validateP2InteractiveCourseDraft({ ...draft.selection, bodySha256: hash(JSON.stringify(reversed)) }, reversed),
      { check: "course-draft-body" });
    for (const invalid of [input("cover-order", { cover: { alt: "Cover", url: "https://example.invalid/cover" } }),
      input("seo-order", { seo: { noIndex: true, title: "SEO title" } })]) {
      assert.throws(() => validateP2InteractiveCourseDraft(invalid.selection, invalid.draft), { check: "course-draft-body" });
    }
    const changedShape = input("foreign", { expectedRevision: 1 });
    assert.throws(() => validateP2InteractiveCourseDraft(changedShape.selection, changedShape.draft), { check: "course-draft-body" });
    await assert.rejects(captureP2InteractiveCourseDraftBaseline(job, draft.selection, draft.draft,
      { ...dependencies, readCourseDatabaseUrl: () => dependencies.readCourseDatabaseUrl().replace(user, target.runtimeRole) }),
    { check: "credential-target" });
    for (const fixture of [draft, input("free", { accessMode: "free", priceCents: 0, description: null, introduction: null,
      cover: null, seo: { noIndex: false }, taxClassification: null })]) {
      const baseline = await capture(fixture);
      assert.equal(JSON.stringify(baseline), "{}");
      await create(fixture);
      await assert.rejects(observe(fixture, {}), { check: "course-draft-receipt" });
      await assert.rejects(observe(fixture, baseline, { ...browser(fixture), revision: 2 }), { check: "course-draft-receipt" });
      await assert.rejects(observeP2InteractiveCourseDraftCase({ ...job, sourceCommit: "c".repeat(40) }, fixture.selection,
        baseline, browser(fixture), dependencies), { check: "course-draft-receipt" });
      assert.deepEqual(await observe(fixture, baseline), { ...browser(fixture), readOnly: true });
      await assert.rejects(observe(fixture, baseline), { check: "course-draft-receipt" });
      await assert.rejects(capture(fixture), { check: "course-draft-already-present" });
    }
    for (const [field, value] of Object.entries({ title: "Wrong title", description: null, introduction: null, currency: "USD",
      priceCents: 12001, cover: { url: "https://example.invalid/other", alt: "Other" }, seo: { noIndex: false },
      taxClassification: "txcd_other", status: "archived", courseId: randomUUID() })) {
      const fixture = input(field.toLowerCase()), baseline = await capture(fixture);
      await create(field === "courseId" ? { ...fixture, courseId: value } : { ...fixture, draft: { ...fixture.draft, [field]: value } });
      await assert.rejects(observe(fixture, baseline), { check: "course-draft-persistence" });
    }
    const access = input("access"), accessBaseline = await capture(access);
    await create({ ...access, draft: { ...access.draft, accessMode: "free", priceCents: 0 } });
    await assert.rejects(observe(access, accessBaseline), { check: "course-draft-persistence" });
    const revision = input("revision"), revisionBaseline = await capture(revision);
    await create(revision);
    await course.query("UPDATE public.courses SET revision=2 WHERE id=$1", [revision.courseId]);
    await assert.rejects(observe(revision, revisionBaseline), { check: "course-draft-persistence" });
    const missing = input("missing");
    await assert.rejects(observe(missing, await capture(missing)), { check: "course-draft-persistence" });
    await runOwnedDraftEditWitness({ course, job, dependencies, input, create });
    await runOwnedCourseReorderWitness({ course, job, dependencies, input, create });
    await runOwnedCurriculumCreateWitness({ course, job, dependencies, input, create });
    await runOwnedPublicationWitness({ course, job, dependencies, input, create });
    await runOwnedQuizSaveWitness({ course, job, dependencies, input, create });
    const settle = await ownedEnrollmentSettlement(course, community, communitySource);
    await runOwnedPaidRevokeWitness({ course, job: revokeSource ? { ...job, sourceCommit: revokeSource.revision } : job,
      dependencies, input, create, courseSource: revokeSource?.root ?? courseSource, expiryFixed: revokeSource !== undefined, community, settle });
    await runOwnedFreeEnrollmentWitness({ course, job, dependencies, input, create, settle, courseSource, community });
    await runOwnedPaidGrantWitness({ course, job, dependencies, input, create, courseSource, community, settle });
    await runOwnedPaidArchiveWitness({ course, job, dependencies, input, create, courseSource });
    await runOwnedPaidRepublishWitness({ course, job, dependencies, input, create, courseSource });
    await runOwnedPaidLearnerAccessWitness({ course, job, dependencies, input, create, courseSource });
    await runOwnedLessonEntryWitness({ course, job: revokeSource ? { ...job, sourceCommit: revokeSource.revision } : job,
      dependencies, input, create, courseSource: revokeSource?.root ?? courseSource });
    await unlock();
    try { await assert.rejects(capture(input("unheld"))); }
    finally { await lock(); }
    return ["course-draft-exact-browser-bytes-held-absent-to-created-draft-and-private-fields", "course-draft-wrong-row-field-role-or-unheld-session-refused",
      "course-draft-edit-held-winning-fields-single-revision-and-stale-unchanged", "course-draft-edit-wrong-baseline-winner-stale-and-replay-refused",
      "course-module-and-lesson-full-reorder-archived-siblings-and-stale-zero-writes",
      "course-reorder-rejects-foreign-parent-sparse-result-sibling-identity-archive-and-order-drift",
      "course-curriculum-create-normal-module-and-lesson-fields-with-single-revision-and-preserved-siblings",
      "course-curriculum-create-refuses-occupied-or-foreign-baselines-and-storage-drift",
      "course-rich-lesson-pinned-post-structure-safe-links-and-exact-stored-portable-text",
      "course-publication-held-status-revision-metadata-and-public-catalog-predicate",
      "course-publication-refuses-blocked-writes-state-metadata-and-issue-code-drift",
      "course-quiz-save-initial-and-revised-exact-document-editor-and-preserved-private-history",
      "course-quiz-save-refuses-private-shape-scope-and-database-history-drift",
      "course-free-enrollment-orderless-grant-joins-settled-activation-to-actual-community-inbox",
      "course-free-enrollment-refuses-ineligible-occupied-and-persisted-outcome-drift",
      "course-free-enrollment-exact-key-replay-preserves-original-course-and-community-history",
      "course-paid-grant-orderless-audited-effect-joins-settled-activation-to-actual-community-inbox",
      "course-paid-grant-refuses-ineligible-occupied-and-persisted-outcome-drift",
      "course-paid-second-grant-preserves-reviewed-existing-enrollment-history-and-community-activation",
      "course-paid-archive-pinned-repository-preserves-history-without-community-outbox-mutation",
      "course-paid-archive-refuses-identity-history-projection-and-independent-eligibility-drift",
      "course-paid-republish-pinned-repository-restores-only-effective-access-and-keeps-blocked-draft",
      "course-paid-republish-refuses-inconsistent-access-revision-account-and-learning-history",
      "course-paid-learner-pinned-quiz-and-playback-allow-archive-draft-and-revocation-boundaries",
      "course-paid-learner-refuses-lesson-receipt-revision-account-and-history-drift",
      "course-lesson-entry-exact-first-start-and-monotonic-playback-expiry-with-pinned-repositories",
      "course-lesson-entry-refuses-ineligible-fixtures-browser-mismatches-and-persistence-drift",
      "course-lesson-resume-pinned-playback-heartbeat-pause-rewind-and-monotonic-maximum",
      "course-lesson-resume-refuses-stale-cas-foreign-receipts-and-persistence-drift",
      "course-lesson-restore-pinned-revision-four-to-six-with-unchanged-positions-and-managed-playback",
      "course-lesson-restore-refuses-ineligible-prior-receipts-and-persistence-drift",
      "course-lesson-ack-loss-pinned-revision-six-to-eleven-without-replay-and-managed-playback",
      "course-lesson-ack-loss-refuses-ineligible-receipts-and-persistence-drift",
      "course-lesson-denial-pinned-repositories-preserve-foreign-learning-and-media-without-access-or-writes",
      "course-lesson-denial-refuses-ineligible-fixtures-foreign-receipts-and-history-drift",
      "course-assessment-pinned-fail-then-pass-attempts-and-progress-revisions",
      "course-assessment-refuses-ineligible-plans-mismatched-receipts-and-persistence-drift",
      "course-paid-revoke-pinned-audit-retained-grants-and-last-effective-grant-outbox",
      "course-paid-revoke-refuses-replay-wrong-command-revision-history-and-terminal-outbox",
      "course-paid-revoke-joins-settled-delivery-to-actual-community-inbox-and-stable-independent-projection",
      revokeSource ? "course-paid-revoke-corrected-source-ignores-unrelated-future-expiry" :
        "course-paid-revoke-refuses-missing-outbox-with-pinned-foreign-expiry-predicate-defect"];
  } finally {
    try { await unlock(); }
    finally { setDefaultCACertificates(trust); }
  }
}

async function runOwnedDraftEditWitness({ course, job, dependencies, input, create }) {
  const reviewed = ({ courseId, draft }, revision = 1) => {
    const { status: _status, ...fields } = draft;
    const winner = { ...fields, title: "Winning draft", description: null, introduction: "Winning introduction", accessMode: "free",
      priceCents: 0, cover: null, seo: { title: "Winning SEO", noIndex: false }, taxClassification: null, expectedRevision: revision };
    const stale = { ...fields, title: "Stale draft", description: "Stale description", expectedRevision: revision };
    return { selection: { courseId, slug: draft.slug, revision, winnerBodySha256: hash(JSON.stringify(winner)),
      staleBodySha256: hash(JSON.stringify(stale)) }, edits: { winner, stale } };
  };
  const apply = (courseId, body) => course.query(`UPDATE public.courses SET title=$2,description=$3,introduction=$4,
      currency=$5,access_mode=$6,price_cents=$7,cover=$8,seo=$9,tax_classification=$10,revision=revision+1
    WHERE id=$1::uuid AND revision=$11::int AND status='draft'`,
  [courseId, body.title, body.description, body.introduction, body.currency, body.accessMode, body.priceCents,
    body.cover, body.seo, body.taxClassification, body.expectedRevision]);
  const capture = ({ selection, edits }) => captureP2InteractiveCourseDraftEditsBaseline(job, selection, edits, dependencies);
  const browser = ({ selection }) => ({ courseId: selection.courseId, slug: selection.slug, revision: selection.revision + 1, status: "draft" });
  const observe = (test, baseline, result = browser(test)) =>
    observeP2InteractiveCourseDraftEditsCase(job, test.selection, baseline, result, dependencies);
  const fixture = input("edit-winning");
  const selected = reviewed(fixture);
  const { selection, edits } = selected;
  assert.deepEqual(validateP2InteractiveCourseDraftEdits(selection, edits), edits);
  assert.throws(() => validateP2InteractiveCourseDraftEdits({ ...selection, revision: 2_147_483_647 }, edits), { check: "course-draft-edit-selection" });
  assert.throws(() => validateP2InteractiveCourseDraftEdits({ ...selection, winnerBodySha256: selection.staleBodySha256 }, edits),
    { check: "course-draft-edit-selection" });
  const withRehashedStale = stale => [{ ...selection, staleBodySha256: hash(JSON.stringify(stale)) }, { ...edits, stale }];
  assert.throws(() => validateP2InteractiveCourseDraftEdits(...withRehashedStale({ ...edits.stale, title: edits.winner.title })),
    { check: "course-draft-edit-title" });
  assert.throws(() => validateP2InteractiveCourseDraftEdits(...withRehashedStale({ ...edits.stale, expectedRevision: 2 })),
    { check: "course-draft-body" });
  assert.throws(() => validateP2InteractiveCourseDraftEdits(...withRehashedStale({ ...edits.stale, status: "draft" })),
    { check: "course-draft-body" });
  const reverse = Object.fromEntries(Object.entries(edits.stale).reverse());
  assert.throws(() => validateP2InteractiveCourseDraftEdits(...withRehashedStale(reverse)), { check: "course-draft-body" });
  await assert.rejects(capture(selected), { check: "course-draft-edit-baseline" });
  await create(fixture);
  await assert.rejects(capture({ ...selected, selection: { ...selection, courseId: randomUUID() } }), { check: "course-draft-edit-baseline" });
  await assert.rejects(capture(reviewed(fixture, 2)), { check: "course-draft-edit-baseline" });
  const [sameTitleSelection, sameTitleEdits] = withRehashedStale({ ...edits.stale, title: fixture.draft.title });
  await assert.rejects(capture({ selection: sameTitleSelection, edits: sameTitleEdits }), { check: "course-draft-edit-baseline" });
  const before = await capture(selected);
  assert.equal(JSON.stringify(before), "{}");
  assert.equal((await apply(fixture.courseId, edits.winner)).rowCount, 1);
  assert.equal((await apply(fixture.courseId, edits.stale)).rowCount, 0);
  await assert.rejects(observe(selected, {}, browser(selected)), { check: "course-draft-edit-receipt" });
  await assert.rejects(observe(selected, before, { ...browser(selected), courseId: randomUUID() }), { check: "course-draft-edit-receipt" });
  await assert.rejects(observe(selected, before, { ...browser(selected), revision: 3 }), { check: "course-draft-edit-receipt" });
  await assert.rejects(observeP2InteractiveCourseDraftEditsCase(job, selection, before, browser(selected),
    { ...dependencies, verifySession: async () => {} }), { check: "course-draft-edit-receipt" });
  assert.deepEqual(await observe(selected, before), { ...browser(selected), readOnly: true });
  await assert.rejects(observe(selected, before), { check: "course-draft-edit-receipt" });

  for (const drift of ["stale-fields", "double-revision", "archived", "no-change"]) {
    const changed = input(`edit-${drift}`), test = reviewed(changed);
    await create(changed);
    const baseline = await capture(test);
    if (drift === "stale-fields") assert.equal((await apply(changed.courseId, test.edits.stale)).rowCount, 1);
    if (drift === "double-revision" || drift === "archived") {
      assert.equal((await apply(changed.courseId, test.edits.winner)).rowCount, 1);
      if (drift === "double-revision") await course.query("UPDATE public.courses SET revision=revision+1 WHERE id=$1::uuid", [changed.courseId]);
      else await course.query("UPDATE public.courses SET status='archived' WHERE id=$1::uuid", [changed.courseId]);
    }
    await assert.rejects(observe(test, baseline), { check: "course-draft-persistence" });
    await assert.rejects(observe(test, baseline), { check: "course-draft-edit-receipt" });
  }
}

async function runOwnedCourseReorderWitness({ course, job, dependencies, input, create }) {
  const tables = { module: ["modules", "course_id"], lesson: ["lessons", "module_id"] };
  const insertSibling = (kind, parentId, id, position, archived = false) => {
    const [table, key] = tables[kind];
    return course.query(`INSERT INTO public.${table}(id,${key},slug,title,position,archived_at)
      VALUES($1,$2,$3,'Owned sibling',$4,CASE WHEN $5 THEN pg_catalog.clock_timestamp() END)`,
    [id, parentId, `sibling-${id}`, position, archived]);
  };
  const reviewed = ({ courseId, slug, parentId, kind, before, revision = 1 }) => {
    const [first, second, third, ...rest] = before;
    const winner = { expectedCourseRevision: revision, ids: [second, first, third, ...rest] };
    const stale = { expectedCourseRevision: revision, ids: [first, third, second, ...rest] };
    return { selection: { courseId, slug, revision, kind, parentId, winnerBodySha256: hash(JSON.stringify(winner)),
      staleBodySha256: hash(JSON.stringify(stale)) }, reorder: { before, winner, stale } };
  };
  const seed = async (kind, name) => {
    const fixture = input(`reorder-${name}`), { courseId, draft: { slug } } = fixture;
    await create(fixture);
    const parentId = kind === "module" ? courseId : randomUUID();
    if (kind === "lesson") await insertSibling("module", courseId, parentId, 1);
    const before = Array.from({ length: 3 }, () => randomUUID());
    for (const [index, id] of before.entries()) await insertSibling(kind, parentId, id, (index + 1) * 3, index === 1);
    return reviewed({ courseId, slug, kind, parentId, before });
  };
  const capture = ({ selection, reorder }) => captureP2InteractiveCourseReorderBaseline(job, selection, reorder, dependencies);
  const browser = ({ selection, reorder }) => ({ courseId: selection.courseId, parentId: selection.parentId, kind: selection.kind,
    revision: selection.revision + 1, ids: reorder.winner.ids });
  const observe = (test, baseline, receipt = browser(test)) =>
    observeP2InteractiveCourseReorderCase(job, test.selection, baseline, receipt, dependencies);
  const apply = async ({ selection }, body) => {
    const [table, key] = tables[selection.kind];
    await course.query("BEGIN");
    try {
      const { rowCount } = await course.query("UPDATE public.courses SET revision=revision+1 WHERE id=$1::uuid AND revision=$2::int AND status='draft'",
        [selection.courseId, body.expectedCourseRevision]);
      if (rowCount === 1) {
        await course.query(`UPDATE public.${table} SET position=position+1000 WHERE ${key}=$1::uuid`, [selection.parentId]);
        for (const [index, id] of body.ids.entries()) {
          await course.query(`UPDATE public.${table} SET position=$2,updated_at=pg_catalog.clock_timestamp() WHERE id=$1::uuid`, [id, index + 1]);
        }
      }
      await course.query("COMMIT");
      return rowCount;
    } catch (error) {
      await course.query("ROLLBACK");
      throw error;
    }
  };

  for (const kind of ["module", "lesson"]) {
    const test = await seed(kind, kind), { selection, reorder } = test;
    assert.deepEqual(validateP2InteractiveCourseReorder(selection, reorder), reorder);
    const [first, second, third] = reorder.before;
    const withWinner = winner => [{ ...selection, winnerBodySha256: hash(JSON.stringify(winner)) }, { ...reorder, winner }];
    assert.throws(() => validateP2InteractiveCourseReorder(...withWinner({ ids: reorder.winner.ids, expectedCourseRevision: 1 })),
      { check: "course-reorder-body" });
    assert.throws(() => validateP2InteractiveCourseReorder(...withWinner({ expectedCourseRevision: 1, ids: [first, first, third] })),
      { check: "course-reorder-body" });
    assert.throws(() => validateP2InteractiveCourseReorder(...withWinner({ expectedCourseRevision: 1, ids: [third, second, first] })),
      { check: "course-reorder-adjacent" });
    assert.throws(() => validateP2InteractiveCourseReorder(...withWinner({ expectedCourseRevision: 2, ids: reorder.winner.ids })),
      { check: "course-reorder-body" });
    assert.throws(() => validateP2InteractiveCourseReorder(selection, { ...reorder, before: [first, second] }), { check: "course-reorder-list" });
    await assert.rejects(capture({ ...test, selection: { ...selection, revision: 2 }, reorder }), { check: "course-reorder-body" });
    const baseline = await capture(test);
    assert.equal(JSON.stringify(baseline), "{}");
    assert.equal(await apply(test, reorder.winner), 1);
    assert.equal(await apply(test, reorder.stale), 0);
    await assert.rejects(observe(test, {}, browser(test)), { check: "course-reorder-receipt" });
    await assert.rejects(observe(test, baseline, { ...browser(test), ids: reorder.stale.ids }), { check: "course-reorder-receipt" });
    await assert.rejects(observe(test, baseline, { ...browser(test), parentId: randomUUID() }), { check: "course-reorder-receipt" });
    assert.deepEqual(await observe(test, baseline), { ...browser(test), readOnly: true });
    await assert.rejects(observe(test, baseline), { check: "course-reorder-receipt" });
  }

  const foreign = await seed("lesson", "foreign"), other = input("reorder-other");
  await create(other);
  await assert.rejects(capture({ ...foreign, selection: { ...foreign.selection, courseId: other.courseId, slug: other.draft.slug } }),
    { check: "course-reorder-parent" });
  await insertSibling("lesson", foreign.selection.parentId, randomUUID(), 12, true);
  await assert.rejects(capture(foreign), { check: "course-reorder-siblings" });

  for (const drift of ["sparse", "archive", "slug", "parent", "stale", "revision"]) {
    const kind = drift === "parent" ? "lesson" : "module", test = await seed(kind, drift), baseline = await capture(test);
    assert.equal(await apply(test, drift === "stale" ? test.reorder.stale : test.reorder.winner), 1);
    const { courseId, parentId } = test.selection, [archived, active] = test.reorder.winner.ids;
    if (drift === "sparse") await course.query("UPDATE public.modules SET position=position*3+100 WHERE course_id=$1::uuid", [parentId]);
    if (drift === "archive") await course.query("UPDATE public.modules SET archived_at=NULL WHERE id=$1::uuid", [archived]);
    if (drift === "slug") await course.query("UPDATE public.modules SET slug='changed-sibling' WHERE id=$1::uuid", [active]);
    if (drift === "parent") await course.query("UPDATE public.modules SET archived_at=pg_catalog.clock_timestamp() WHERE id=$1::uuid", [parentId]);
    if (drift === "revision") await course.query("UPDATE public.courses SET revision=revision+1 WHERE id=$1::uuid", [courseId]);
    const check = ["sparse", "stale"].includes(drift) ? "course-reorder-siblings"
      : drift === "revision" ? "course-reorder-draft" : "course-reorder-identity-changed";
    await assert.rejects(observe(test, baseline), { check });
    await assert.rejects(observe(test, baseline), { check: "course-reorder-receipt" });
  }
}

async function runOwnedCurriculumCreateWitness({ course, job, dependencies, input, create }) {
  const seed = async (kind, name) => {
    const fixture = input(`curriculum-create-${name}`), { courseId, draft: { slug } } = fixture;
    await create(fixture);
    const parentId = kind === "module" ? courseId : randomUUID(), siblingId = randomUUID(), itemId = randomUUID();
    if (kind === "lesson") {
      await course.query("INSERT INTO public.modules(id,course_id,slug,title,position) VALUES($1,$2,'lesson-parent','Lesson parent',1)", [parentId, courseId]);
    }
    const [table, foreignKey] = kind === "module" ? ["modules", "course_id"] : ["lessons", "module_id"];
    await course.query(`INSERT INTO public.${table}(id,${foreignKey},slug,title,position,archived_at)
      VALUES($1,$2,'existing-sibling','Existing sibling',2,pg_catalog.clock_timestamp())`, [siblingId, parentId]);
    const childSlug = "selected-child";
    const body = kind === "module"
      ? { expectedCourseRevision: 1, title: "New module", slug: childSlug, description: "Reviewed description", position: 1 }
      : { expectedCourseRevision: 1, title: "New lesson", slug: childSlug, position: 1,
        contentDocument: { version: 1, blocks: [] }, transcript: "Reviewed transcript", isPreview: true, captions: [] };
    return { selection: { courseId, slug, revision: 1, kind, parentId, childSlug, bodySha256: hash(JSON.stringify(body)) },
      body, siblingId, itemId };
  };
  const capture = ({ selection, body }) => captureP2InteractiveCurriculumCreateBaseline(job, selection, body, dependencies);
  const browser = ({ selection, itemId }) => ({ courseId: selection.courseId, parentId: selection.parentId, kind: selection.kind,
    itemId, slug: selection.childSlug, revision: selection.revision + 1 });
  const observe = (test, baseline, receipt = browser(test)) =>
    observeP2InteractiveCurriculumCreateCase(job, test.selection, baseline, receipt, dependencies);
  const withBody = (test, body) => ({ ...test, body, selection: { ...test.selection, childSlug: body.slug, bodySha256: hash(JSON.stringify(body)) } });
  const write = async ({ selection, body, itemId }) => {
    await course.query("BEGIN");
    try {
      assert.equal((await course.query("UPDATE public.courses SET revision=revision+1 WHERE id=$1::uuid AND revision=$2::int AND status='draft'",
        [selection.courseId, body.expectedCourseRevision])).rowCount, 1);
      if (selection.kind === "module") {
        await course.query("INSERT INTO public.modules(id,course_id,slug,title,description,position) VALUES($1,$2,$3,$4,$5,$6)",
          [itemId, selection.parentId, body.slug, body.title, body.description, body.position]);
      } else {
        await course.query(`INSERT INTO public.lessons(id,module_id,slug,title,position,content_document,transcript,is_preview,captions)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [itemId, selection.parentId, body.slug, body.title, body.position, body.contentDocument, body.transcript, body.isPreview, JSON.stringify(body.captions)]);
      }
      await course.query("COMMIT");
    } catch (error) {
      await course.query("ROLLBACK");
      throw error;
    }
  };

  for (const kind of ["module", "lesson"]) {
    const test = await seed(kind, kind);
    assert.deepEqual(validateP2InteractiveCurriculumCreate(test.selection, test.body), test.body);
    const wrongOrder = withBody(test, Object.fromEntries(Object.entries(test.body).reverse()));
    assert.throws(() => validateP2InteractiveCurriculumCreate(wrongOrder.selection, wrongOrder.body), { check: "course-curriculum-create-body" });
    assert.throws(() => validateP2InteractiveCurriculumCreate(test.selection, { ...test.body, title: "Wrong bytes" }),
      { check: "course-curriculum-create-body-hash" });
    await assert.rejects(capture(withBody(test, { ...test.body, slug: "existing-sibling" })), { check: "course-curriculum-create-occupied" });
    await assert.rejects(capture(withBody(test, { ...test.body, position: 2 })), { check: "course-curriculum-create-occupied" });
    if (kind === "lesson") {
      for (const changes of [{ contentDocument: { version: 1, blocks: [{}] } }, { captions: [{}] }]) {
        const invalid = withBody(test, { ...test.body, ...changes });
        assert.throws(() => validateP2InteractiveCurriculumCreate(invalid.selection, invalid.body), { check: "course-curriculum-create-lesson" });
      }
      await course.query("UPDATE public.modules SET archived_at=pg_catalog.clock_timestamp() WHERE id=$1::uuid", [test.selection.parentId]);
      await assert.rejects(capture(test), { check: "course-curriculum-create-parent" });
      await course.query("UPDATE public.modules SET archived_at=NULL WHERE id=$1::uuid", [test.selection.parentId]);
    }
    const baseline = await capture(test);
    assert.equal(JSON.stringify(baseline), "{}");
    await write(test);
    await assert.rejects(observe(test, {}, browser(test)), { check: "course-curriculum-create-receipt" });
    await assert.rejects(observe(test, baseline, { ...browser(test), slug: "foreign" }), { check: "course-curriculum-create-receipt" });
    assert.deepEqual(await observe(test, baseline), { ...browser(test), readOnly: true });
    await assert.rejects(observe(test, baseline), { check: "course-curriculum-create-receipt" });
  }
  const foreign = await seed("lesson", "foreign"), other = input("curriculum-foreign-course");
  await create(other);
  await assert.rejects(capture({ ...foreign, selection: { ...foreign.selection, courseId: other.courseId, slug: other.draft.slug } }),
    { check: "course-curriculum-create-parent" });

  for (const [field, sql, check] of [
    ["legacy-content", "UPDATE public.lessons SET content='unexpected' WHERE id=$1::uuid", "course-curriculum-create-persistence"],
    ["document", "UPDATE public.lessons SET content_document=NULL WHERE id=$1::uuid", "course-curriculum-create-persistence"],
    ["transcript", "UPDATE public.lessons SET transcript=NULL WHERE id=$1::uuid", "course-curriculum-create-persistence"],
    ["preview", "UPDATE public.lessons SET is_preview=false WHERE id=$1::uuid", "course-curriculum-create-persistence"],
    ["captions", "UPDATE public.lessons SET captions='[{}]'::jsonb WHERE id=$1::uuid", "course-curriculum-create-persistence"],
    ["archive", "UPDATE public.lessons SET archived_at=pg_catalog.clock_timestamp() WHERE id=$1::uuid", "course-curriculum-create-persistence"],
    ["position", "UPDATE public.lessons SET position=3 WHERE id=$1::uuid", "course-curriculum-create-persistence"],
    ["sibling-position", "UPDATE public.lessons SET position=3 WHERE id=$1::uuid", "course-curriculum-create-siblings"],
    ["sibling-archive", "UPDATE public.lessons SET archived_at=NULL WHERE id=$1::uuid", "course-curriculum-create-siblings"],
    ["parent-archive", "UPDATE public.modules SET archived_at=pg_catalog.clock_timestamp() WHERE id=$1::uuid", "course-curriculum-create-siblings"],
    ["revision", "UPDATE public.courses SET revision=revision+1 WHERE id=$1::uuid", "course-curriculum-create-draft"],
  ]) {
    const test = await seed("lesson", field), baseline = await capture(test);
    await write(test);
    const targetId = field.startsWith("sibling-") ? test.siblingId : field.startsWith("parent-") ? test.selection.parentId
      : field === "revision" ? test.selection.courseId : test.itemId;
    await course.query(sql, [targetId]);
    await assert.rejects(observe(test, baseline), { check });
    await assert.rejects(observe(test, baseline), { check: "course-curriculum-create-receipt" });
  }
  const moduleFixture = await seed("module", "module-drift"), before = await capture(moduleFixture);
  await write(moduleFixture);
  await course.query("UPDATE public.modules SET description='unexpected' WHERE id=$1::uuid", [moduleFixture.itemId]);
  await assert.rejects(observe(moduleFixture, before), { check: "course-curriculum-create-persistence" });

  const contentDocument = { version: 1, blocks: [
    { _type: "block", _key: "block-1-1", style: "h2", markDefs: [],
      children: [{ _type: "span", _key: "span-1-1", text: "Lash mapping é", marks: ["strong"] }] },
    { _type: "block", _key: "block-1-2", style: "normal", listItem: "bullet", level: 1,
      markDefs: [{ _type: "link", _key: "link-1-1", href: "https://example.invalid/guide" },
        { _type: "link", _key: "link-1-2", href: "/academy" }],
      children: [{ _type: "span", _key: "span-1-2", text: "Read the guide", marks: ["em", "link-1-1"] },
        { _type: "span", _key: "span-1-3", text: " and continue learning", marks: ["link-1-2"] }] },
  ] };
  const rich = async name => {
    const test = await seed("lesson", name);
    return withBody(test, { ...test.body, contentDocument });
  };
  const lesson = await rich("rich-lesson");
  assert.deepEqual(validateP2InteractiveCurriculumCreate(lesson.selection, lesson.body), lesson.body);
  const invalidEdits = [
    document => { document.blocks[0].style = "foreign"; },
    document => { document.blocks[0].children[0].marks = ["strong", "strong"]; },
    document => { document.blocks[0].children[0].value = "unreviewed field"; },
    document => { document.blocks[1].markDefs[0].href = "javascript:alert(1)"; },
    document => { document.blocks[1].markDefs[0].href = "//example.invalid/guide"; },
  ];
  for (const mutate of invalidEdits) {
    const modified = structuredClone(contentDocument);
    mutate(modified);
    const invalid = withBody(lesson, { ...lesson.body, contentDocument: modified });
    assert.throws(() => validateP2InteractiveCurriculumCreate(invalid.selection, invalid.body), { check: "course-curriculum-create-lesson" });
  }
  for (const wrong of [{ ...job, sourceCommit: "c".repeat(40) }, { ...job, phase2ContractManifestSha256: `sha256:${"d".repeat(64)}` }]) {
    await assert.rejects(captureP2InteractiveCurriculumCreateBaseline(wrong, lesson.selection, lesson.body, dependencies),
      { check: "course-curriculum-create-contract-target" });
  }
  const richBaseline = await capture(lesson);
  await write(lesson);
  assert.deepEqual(await observe(lesson, richBaseline), { ...browser(lesson), readOnly: true });
  const richDrift = await rich("rich-lesson-drift"), richDriftBaseline = await capture(richDrift);
  await write(richDrift);
  await course.query(`UPDATE public.lessons SET content_document=pg_catalog.jsonb_set(content_document,
    '{blocks,1,markDefs,0,href}',pg_catalog.to_jsonb('https://example.invalid/changed'::text)) WHERE id=$1::uuid`, [richDrift.itemId]);
  await assert.rejects(observe(richDrift, richDriftBaseline), { check: "course-curriculum-create-persistence" });
}

async function runOwnedPublicationWitness({ course, job, dependencies, input, create }) {
  const test = (name, outcome = "published") => {
    const fixture = input(`publication-${name}`);
    const selection = { courseId: fixture.courseId, slug: fixture.draft.slug, revision: 1, outcome,
      issueCodes: outcome === "blocked" ? ["MODULE_REQUIRED"] : [] };
    return { fixture, selection };
  };
  const capture = ({ selection }) => captureP2InteractivePublicationBaseline(job, selection, undefined, dependencies);
  const browser = ({ selection }) => ({ courseId: selection.courseId, slug: selection.slug,
    revision: selection.revision + (selection.outcome === "published" ? 1 : 0), status: selection.outcome === "published" ? "published" : "draft",
    issueCodes: selection.issueCodes });
  const observe = (selected, baseline, receipt = browser(selected)) =>
    observeP2InteractivePublicationCase(job, selected.selection, baseline, receipt, dependencies);
  const publish = ({ selection }) => course.query(`UPDATE public.courses SET status='published',revision=revision+1,
    updated_at=pg_catalog.clock_timestamp() WHERE id=$1::uuid AND revision=$2::int AND status='draft'`, [selection.courseId, selection.revision]);

  const blocked = test("blocked", "blocked");
  assert.equal(validateP2InteractivePublication(blocked.selection, undefined), undefined);
  assert.throws(() => validateP2InteractivePublication(blocked.selection, {}), { check: "course-publication-selection" });
  for (const issueCodes of [[], ["module_required"], ["MODULE_REQUIRED", "MODULE_REQUIRED"], ["TAX_CLASSIFICATION_REQUIRED", "MODULE_REQUIRED"],
    Array.from({ length: 17 }, (_, index) => `ISSUE_${String(index).padStart(2, "0")}`)]) {
    assert.throws(() => validateP2InteractivePublication({ ...blocked.selection, issueCodes }, undefined), { check: "course-publication-issue-codes" });
  }
  for (const outcome of ["published", "blocked"]) {
    const selected = outcome === "blocked" ? blocked : test("published");
    await assert.rejects(capture(selected), { check: "course-publication-state" });
    await create(selected.fixture);
    await assert.rejects(capture({ ...selected, selection: { ...selected.selection, courseId: randomUUID() } }), { check: "course-publication-state" });
    await assert.rejects(capture({ ...selected, selection: { ...selected.selection, revision: 2 } }), { check: "course-publication-state" });
    const baseline = await capture(selected);
    assert.equal(JSON.stringify(baseline), "{}");
    if (outcome === "published") assert.equal((await publish(selected)).rowCount, 1);
    await assert.rejects(observe(selected, {}), { check: "course-publication-receipt" });
    await assert.rejects(observe(selected, baseline, { ...browser(selected), revision: 9 }), { check: "course-publication-receipt" });
    await assert.rejects(observe(selected, baseline, { ...browser(selected), issueCodes: ["INVALID_METADATA"] }), { check: "course-publication-receipt" });
    await assert.rejects(observeP2InteractivePublicationCase(job, selected.selection, baseline, browser(selected),
      { ...dependencies, verifySession: async () => {} }), { check: "course-publication-receipt" });
    assert.deepEqual(await observe(selected, baseline), { ...browser(selected), readOnly: true });
    await assert.rejects(observe(selected, baseline), { check: "course-publication-receipt" });
    if (outcome === "published") await assert.rejects(capture(selected), { check: "course-publication-state" });
  }
  for (const [name, outcome, update, check] of [
    ["unchanged", "published", null, "course-publication-state"],
    ["revision", "published", "revision=revision+1", "course-publication-state"],
    ["unexpected-public", "blocked", "status='published'", "course-publication-state"],
    ["blocked-touch", "blocked", "updated_at=pg_catalog.clock_timestamp()", "course-publication-metadata"],
    ["blocked-title", "blocked", "title='Unexpected title'", "course-publication-metadata"],
    ["description", "published", "description=NULL", "course-publication-metadata"],
    ["cover", "published", "cover=NULL", "course-publication-metadata"],
    ["tax", "published", "tax_classification=NULL", "course-publication-metadata"],
    ["created-time", "published", "created_at=created_at-interval '1 day'", "course-publication-metadata"],
  ]) {
    const selected = test(name, outcome);
    await create(selected.fixture);
    const baseline = await capture(selected);
    if (outcome === "published" && update) assert.equal((await publish(selected)).rowCount, 1);
    if (update) await course.query(`UPDATE public.courses SET ${update} WHERE id=$1::uuid`, [selected.selection.courseId]);
    await assert.rejects(observe(selected, baseline), { check });
    await assert.rejects(observe(selected, baseline), { check: "course-publication-receipt" });
  }
}

async function runOwnedQuizSaveWitness({ course, job, dependencies, input, create }) {
  const canonical = document => JSON.stringify(document, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  const document = (mode, passingPercent, prompt = "Which shape is shown? é") => ({ version: 1, mode, passingPercent, questions: [{
    id: "question-1", prompt, options: [{ id: "option-a", text: "Round" }, { id: "option-b", text: "Square" }],
    correctOptionId: "option-b", feedback: "Review the example." }] });
  const bind = (test, body) => ({ ...test, body, selection: { ...test.selection,
    documentSha256: hash(canonical(body.document)), bodySha256: hash(JSON.stringify(body)) } });
  const seed = async (name, prior = false) => {
    const fixture = input(`quiz-save-${name}`), { courseId, draft: { slug } } = fixture;
    await create(fixture);
    const moduleId = randomUUID(), lessonId = randomUUID(), actorId = randomUUID(), quizId = randomUUID();
    await course.query("INSERT INTO public.modules(id,course_id,slug,title,position) VALUES($1,$2,'quiz-module','Quiz module',1)", [moduleId, courseId]);
    await course.query("INSERT INTO public.lessons(id,module_id,slug,title,position) VALUES($1,$2,'quiz-lesson','Quiz lesson',1)", [lessonId, moduleId]);
    let priorId, attemptId;
    if (prior) {
      const userId = randomUUID(), enrollmentId = randomUUID();
      priorId = randomUUID(); attemptId = randomUUID();
      await course.query("INSERT INTO public.users(id,email) VALUES($1,$2)", [userId, `quiz-learner-${userId}@example.invalid`]);
      await course.query("INSERT INTO public.enrollments(id,user_id,course_id,status,source,granted_at) VALUES($1,$2,$3,'active','free',pg_catalog.clock_timestamp())",
        [enrollmentId, userId, courseId]);
      await course.query("INSERT INTO public.quiz_revisions(id,lesson_id,revision,document,created_by) VALUES($1,$2,1,$3::jsonb,$4)",
        [priorId, lessonId, document("practice", 80), randomUUID()]);
      await course.query(`INSERT INTO public.quiz_attempts(id,user_id,lesson_id,quiz_revision_id,enrollment_id,request_id,request_hash,answers,
        correct_count,total_count,passed,completed) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,1,1,true,true)`,
      [attemptId, userId, lessonId, priorId, enrollmentId, randomUUID(), hash("owned-quiz-request"),
        JSON.stringify([{ questionId: "question-1", optionId: "option-b" }])]);
    }
    return bind({ selection: { courseId, slug, revision: 1, lessonId, quizRevision: prior ? 1 : 0, actorId }, moduleId, quizId, priorId, attemptId },
      { expectedCourseRevision: 1, document: prior ? document("graded", 90, "What is the revised technique?") : document("practice", 80) });
  };
  const capture = ({ selection, body }) => captureP2InteractiveQuizSaveBaseline(job, selection, body, dependencies);
  const browser = ({ selection, quizId }) => ({ courseId: selection.courseId, slug: selection.slug, lessonId: selection.lessonId, quizId,
    revision: selection.revision + 1, quizRevision: selection.quizRevision + 1, documentSha256: selection.documentSha256 });
  const observe = (test, baseline, receipt = browser(test)) => observeP2InteractiveQuizSaveCase(job, test.selection, baseline, receipt, dependencies);
  const write = async (test, { actorId = test.selection.actorId, stored = test.body.document, createdAgo = "0 seconds" } = {}) => {
    const { selection, quizId } = test;
    await course.query("BEGIN");
    try {
      assert.equal((await course.query("UPDATE public.courses SET revision=revision+1 WHERE id=$1::uuid AND revision=$2::int AND status='draft'",
        [selection.courseId, selection.revision])).rowCount, 1);
      await course.query(`INSERT INTO public.quiz_revisions(id,lesson_id,revision,document,created_by,created_at)
        VALUES($1,$2,$3,$4::jsonb,$5,pg_catalog.clock_timestamp()-$6::interval)`,
      [quizId, selection.lessonId, selection.quizRevision + 1, stored, actorId, createdAgo]);
      await course.query("COMMIT");
    } catch (error) {
      await course.query("ROLLBACK");
      throw error;
    }
  };

  for (const prior of [false, true]) {
    const test = await seed(prior ? "revised" : "initial", prior);
    assert.deepEqual(validateP2InteractiveQuizSave(test.selection, test.body), test.body);
    await assert.rejects(capture({ ...test, selection: { ...test.selection, quizRevision: prior ? 0 : 1 } }), { check: "course-quiz-save-revision" });
    const before = await capture(test);
    assert.equal(JSON.stringify(before), "{}");
    await write(test);
    await assert.rejects(observe(test, {}, browser(test)), { check: "course-quiz-save-receipt" });
    await assert.rejects(observe(test, before, { ...browser(test), quizRevision: test.selection.quizRevision }), { check: "course-quiz-save-receipt" });
    await assert.rejects(observe(test, before, { ...browser(test), documentSha256: "a".repeat(64) }), { check: "course-quiz-save-receipt" });
    assert.deepEqual(await observe(test, before), { ...browser(test), readOnly: true });
    await assert.rejects(observe(test, before), { check: "course-quiz-save-receipt" });
  }
  const invalid = await seed("invalid");
  const validate = (body, check) => assert.throws(() => validateP2InteractiveQuizSave(bind(invalid, body).selection, body), { check });
  const { document: valid } = invalid.body;
  validate({ document: valid, expectedCourseRevision: 1 }, "course-quiz-save-body");
  validate({ ...invalid.body, document: { version: 1, questions: valid.questions } }, "course-quiz-save-document");
  validate({ ...invalid.body, document: { ...valid, questions: [...valid.questions, ...valid.questions] } }, "course-quiz-save-questions");
  for (const patch of [{ correctOptionId: "foreign" }, { options: [valid.questions[0].options[0], valid.questions[0].options[0]] }]) {
    validate({ ...invalid.body, document: { ...valid, questions: [{ ...valid.questions[0], ...patch }] } }, "course-quiz-save-questions");
  }
  assert.throws(() => validateP2InteractiveQuizSave({ ...invalid.selection, bodySha256: "a".repeat(64) }, invalid.body), { check: "course-quiz-save-body-hash" });
  assert.throws(() => validateP2InteractiveQuizSave({ ...invalid.selection, documentSha256: "a".repeat(64) }, invalid.body), { check: "course-quiz-save-document-hash" });
  await assert.rejects(captureP2InteractiveQuizSaveBaseline({ ...job, sourceCommit: "a".repeat(40) }, invalid.selection, invalid.body, dependencies),
    { check: "course-quiz-save-contract-target" });
  await course.query("UPDATE public.modules SET archived_at=pg_catalog.clock_timestamp() WHERE id=$1::uuid", [invalid.moduleId]);
  await assert.rejects(capture(invalid), { check: "course-quiz-save-lesson" });

  for (const [name, options] of [["actor", { actorId: randomUUID() }], ["document", { stored: document("graded", 99) }],
    ["old-timestamp", { createdAgo: "1 hour" }]]) {
    const changed = await seed(name), before = await capture(changed);
    await write(changed, options);
    await assert.rejects(observe(changed, before), { check: "course-quiz-save-persistence" });
  }
  const altered = await seed("history", true), previous = await capture(altered);
  await write(altered);
  await course.query("BEGIN");
  try {
    await course.query("ALTER TABLE public.quiz_revisions DISABLE TRIGGER quiz_revisions_immutable");
    await course.query("UPDATE public.quiz_revisions SET document=$2::jsonb WHERE id=$1::uuid", [altered.priorId, document("practice", 95)]);
    await course.query("ALTER TABLE public.quiz_revisions ENABLE TRIGGER quiz_revisions_immutable");
    await course.query("COMMIT");
  } catch (error) {
    await course.query("ROLLBACK");
    throw error;
  }
  await assert.rejects(observe(altered, previous), { check: "course-quiz-save-history-changed" });
  const attempt = await seed("attempt", true), attemptBaseline = await capture(attempt);
  await write(attempt);
  await course.query(`UPDATE public.quiz_attempts SET user_id=NULL,enrollment_id=NULL,request_id=NULL,request_hash=NULL,
    answers='[]'::jsonb,deidentified_at=pg_catalog.clock_timestamp() WHERE id=$1::uuid`, [attempt.attemptId]);
  await assert.rejects(observe(attempt, attemptBaseline), { check: "course-quiz-save-history-changed" });
}

async function runOwnedFreeEnrollmentWitness({ course, job, dependencies, input, create, settle, courseSource, community }) {
  const seed = async (name, changes = {}, actorId = randomUUID()) => {
    const fixture = input(`free-enrollment-${name}`, { status: "published", accessMode: "free", priceCents: 0, ...changes });
    await create(fixture);
    const courseId = fixture.courseId, lessonId = randomUUID(), moduleId = randomUUID();
    await course.query("INSERT INTO public.users(id) VALUES($1) ON CONFLICT DO NOTHING", [actorId]);
    await course.query("INSERT INTO public.modules(id,course_id,slug,title,position) VALUES($1,$2,'module','Module',1)", [moduleId, courseId]);
    await course.query("INSERT INTO public.lessons(id,module_id,slug,title,position) VALUES($1,$2,'lesson','Lesson',1)", [lessonId, moduleId]);
    return { selection: { actorId, courseId, slug: fixture.draft.slug, idempotencyKey: randomUUID() }, lessonId,
      grantId: randomUUID(), enrollmentId: randomUUID(), streamId: randomUUID(), eventId: randomUUID() };
  };
  const capture = ({ selection }) => captureP2InteractiveFreeEnrollmentBaseline(job, selection, dependencies);
  const browser = ({ selection, grantId, enrollmentId }) => ({ courseId: selection.courseId, grantId, enrollmentId,
    source: "free", status: "active", idempotentReplay: false });
  const observe = (test, baseline, receipt = browser(test)) =>
    observeP2InteractiveFreeEnrollmentCase(job, test.selection, baseline, receipt, dependencies);
  const requestHash = ({ actorId, courseId }) => hash(JSON.stringify({ command: "free_grant", userId: actorId, courseId }));
  const progress = (test, enrollmentId = null) =>
    course.query("INSERT INTO public.lesson_progress(user_id,lesson_id,enrollment_id) VALUES($1,$2,$3)",
      [test.selection.actorId, test.lessonId, enrollmentId]);
  const grant = async ({ selection, grantId, enrollmentId }, at, digest, expiresAt) => {
    await course.query("INSERT INTO public.entitlement_idempotency_keys(idempotency_key,command_type,request_hash) VALUES($1,'free_grant',$2)",
      [selection.idempotencyKey, digest]);
    await course.query(`INSERT INTO public.entitlement_grants(id,user_id,course_id,enrollment_id,idempotency_key,request_hash,grant_reason,granted_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'free',$7,$8)`,
    [grantId, selection.actorId, selection.courseId, enrollmentId, selection.idempotencyKey, digest, at, expiresAt]);
  };
  const write = async (test, { expiresAt = null, digest = requestHash(test.selection), outbox = "exact" } = {}) => {
    const { selection, enrollmentId, streamId, eventId } = test, { actorId, courseId } = selection;
    const at = new Date().toISOString();
    const body = JSON.stringify({
      data: { courseId, effectiveAt: at, state: "active", userId: outbox === "foreign-user" ? randomUUID() : actorId },
      eventId, eventType: "enrollment.activated", occurredAt: at, producer: "lash-her-course-api", schemaVersion: 1,
      stream: { id: streamId, version: 1 },
    });
    await course.query("BEGIN");
    try {
      await course.query("INSERT INTO public.enrollments(id,user_id,course_id,status,source,granted_at) VALUES($1,$2,$3,'active','free',$4)",
        [enrollmentId, actorId, courseId, at]);
      await grant(test, at, digest, expiresAt);
      await course.query("INSERT INTO public.community_enrollment_streams(id,user_id,course_id,version,state,effective_at) VALUES($1,$2,$3,1,'active',$4)",
        [streamId, actorId, courseId, at]);
      if (outbox !== "missing") {
        await course.query(`INSERT INTO public.community_enrollment_outbox(event_id,stream_id,stream_version,canonical_body,canonical_digest,available_at,created_at,updated_at)
          VALUES($1,$2,1,$3,$4,$5,$5,$5)`,
        [eventId, streamId, outbox === "noncanonical" ? ` ${body}` : body, hash(body), at]);
      }
      await course.query("COMMIT");
    } catch (error) {
      await course.query("ROLLBACK");
      throw error;
    }
    return at;
  };

  for (const [name, changes] of [["draft", { status: "draft" }], ["paid", { accessMode: "paid", priceCents: 100 }], ["usd", { currency: "USD" }]]) {
    await assert.rejects(capture(await seed(name, changes)), { check: "course-free-enrollment-eligibility" });
  }
  const test = await seed("first"), otherCourse = await seed("other-progress", {}, test.selection.actorId);
  await progress(otherCourse);
  const before = await capture(test);
  assert.equal(JSON.stringify(before), "{}");
  await write(test);
  await assert.rejects(observe(test, {}), { check: "course-free-enrollment-receipt" });
  await assert.rejects(observe(test, before, { ...browser(test), idempotentReplay: true }), { check: "course-free-enrollment-receipt" });
  await assert.rejects(observeP2InteractiveFreeEnrollmentCase(job, test.selection, before, browser(test),
    { ...dependencies, verifySession: async () => {} }), { check: "course-free-enrollment-receipt" });
  const [evidence, delivery] = await Promise.all([observe(test, before), wait(350).then(() => settle(test, 1))]);
  assert.deepEqual(evidence, { ...browser(test), transitionId: test.eventId, communityDelivery: activeEnrollmentDelivery(test, delivery), readOnly: true });
  await assert.rejects(observe(test, before), { check: "course-free-enrollment-receipt" });
  await assert.rejects(capture(test), { check: "course-free-enrollment-baseline" });
  const otherKey = await seed("other-key");
  await assert.rejects(capture({ ...otherKey, selection: { ...otherKey.selection, idempotencyKey: test.selection.idempotencyKey } }),
    { check: "course-free-enrollment-baseline" });
  const priorProgress = await seed("prior-progress");
  await progress(priorProgress);
  await assert.rejects(capture(priorProgress), { check: "course-free-enrollment-progress" });

  for (const [name, options, check] of [
    ["expires", { expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, "course-free-enrollment-persistence"],
    ["wrong-digest", { digest: hash("foreign request") }, "course-free-enrollment-persistence"],
    ["missing-outbox", { outbox: "missing" }, "course-free-enrollment-outbox"],
    ["foreign-outbox", { outbox: "foreign-user" }, "course-free-enrollment-outbox"],
    ["noncanonical-outbox", { outbox: "noncanonical" }, "course-free-enrollment-outbox"],
    ["dead-letter-outbox", {}, "course-free-enrollment-outbox"],
    ["missing-inbox", {}, "community-free-enrollment-inbox"],
    ["mutated-progress", {}, "course-free-enrollment-progress"],
    ["extra-grant", {}, "course-free-enrollment-persistence"],
    ["receipt-grant", {}, "course-free-enrollment-persistence"],
  ]) {
    const selected = await seed(name), baseline = await capture(selected), at = await write(selected, options);
    if (name === "mutated-progress") await progress(selected, selected.enrollmentId);
    if (name === "dead-letter-outbox") await course.query(`UPDATE public.community_enrollment_outbox SET state='dead_letter',
      dead_lettered_at=pg_catalog.clock_timestamp() WHERE event_id=$1::uuid`, [selected.eventId]);
    if (name === "missing-inbox") await settle(selected, 1, false);
    if (name === "extra-grant") {
      const duplicate = { ...selected, grantId: randomUUID(), selection: { ...selected.selection, idempotencyKey: randomUUID() } };
      await course.query("BEGIN");
      try { await grant(duplicate, at, requestHash(duplicate.selection), null); await course.query("COMMIT"); }
      catch (error) { await course.query("ROLLBACK"); throw error; }
    }
    const receipt = name === "receipt-grant" ? { ...browser(selected), grantId: randomUUID() } : browser(selected);
    await assert.rejects(observe(selected, baseline, receipt), { check });
    await assert.rejects(observe(selected, baseline), { check: "course-free-enrollment-receipt" });
  }

  const { db, importSource } = await ownedCourseRepository(course, courseSource);
  const [{ createDrizzleFreeEnrollmentRepository }] = await importOwnedAccountAwareCourseSource(importSource,
    "src/entitlements/free-enrollment.repository.ts");
  const repository = createDrizzleFreeEnrollmentRepository(db);
  const replayFixture = (fixture, proof) => ({ ...fixture, selection: { ...fixture.selection, prior: {
    grantId: fixture.grantId, enrollmentId: fixture.enrollmentId, eventId: fixture.eventId, streamId: fixture.streamId, canonicalDigest: proof.canonicalDigest,
  } } });
  const replay = async ({ selection: { actorId: userId, courseId, idempotencyKey } }) => {
    const { record, isReplay } = await repository.enrollFree({ userId, courseId, idempotencyKey });
    assert.equal(isReplay, true);
    return { courseId, grantId: record.id, enrollmentId: record.enrollmentId, source: "free", status: record.status, idempotentReplay: isReplay };
  };
  await progress(test, test.enrollmentId);
  const original = replayFixture(test, delivery), { selection: reviewed } = original, { prior } = reviewed;
  for (const [change, check] of [[{ canonicalDigest: "0".repeat(64) }, "course-free-enrollment-selection"],
    [{ canonicalDigest: hash("wrong event") }, "course-free-enrollment-prior"], [{ streamId: randomUUID() }, "course-free-enrollment-prior"],
    [{ eventId: randomUUID() }, "course-free-enrollment-prior"], [{ enrollmentId: randomUUID() }, "course-free-enrollment-prior"],
    [{ grantId: randomUUID() }, "course-free-enrollment-persistence"]]) {
    await assert.rejects(capture({ ...original, selection: { ...reviewed, prior: { ...prior, ...change } } }), { check });
  }
  await assert.rejects(capture({ ...original, selection: { ...reviewed, idempotencyKey: randomUUID() } }), { check: "course-free-enrollment-persistence" });
  await assert.rejects(repository.enrollFree({ userId: reviewed.actorId, courseId: otherCourse.selection.courseId,
    idempotencyKey: reviewed.idempotencyKey }), { name: "EntitlementConflictError" });
  const replayBaseline = await capture(original), replayReceipt = await replay(original);
  assert.equal(JSON.stringify(replayBaseline), "{}");
  assert.deepEqual(replayReceipt, { ...browser(test), idempotentReplay: true });
  await assert.rejects(observe(original, replayBaseline, browser(test)), { check: "course-free-enrollment-receipt" });
  await assert.rejects(observe(original, replayBaseline, { ...replayReceipt, enrollmentId: randomUUID() }), { check: "course-free-enrollment-receipt" });
  await assert.rejects(observe({ ...original, selection: { ...reviewed, prior: { ...prior, eventId: randomUUID() } } }, replayBaseline, replayReceipt),
    { check: "course-free-enrollment-receipt" });
  assert.deepEqual(await observe(original, replayBaseline, replayReceipt), { ...replayReceipt, transitionId: test.eventId,
    communityDelivery: activeEnrollmentDelivery(test, delivery), readOnly: true });
  await assert.rejects(observe(original, replayBaseline, replayReceipt), { check: "course-free-enrollment-receipt" });

  for (const [name, check] of [["pending", "course-free-enrollment-prior"], ["missing-inbox", "community-free-enrollment-inbox"],
    ["progress", "course-free-enrollment-history"], ["enrollment", "course-free-enrollment-history"],
    ["outbox", "course-free-enrollment-history"], ["projection", "community-free-enrollment-projection"], ["extra-inbox", "community-free-enrollment-inbox"]]) {
    const fixture = await seed(`replay-${name}`);
    const at = await write(fixture);
    const proof = name === "pending" ? { canonicalDigest: (await course.query(
      "SELECT canonical_digest FROM public.community_enrollment_outbox WHERE event_id=$1::uuid", [fixture.eventId])).rows[0].canonical_digest }
      : await settle(fixture, 1, name !== "missing-inbox");
    const candidate = replayFixture(fixture, proof);
    if (name === "pending" || name === "missing-inbox") {
      await assert.rejects(capture(candidate), { check });
      continue;
    }
    const baseline = await capture(candidate), receipt = await replay(candidate);
    if (name === "progress") await progress(fixture, fixture.enrollmentId);
    if (name === "enrollment") await course.query("UPDATE public.enrollments SET updated_at=pg_catalog.clock_timestamp() WHERE id=$1::uuid", [fixture.enrollmentId]);
    if (name === "outbox") await course.query("UPDATE public.community_enrollment_outbox SET updated_at=pg_catalog.clock_timestamp() WHERE event_id=$1::uuid", [fixture.eventId]);
    if (name === "projection") await community.query("UPDATE public.course_enrollment_projections SET updated_at=pg_catalog.clock_timestamp() WHERE stream_id=$1::uuid", [fixture.streamId]);
    if (name === "extra-inbox") {
      const { actorId: userId, courseId } = fixture.selection, eventId = randomUUID();
      const body = JSON.stringify({ data: { courseId, effectiveAt: at, state: "revoked", userId }, eventId,
        eventType: "enrollment.revoked", occurredAt: at, producer: "lash-her-course-api", schemaVersion: 1, stream: { id: fixture.streamId, version: 2 } });
      await community.query(`INSERT INTO public.course_enrollment_inbox(event_id,canonical_digest,canonical_body,event_type,schema_version,
        producer,occurred_at,stream_id,stream_version,user_id,course_id,state,status,effective_at,quarantine_code)
        VALUES($1,$2,$3,'enrollment.revoked',1,'lash-her-course-api',$4,$5,2,$6,$7,'revoked','quarantined',$4,'owned-fixture')`,
      [eventId, hash(body), body, at, fixture.streamId, userId, courseId]);
    }
    await assert.rejects(observe(candidate, baseline, receipt), { check });
  }
}

function ownedPaidGrantFixtures({ course, input, create }) {
  const seed = async (name, changes = {}, userId = randomUUID()) => {
    const fixture = input(`paid-grant-${name}`, { status: "published", ...changes });
    const { courseId, draft: { slug } } = fixture, moduleId = randomUUID(), lessonId = randomUUID();
    await create(fixture);
    await course.query("INSERT INTO public.users(id) VALUES($1) ON CONFLICT DO NOTHING", [userId]);
    await course.query("INSERT INTO public.modules(id,course_id,slug,title,position) VALUES($1,$2,'module','Module',1)", [moduleId, courseId]);
    await course.query("INSERT INTO public.lessons(id,module_id,slug,title,position) VALUES($1,$2,'lesson','Lesson',1)", [lessonId, moduleId]);
    return { selection: { actorId: randomUUID(), courseId, userId, revision: 1, idempotencyKey: randomUUID(), reason: "Reviewed paid access é" },
      slug, lessonId, commandId: randomUUID(), grantId: randomUUID(), enrollmentId: randomUUID(), streamId: randomUUID(), eventId: randomUUID() };
  };
  const progress = (test, enrollmentId = null) =>
    course.query("INSERT INTO public.lesson_progress(user_id,lesson_id,enrollment_id) VALUES($1,$2,$3)",
      [test.selection.userId, test.lessonId, enrollmentId]);
  const write = async (test, { wrongActor = false, wrongReason = false, wrongHash = false } = {}) => {
    const { selection, commandId, grantId, enrollmentId, streamId, eventId } = test;
    const { actorId, courseId, userId, revision } = selection;
    const at = new Date().toISOString(), key = `owner-paid:${selection.idempotencyKey}`;
    const reason = `[paid-course revision ${revision}] ${selection.reason}`;
    const digest = wrongHash ? hash("foreign paid grant")
      : hash(JSON.stringify({ action: "grant", actorUserId: actorId, reason, scope: "userCourse", target: { courseId, userId } }));
    const body = JSON.stringify({ data: { courseId, effectiveAt: at, state: "active", userId }, eventId,
      eventType: "enrollment.activated", occurredAt: at, producer: "lash-her-course-api", schemaVersion: 1, stream: { id: streamId, version: 1 } });
    await course.query("BEGIN");
    try {
      await course.query("INSERT INTO public.enrollments(id,user_id,course_id,status,source,granted_at) VALUES($1,$2,$3,'active','admin',$4)",
        [enrollmentId, userId, courseId, at]);
      await course.query("INSERT INTO public.entitlement_idempotency_keys(idempotency_key,command_type,request_hash) VALUES($1,'admin_grant',$2)", [key, digest]);
      await course.query(`INSERT INTO public.entitlement_grants(id,user_id,course_id,enrollment_id,idempotency_key,request_hash,grant_reason,granted_at)
        VALUES($1,$2,$3,$4,$5,$6,'manual',$7)`, [grantId, userId, courseId, enrollmentId, key, digest, at]);
      await course.query(`INSERT INTO public.admin_entitlement_commands(id,action,scope,actor_user_id,target_user_id,target_course_id,
        reason,idempotency_key,request_hash,outcome,effect_count,effective_at) VALUES($1,'grant','userCourse',$2,$3,$4,$5,$6,$7,'applied',1,$8)`,
      [commandId, wrongActor ? randomUUID() : actorId, userId, courseId, wrongReason ? "Unreviewed reason" : reason, key, digest, at]);
      await course.query(`INSERT INTO public.admin_entitlement_command_effects(command_id,entitlement_grant_id,effect_type,previous_status,resulting_status)
        VALUES($1,$2,'grant_created',NULL,'active')`, [commandId, grantId]);
      await course.query("INSERT INTO public.community_enrollment_streams(id,user_id,course_id,version,state,effective_at) VALUES($1,$2,$3,1,'active',$4)",
        [streamId, userId, courseId, at]);
      await course.query(`INSERT INTO public.community_enrollment_outbox(event_id,stream_id,stream_version,canonical_body,canonical_digest,available_at,created_at,updated_at)
        VALUES($1,$2,1,$3,$4,$5,$5,$5)`, [eventId, streamId, body, hash(body), at]);
      await course.query("COMMIT");
    } catch (error) {
      await course.query("ROLLBACK");
      throw error;
    }
  };
  return { seed, progress, write };
}

const activeEnrollmentDelivery = ({ streamId }, delivery) => ({ streamId, streamVersion: 1, ...delivery, state: "active" });

async function runOwnedPaidGrantWitness({ course, job, dependencies, input, create, courseSource, community, settle }) {
  const { seed, progress, write } = ownedPaidGrantFixtures({ course, input, create });
  const capture = ({ selection }) => captureP2InteractivePaidGrantBaseline(job, selection, dependencies);
  const browser = ({ selection, commandId, grantId }) => ({ courseId: selection.courseId, userId: selection.userId, commandId, grantId,
    courseRevision: selection.revision });
  const observe = (test, baseline, receipt = browser(test)) =>
    observeP2InteractivePaidGrantCase(job, test.selection, baseline, receipt, dependencies);

  for (const [name, changes] of [["draft", { status: "draft" }], ["free", { accessMode: "free", priceCents: 0 }], ["usd", { currency: "USD" }]]) {
    await assert.rejects(capture(await seed(name, changes)), { check: "course-paid-grant-eligibility" });
  }
  const test = await seed("first");
  await assert.rejects(capture({ ...test, selection: { ...test.selection, revision: 2 } }), { check: "course-paid-grant-eligibility" });
  await assert.rejects(capture({ ...test, selection: { ...test.selection, reason: ` ${test.selection.reason}` } }), { check: "course-paid-grant-selection" });
  const before = await capture(test);
  assert.equal(JSON.stringify(before), "{}");
  await write(test);
  await assert.rejects(observe(test, {}), { check: "course-paid-grant-receipt" });
  await assert.rejects(observe(test, before, { ...browser(test), userId: randomUUID() }), { check: "course-paid-grant-receipt" });
  await assert.rejects(observeP2InteractivePaidGrantCase(job, { ...test.selection, reason: "Other review" }, before, browser(test), dependencies),
    { check: "course-paid-grant-receipt" });
  await assert.rejects(observeP2InteractivePaidGrantCase(job, test.selection, before, browser(test), { ...dependencies, verifySession: async () => {} }),
    { check: "course-paid-grant-receipt" });
  await course.query(`UPDATE public.community_enrollment_outbox SET lease_owner='owned-worker',
    lease_expires_at=pg_catalog.clock_timestamp()+interval '1 minute' WHERE event_id=$1::uuid`, [test.eventId]);
  const [evidence, delivery] = await Promise.all([observe(test, before), wait(350).then(() => settle(test, 1))]);
  assert.deepEqual(evidence, { ...browser(test), enrollmentId: test.enrollmentId, transitionId: test.eventId,
    communityDelivery: activeEnrollmentDelivery(test, delivery), readOnly: true });
  await assert.rejects(observe(test, before), { check: "course-paid-grant-receipt" });
  await assert.rejects(capture(test), { check: "course-paid-grant-baseline" });
  const otherKey = await seed("other-key");
  await assert.rejects(capture({ ...otherKey, selection: { ...otherKey.selection, idempotencyKey: test.selection.idempotencyKey } }),
    { check: "course-paid-grant-baseline" });
  const priorProgress = await seed("prior-progress");
  await progress(priorProgress);
  await assert.rejects(capture(priorProgress), { check: "course-paid-grant-progress" });

  for (const [name, changes, check] of [["actor", { wrongActor: true }, "command"], ["reason", { wrongReason: true }, "command"],
    ["hash", { wrongHash: true }, "persistence"], ["receipt", {}, "command"],
    ["revision", {}, "eligibility"], ["progress", {}, "progress"], ["dead-letter", {}, "outbox"]]) {
    const selected = await seed(name), baseline = await capture(selected);
    await write(selected, changes);
    if (name === "revision") await course.query("UPDATE public.courses SET revision=revision+1 WHERE id=$1::uuid", [selected.selection.courseId]);
    if (name === "progress") await progress(selected, selected.enrollmentId);
    if (name === "dead-letter") await course.query(`UPDATE public.community_enrollment_outbox SET state='dead_letter',
      dead_lettered_at=pg_catalog.clock_timestamp() WHERE event_id=$1::uuid`, [selected.eventId]);
    const receipt = name === "receipt" ? { ...browser(selected), commandId: randomUUID() } : browser(selected);
    await assert.rejects(observe(selected, baseline, receipt), { check: `course-paid-grant-${check}` });
    await assert.rejects(observe(selected, baseline), { check: "course-paid-grant-receipt" });
  }

  const { db, importSource } = await ownedCourseRepository(course, courseSource);
  const [{ createDrizzleAdminEntitlementCommandRepository }] = await importOwnedAccountAwareCourseSource(importSource,
    "src/entitlements/admin-entitlement-command.repository.ts");
  const admin = createDrizzleAdminEntitlementCommandRepository(db);
  const prepareSecond = async (name, settleFirst = true) => {
    const prior = await seed(`second-${name}`);
    await write(prior);
    await progress(prior, prior.enrollmentId);
    const delivery = settleFirst ? await settle(prior, 1) : undefined;
    return { ...prior, delivery, selection: { ...prior.selection, idempotencyKey: randomUUID(), priorGrantId: prior.grantId } };
  };
  const grantAgain = async ({ selection }) => {
    const result = await admin.grant({ courseId: selection.courseId, userId: selection.userId, actorUserId: selection.actorId,
      idempotencyKey: `owner-paid:${selection.idempotencyKey}`, reason: `[paid-course revision ${selection.revision}] ${selection.reason}` });
    assert.equal(result.isReplay, false);
    assert.equal(result.effects.length, 1);
    return { commandId: result.command.id, grantId: result.effects[0].entitlementGrantId };
  };
  const second = await prepareSecond("unchanged");
  await assert.rejects(capture({ ...second, selection: { ...second.selection, priorGrantId: randomUUID() } }), { check: "course-paid-grant-prior" });
  await assert.rejects(capture(await prepareSecond("pending", false)), { check: "course-paid-grant-delivery-baseline" });
  const secondBaseline = await capture(second);
  const secondReceipt = { ...browser(second), ...await grantAgain(second) };
  await assert.rejects(observe(second, secondBaseline, { ...secondReceipt, priorGrantId: second.grantId }), { check: "course-paid-grant-receipt" });
  assert.deepEqual(await observe(second, secondBaseline, secondReceipt), { ...secondReceipt, enrollmentId: second.enrollmentId,
    priorGrantId: second.grantId, transitionId: null, communityDelivery: activeEnrollmentDelivery(second, second.delivery), readOnly: true });

  for (const [name, check] of [["third-grant", "course-paid-grant-persistence"], ["progress-drift", "course-paid-grant-history"],
    ["receiver-drift", "community-paid-grant-projection"], ["outbox-drift", "course-paid-grant-history"]]) {
    const candidate = await prepareSecond(name), baseline = await capture(candidate), receipt = { ...browser(candidate), ...await grantAgain(candidate) };
    if (name === "third-grant") await grantAgain({ selection: { ...candidate.selection, idempotencyKey: randomUUID() } });
    if (name === "progress-drift") await course.query("UPDATE public.lesson_progress SET resume_position_seconds=3 WHERE lesson_id=$1::uuid", [candidate.lessonId]);
    if (name === "receiver-drift") await community.query("UPDATE public.course_enrollment_projections SET updated_at=pg_catalog.clock_timestamp() WHERE stream_id=$1::uuid", [candidate.streamId]);
    if (name === "outbox-drift") await course.query("UPDATE public.community_enrollment_outbox SET updated_at=pg_catalog.clock_timestamp() WHERE event_id=$1::uuid", [candidate.eventId]);
    await assert.rejects(observe(candidate, baseline, receipt), { check });
  }
}

async function ownedCourseRepository(course, courseSource) {
  const { tsImport } = createRequire(import.meta.url)("tsx/esm/api");
  const importSource = relative => tsImport(pathToFileURL(join(courseSource, relative)).href, import.meta.url);
  const { createDrizzleCourseRepository } = await importSource("src/courses/course.repository.ts");
  const { drizzle } = createRequire(join(courseSource, "package.json"))("drizzle-orm/node-postgres");
  const db = drizzle(course);
  return { repository: createDrizzleCourseRepository(db), db, importSource };
}

async function importOwnedAccountAwareCourseSource(importSource, ...paths) {
  const priorDotenv = process.env.DOTENV_CONFIG_PATH, priorAdmission = process.env.COURSE_ACCOUNT_LIFECYCLE_ENABLED;
  try {
    process.env.DOTENV_CONFIG_PATH = "/dev/null";
    process.env.COURSE_ACCOUNT_LIFECYCLE_ENABLED = "true";
    return await Promise.all(paths.map(importSource));
  } finally {
    if (priorDotenv === undefined) delete process.env.DOTENV_CONFIG_PATH;
    else process.env.DOTENV_CONFIG_PATH = priorDotenv;
    if (priorAdmission === undefined) delete process.env.COURSE_ACCOUNT_LIFECYCLE_ENABLED;
    else process.env.COURSE_ACCOUNT_LIFECYCLE_ENABLED = priorAdmission;
  }
}

async function runOwnedPaidArchiveWitness({ course, job, dependencies, input, create, courseSource }) {
  const { seed, progress, write } = ownedPaidGrantFixtures({ course, input, create });
  const { repository } = await ownedCourseRepository(course, courseSource);
  const selection = test => ({ courseId: test.selection.courseId, slug: test.slug, revision: 1, userId: test.selection.userId, grantId: test.grantId });
  const browser = test => ({ courseId: test.selection.courseId, slug: test.slug, revision: 2, status: "archived" });
  const capture = test => captureP2InteractivePaidArchiveBaseline(job, selection(test), undefined, dependencies);
  const observe = (test, baseline, receipt = browser(test)) =>
    observeP2InteractivePaidArchiveCase(job, selection(test), baseline, receipt, dependencies);
  const archive = async test => {
    const row = await repository.updateCourse(test.selection.courseId, { expectedRevision: 1, status: "archived" });
    assert.deepEqual({ courseId: row.id, slug: row.slug, revision: row.revision, status: row.status }, browser(test));
    assert.equal(await repository.findPublishedCourseBySlug(test.slug), null);
  };
  const prepared = async (name, changes) => {
    const test = await seed(`archive-${name}`, changes);
    await write(test);
    return test;
  };
  const attempts = async test => {
    const revisionId = randomUUID(), attemptId = randomUUID();
    await course.query("INSERT INTO public.quiz_revisions(id,lesson_id,revision,document,created_by) VALUES($1,$2,1,$3::jsonb,$4)",
      [revisionId, test.lessonId, { version: 1, mode: "graded", questions: [] }, test.selection.actorId]);
    await course.query(`INSERT INTO public.quiz_attempts(id,user_id,lesson_id,quiz_revision_id,enrollment_id,request_id,request_hash,answers,
      correct_count,total_count,passed,completed) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,1,1,true,true)`,
    [attemptId, test.selection.userId, test.lessonId, revisionId, test.enrollmentId, randomUUID(), hash("owned-archive-attempt"),
      JSON.stringify([{ questionId: "quiz-question", optionId: "private-choice" }])]);
    return attemptId;
  };
  const purchase = async test => {
    const userId = randomUUID(), enrollmentId = randomUUID(), key = randomUUID(), digest = hash(`owned-history-${key}`);
    await course.query("BEGIN");
    try {
      await course.query("INSERT INTO public.users(id) VALUES($1)", [userId]);
      await course.query("INSERT INTO public.enrollments(id,user_id,course_id,status,source) VALUES($1,$2,$3,'active','purchase')",
        [enrollmentId, userId, test.selection.courseId]);
      await course.query("INSERT INTO public.entitlement_idempotency_keys(idempotency_key,command_type,request_hash) VALUES($1,'internal_grant',$2)", [key, digest]);
      await course.query(`INSERT INTO public.entitlement_grants(user_id,course_id,enrollment_id,idempotency_key,request_hash,grant_reason,
        external_order_id,external_payment_id,provider) VALUES($1,$2,$3,$4,$5,'purchase','owned-order-reference','owned-payment-reference','square')`,
      [userId, test.selection.courseId, enrollmentId, key, digest]);
      await course.query("COMMIT");
    } catch (error) {
      await course.query("ROLLBACK");
      throw error;
    }
    return enrollmentId;
  };

  const test = await prepared("first");
  await write(await seed("archive-first-independent", {}, test.selection.userId));
  await progress(test, test.enrollmentId);
  await attempts(test);
  await purchase(test);
  const selected = selection(test);
  assert.equal(validateP2InteractivePaidArchive(selected, undefined), undefined);
  for (const [changed, body] of [[selected, {}], [{ ...selected, extra: true }, undefined], [{ ...selected, revision: 2_147_483_647 }, undefined]]) {
    assert.throws(() => validateP2InteractivePaidArchive(changed, body), { check: "course-paid-archive-selection" });
  }
  await assert.rejects(captureP2InteractivePaidArchiveBaseline(job, { ...selected, grantId: randomUUID() }, undefined, dependencies),
    { check: "course-paid-archive-grant" });
  await assert.rejects(captureP2InteractivePaidArchiveBaseline(job, { ...selected, revision: 2 }, undefined, dependencies),
    { check: "course-publication-state" });
  const before = await capture(test);
  assert.equal(JSON.stringify(before), "{}");
  await archive(test);
  await course.query(`UPDATE public.community_enrollment_outbox SET state='delivered',delivered_at=pg_catalog.clock_timestamp(),
    updated_at=pg_catalog.clock_timestamp() WHERE event_id=$1::uuid`, [test.eventId]);
  await assert.rejects(observe(test, {}, browser(test)), { check: "course-paid-archive-receipt" });
  await assert.rejects(observe(test, before, { ...browser(test), status: "published" }), { check: "course-paid-archive-receipt" });
  await assert.rejects(observeP2InteractivePaidArchiveCase(job, selected, before, browser(test), { ...dependencies, verifySession: async () => {} }),
    { check: "course-paid-archive-receipt" });
  assert.deepEqual(await observe(test, before), { ...browser(test), userId: selected.userId, grantId: selected.grantId, historyPreserved: true, readOnly: true });
  await assert.rejects(observe(test, before), { check: "course-paid-archive-receipt" });
  await assert.rejects(capture(test), { check: "course-publication-state" });

  const free = await prepared("free", { accessMode: "free", priceCents: 0 });
  await assert.rejects(capture(free), { check: "course-paid-archive-eligibility" });
  const suspended = await prepared("suspended");
  await course.query(`INSERT INTO public.account_lifecycle_states(user_id,account_version,status,updated_at)
    VALUES($1,1,'suspended',pg_catalog.clock_timestamp())`, [suspended.selection.userId]);
  await assert.rejects(capture(suspended), { check: "course-paid-archive-access" });
  const large = await prepared("large");
  await course.query(`INSERT INTO public.modules(course_id,slug,title,position) SELECT $1,'extra-'||n,'Extra module',n
    FROM pg_catalog.generate_series(2,1001) n`, [large.selection.courseId]);
  await assert.rejects(capture(large), { check: "course-paid-archive-history-limit" });

  for (const [name, check] of [["revision", "course-publication-state"], ["metadata", "course-paid-archive-history"],
    ["lesson", "course-paid-archive-history"], ["attempt", "course-paid-archive-history"], ["progress", "course-paid-archive-history"],
    ["refund", "course-paid-archive-history"], ["stream", "course-paid-archive-community-authority"],
    ["independent", "course-paid-archive-community-authority"]]) {
    const changed = await prepared(name), courseId = changed.selection.courseId;
    const attemptId = name === "attempt" ? await attempts(changed) : undefined;
    const purchaseEnrollment = name === "refund" ? await purchase(changed) : undefined;
    const independent = name === "independent" ? await seed("archive-other-eligibility", {}, changed.selection.userId) : undefined;
    if (independent) await write(independent);
    const baseline = await capture(changed);
    await archive(changed);
    if (name === "revision") await course.query("UPDATE public.courses SET revision=revision+1 WHERE id=$1::uuid", [courseId]);
    if (name === "metadata") await course.query("UPDATE public.courses SET description=NULL WHERE id=$1::uuid", [courseId]);
    if (name === "lesson") await course.query("UPDATE public.lessons SET title='Wrong title' WHERE id=$1::uuid", [changed.lessonId]);
    if (name === "attempt") await course.query(`UPDATE public.quiz_attempts SET user_id=NULL,enrollment_id=NULL,request_id=NULL,request_hash=NULL,
      answers='[]'::jsonb,deidentified_at=pg_catalog.clock_timestamp() WHERE id=$1::uuid`, [attemptId]);
    if (name === "progress") await progress(changed, changed.enrollmentId);
    if (name === "refund") await course.query("UPDATE public.enrollments SET status='refunded',refunded_at=pg_catalog.clock_timestamp() WHERE id=$1::uuid", [purchaseEnrollment]);
    if (name === "stream") await course.query("UPDATE public.community_enrollment_streams SET version=2,state='revoked' WHERE id=$1::uuid", [changed.streamId]);
    if (independent) await archive(independent);
    await assert.rejects(observe(changed, baseline), { check });
    await assert.rejects(observe(changed, baseline), { check: "course-paid-archive-receipt" });
  }
}

async function runOwnedPaidRepublishWitness({ course, job, dependencies, input, create, courseSource }) {
  const { seed, progress, write } = ownedPaidGrantFixtures({ course, input, create });
  const { repository, db, importSource } = await ownedCourseRepository(course, courseSource);
  const { plainTextDocument } = await importSource("src/courses/content.ts");
  const [{ createDrizzleAdminEntitlementCommandRepository }] = await importOwnedAccountAwareCourseSource(importSource,
    "src/entitlements/admin-entitlement-command.repository.ts");
  const entitlementCommands = createDrizzleAdminEntitlementCommandRepository(db);
  const state = async (test, expectedRevision, status) => {
    const row = await repository.updateCourse(test.selection.courseId, { expectedRevision, status });
    assert.equal(row.revision, expectedRevision + 1);
    assert.equal(row.status, status);
  };
  const restricted = test => course.query(`INSERT INTO public.account_lifecycle_states(user_id,account_version,status,updated_at)
    VALUES($1,1,'suspended',pg_catalog.clock_timestamp())`, [test.selection.userId]);
  const revoked = async test => {
    const result = await entitlementCommands.revoke({ scope: "grantId", grantId: test.grantId, actorUserId: test.selection.actorId,
      reason: "Owned fixture withdrawal", idempotencyKey: randomUUID() });
    assert.equal(result.command.outcome, "applied");
  };
  const prepared = async (name, outcome = "published", restriction) => {
    const test = await seed(`republish-${name}`), { courseId, userId } = test.selection;
    if (outcome === "published") await course.query("UPDATE public.lessons SET content_document=$2::jsonb WHERE id=$1::uuid",
      [test.lessonId, plainTextDocument("Reviewed paid lesson", "owned-republish")]);
    await write(test);
    await progress(test, test.enrollmentId);
    await state(test, 1, "archived");
    if (restriction) await restriction(test);
    const issueCodes = outcome === "published" ? [] : ["LESSON_CONTENT_REQUIRED"];
    return { ...test, selected: { courseId, slug: test.slug, revision: 2, userId, grantId: test.grantId, outcome, issueCodes,
      expectedAccess: restriction === undefined } };
  };
  const browser = ({ selected: { courseId, slug, outcome, issueCodes } }) => ({ courseId, slug,
    revision: outcome === "published" ? 4 : 3, status: outcome === "published" ? "published" : "draft", issueCodes });
  const capture = test => captureP2InteractivePaidRepublishBaseline(job, test.selected, undefined, dependencies);
  const observe = (test, baseline, receipt = browser(test)) =>
    observeP2InteractivePaidRepublishCase(job, test.selected, baseline, receipt, dependencies);
  const republish = async test => {
    const { courseId, outcome, issueCodes } = test.selected;
    await state(test, 2, "draft");
    const readiness = await repository.publicationReadiness(courseId);
    assert.equal(readiness.courseRevision, 3);
    assert.deepEqual([...new Set(readiness.issues.map(issue => issue.code))].sort(), issueCodes);
    assert.equal(readiness.ready, outcome === "published");
    if (readiness.ready) await state(test, 3, "published");
    else await assert.rejects(state(test, 3, "published"), { name: "CourseRepositoryConflictError" });
    assert.equal((await repository.findPublishedCourseBySlug(test.slug))?.id, readiness.ready ? courseId : undefined);
  };

  for (const [name, outcome, restriction] of [["allowed", "published"], ["blocked", "blocked"],
    ["suspended", "published", restricted], ["revoked", "published", revoked]]) {
    const test = await prepared(name, outcome, restriction), { selected } = test;
    if (name === "allowed") await write(await seed("republish-independent", {}, selected.userId));
    assert.equal(validateP2InteractivePaidRepublish(selected, undefined), undefined);
    for (const [selection, input] of [[selected, {}], [{ ...selected, revision: 2_147_483_646 }, undefined],
      [{ ...selected, expectedAccess: null }, undefined]]) {
      assert.throws(() => validateP2InteractivePaidRepublish(selection, input), { check: "course-paid-republish-selection" });
    }
    assert.throws(() => validateP2InteractivePaidRepublish({ ...selected, outcome: "blocked", issueCodes: ["Z", "A"] }, undefined),
      { check: "course-paid-republish-issue-codes" });
    await assert.rejects(capture({ ...test, selected: { ...selected, grantId: randomUUID() } }), { check: "course-paid-republish-grant" });
    await assert.rejects(capture({ ...test, selected: { ...selected, expectedAccess: !selected.expectedAccess } }), { check: "course-paid-republish-access" });
    const before = await capture(test);
    assert.equal(JSON.stringify(before), "{}");
    await republish(test);
    await assert.rejects(observe(test, {}, browser(test)), { check: "course-paid-republish-receipt" });
    await assert.rejects(observe(test, before, { ...browser(test), issueCodes: ["UNREVIEWED"] }), { check: "course-paid-republish-receipt" });
    await assert.rejects(observeP2InteractivePaidRepublishCase(job, selected, before, browser(test),
      { ...dependencies, verifySession: async () => {} }), { check: "course-paid-republish-receipt" });
    assert.deepEqual(await observe(test, before), { ...browser(test), userId: selected.userId, grantId: selected.grantId,
      historyPreserved: true, effectiveAccess: outcome === "published" && selected.expectedAccess, readOnly: true });
    await assert.rejects(observe(test, before), { check: "course-paid-republish-receipt" });
    await assert.rejects(capture(test), { check: "course-publication-state" });
  }

  for (const [name, check] of [["revision", "course-publication-state"], ["progress", "course-paid-republish-history"],
    ["restored-account", "course-paid-republish-access"], ["changed-restriction", "course-paid-republish-account-history"],
    ["lost-independent", "course-paid-republish-community-authority"]]) {
    const test = await prepared(name, "published", ["restored-account", "changed-restriction"].includes(name) ? restricted : undefined);
    const independent = name === "lost-independent" ? await seed("republish-lost-other-course", {}, test.selected.userId) : undefined;
    if (independent) await write(independent);
    const baseline = await capture(test);
    await republish(test);
    if (name === "revision") await course.query("UPDATE public.courses SET revision=revision+1 WHERE id=$1::uuid", [test.selected.courseId]);
    if (name === "progress") await course.query("UPDATE public.lesson_progress SET max_position_seconds=17 WHERE lesson_id=$1::uuid", [test.lessonId]);
    if (name === "restored-account" || name === "changed-restriction") await course.query(`UPDATE public.account_lifecycle_states
      SET status=$2,account_version=account_version+1,updated_at=pg_catalog.clock_timestamp() WHERE user_id=$1::uuid`,
    [test.selected.userId, name === "restored-account" ? "active" : "deleted"]);
    if (independent) await state(independent, 1, "archived");
    await assert.rejects(observe(test, baseline), { check });
    await assert.rejects(observe(test, baseline), { check: "course-paid-republish-receipt" });
  }
}

async function runOwnedPaidLearnerAccessWitness({ course, job, dependencies, input, create, courseSource }) {
  const { seed, write } = ownedPaidGrantFixtures({ course, input, create });
  const { repository, db, importSource } = await ownedCourseRepository(course, courseSource);
  const [{ createDrizzleAdminEntitlementCommandRepository }, { createDrizzleQuizRepository }, { createDrizzleVideoRepository }] =
    await importOwnedAccountAwareCourseSource(importSource, "src/entitlements/admin-entitlement-command.repository.ts",
      "src/quizzes/drizzle-quiz.repository.ts", "src/video/video.repository.ts");
  const entitlement = createDrizzleAdminEntitlementCommandRepository(db), quiz = createDrizzleQuizRepository(db), video = createDrizzleVideoRepository(db);
  const quizDocument = { version: 1, mode: "graded", passingPercent: 80, questions: [{ id: "question", prompt: "Which answer matches?",
    options: [{ id: "a", text: "First" }, { id: "b", text: "Second" }], correctOptionId: "b", feedback: "Review the material." }] };
  const prepared = async (name, outcome = "allowed", courseChanges = {}) => {
    const test = await seed(`learner-${name}`, courseChanges), { lessonId, grantId } = test, { courseId, userId, actorId } = test.selection;
    await write(test);
    await course.query("INSERT INTO public.quiz_revisions(lesson_id,revision,document,created_by) VALUES($1,1,$2::jsonb,$3)",
      [lessonId, quizDocument, actorId]);
    const assetId = randomUUID();
    await course.query(`INSERT INTO public.video_assets(id,lesson_id,mux_asset_id,mux_playback_id,status,duration_seconds,
      managed_by_course,provider_environment_id,is_current) VALUES($1,$2,$3,$4,'ready',180,true,'owned-mux',true)`,
    [assetId, lessonId, `owned-asset-${assetId}`, `owned-playback-${assetId}`]);
    const attempt = await quiz.submitAttempt({ userId, lessonId, quizRevision: 1, requestId: randomUUID(), answers: [{ questionId: "question", optionId: "b" }] });
    assert.equal(attempt.passed, true);
    let revision = 1;
    if (outcome === "archived" || outcome === "draft") {
      const row = await repository.updateCourse(courseId, { expectedRevision: 1, status: outcome });
      revision = row.revision;
    }
    if (outcome === "restricted") {
      const result = await entitlement.revoke({ scope: "grantId", grantId, actorUserId: actorId,
        reason: "Owned fixture withdrawal", idempotencyKey: randomUUID() });
      assert.equal(result.command.outcome, "applied");
    }
    return { ...test, assetId, attemptId: attempt.id, selected: { actorId: userId, courseId, lessonId, grantId, revision, outcome } };
  };
  const capture = test => captureP2InteractivePaidLearnerAccessBaseline(job, test.selected, undefined, dependencies);
  const browser = ({ selected: { courseId, lessonId, outcome } }) => ({ courseId, lessonId, outcome });
  const observe = (test, baseline, receipt = browser(test)) => observeP2InteractivePaidLearnerAccessCase(job, test.selected, baseline, receipt, dependencies);
  const access = async ({ selected: { actorId, lessonId, outcome }, assetId }) => {
    const args = { userId: actorId, lessonId }, expiry = new Date(Date.now() + 600_000).toISOString();
    let signed = false;
    const playback = () => video.withPlaybackAuthorization(args, async media => {
      signed = true;
      assert.equal(media.id, assetId);
      return { playbackId: media.muxPlaybackId, token: "owned-fixture-token", expiresAt: expiry };
    });
    if (outcome === "allowed") {
      assert.equal((await quiz.readStudentQuiz(args)).document.mode, "graded");
      assert.equal((await playback()).expiresAt, expiry);
      assert.equal((await course.query("SELECT last_token_expires_at FROM public.video_assets WHERE id=$1::uuid", [assetId])).rows[0]
        .last_token_expires_at.toISOString(), expiry);
    } else {
      const [name, code] = { archived: ["QuizArchivedError", "COURSE_ARCHIVED"], draft: ["QuizNotFoundError", "LESSON_NOT_FOUND"],
        restricted: ["QuizAccessDeniedError", "ACTIVE_ENROLLMENT_REQUIRED"] }[outcome];
      await assert.rejects(quiz.readStudentQuiz(args), { name });
      await assert.rejects(playback(), { code });
    }
    assert.equal(signed, outcome === "allowed");
  };

  for (const outcome of ["allowed", "archived", "draft", "restricted"]) {
    const test = await prepared(outcome, outcome), { selected } = test;
    if (outcome === "allowed") {
      await write(await seed("learner-other-eligible", {}, selected.actorId));
      await course.query(`INSERT INTO public.account_lifecycle_states(user_id,account_version,status,updated_at)
        VALUES($1,1,'active',pg_catalog.clock_timestamp())`, [selected.actorId]);
    }
    assert.equal(validateP2InteractivePaidLearnerAccess(selected, undefined), undefined);
    assert.throws(() => validateP2InteractivePaidLearnerAccess(selected, {}), { check: "course-paid-learner-selection" });
    assert.throws(() => validateP2InteractivePaidLearnerAccess({ ...selected, outcome: "toString" }, undefined), { check: "course-paid-learner-selection" });
    await assert.rejects(capture({ ...test, selected: { ...selected, lessonId: randomUUID() } }), { check: "course-paid-learner-lesson" });
    await assert.rejects(capture({ ...test, selected: { ...selected, grantId: randomUUID() } }), { check: "course-paid-learner-grant" });
    const baseline = await capture(test);
    assert.equal(JSON.stringify(baseline), "{}");
    await access(test);
    await assert.rejects(observe(test, {}, browser(test)), { check: "course-paid-learner-receipt" });
    await assert.rejects(observe(test, baseline, { ...browser(test), outcome: "unreviewed" }), { check: "course-paid-learner-receipt" });
    await assert.rejects(observeP2InteractivePaidLearnerAccessCase(job, selected, baseline, browser(test),
      { ...dependencies, verifySession: async () => {} }), { check: "course-paid-learner-receipt" });
    assert.deepEqual(await observe(test, baseline), { ...browser(test), actorId: selected.actorId, grantId: selected.grantId,
      revision: selected.revision, effectiveAccess: outcome === "allowed", readOnly: true });
    await assert.rejects(observe(test, baseline), { check: "course-paid-learner-receipt" });
  }

  const incompatible = await prepared("incompatible");
  await assert.rejects(capture({ ...incompatible, selected: { ...incompatible.selected, outcome: "restricted" } }), { check: "course-paid-learner-access" });
  const free = await prepared("free", "allowed", { accessMode: "free", priceCents: 0 });
  await assert.rejects(capture(free), { check: "course-paid-learner-eligibility" });
  const quizDrift = await prepared("practice");
  await course.query("INSERT INTO public.quiz_revisions(lesson_id,revision,document,created_by) VALUES($1,2,$2::jsonb,$3)",
    [quizDrift.lessonId, { ...quizDocument, mode: "practice" }, quizDrift.selection.actorId]);
  await assert.rejects(capture(quizDrift), { check: "course-paid-learner-lesson" });

  for (const [name, check] of [["revision", "course-publication-state"], ["preview", "course-paid-learner-lesson"],
    ["asset", "course-paid-learner-state-drift"], ["progress", "course-paid-learner-history"], ["attempt", "course-paid-learner-history"],
    ["unauthorized-token", "course-paid-learner-state-drift"], ["suspension", "course-paid-learner-account"],
    ["independent", "course-paid-learner-community-authority"]]) {
    const test = await prepared(name, name === "unauthorized-token" ? "archived" : "allowed"), { courseId, actorId } = test.selected;
    const independent = name === "independent" ? await seed("learner-drift-other-course", {}, actorId) : undefined;
    if (independent) await write(independent);
    const baseline = await capture(test);
    if (name === "revision") await course.query("UPDATE public.courses SET revision=revision+1 WHERE id=$1::uuid", [courseId]);
    if (name === "preview") await course.query("UPDATE public.lessons SET is_preview=true WHERE id=$1::uuid", [test.lessonId]);
    if (name === "asset") await course.query("UPDATE public.video_assets SET mux_playback_id=$2 WHERE id=$1::uuid", [test.assetId, randomUUID()]);
    if (name === "progress") await course.query("UPDATE public.lesson_progress SET resume_position_seconds=10 WHERE lesson_id=$1::uuid", [test.lessonId]);
    if (name === "attempt") await course.query(`UPDATE public.quiz_attempts SET user_id=NULL,enrollment_id=NULL,request_id=NULL,request_hash=NULL,
      answers='[]'::jsonb,deidentified_at=pg_catalog.clock_timestamp() WHERE id=$1::uuid`, [test.attemptId]);
    if (name === "unauthorized-token") await course.query(`UPDATE public.video_assets
      SET last_token_expires_at=pg_catalog.clock_timestamp()+interval '10 minutes' WHERE id=$1::uuid`, [test.assetId]);
    if (name === "suspension") await course.query(`INSERT INTO public.account_lifecycle_states(user_id,account_version,status,updated_at)
      VALUES($1,1,'suspended',pg_catalog.clock_timestamp())`, [actorId]);
    if (independent) await repository.updateCourse(independent.selection.courseId, { expectedRevision: 1, status: "archived" });
    await assert.rejects(observe(test, baseline), { check });
    await assert.rejects(observe(test, baseline), { check: "course-paid-learner-receipt" });
  }
}

async function runOwnedLessonEntryWitness({ course, job, dependencies, input, create, courseSource }) {
  const { db, importSource } = await ownedCourseRepository(course, courseSource);
  const [{ createDrizzleFreeEnrollmentRepository }, { createDrizzleLessonProgressRepository }, { createDrizzleVideoRepository, createDrizzleEntitlementRepository },
    { createDrizzleQuizRepository }, { createDrizzleAdminEntitlementCommandRepository }] = await importOwnedAccountAwareCourseSource(importSource,
    "src/entitlements/free-enrollment.repository.ts", "src/progress/lesson-progress.repository.ts", "src/video/video.repository.ts",
    "src/quizzes/drizzle-quiz.repository.ts", "src/entitlements/admin-entitlement-command.repository.ts");
  const enrollment = createDrizzleFreeEnrollmentRepository(db), progress = createDrizzleLessonProgressRepository(db);
  const video = createDrizzleVideoRepository(db), quiz = createDrizzleQuizRepository(db);
  const quizDocument = { version: 1, mode: "graded", passingPercent: 80, questions: [{ id: "question", prompt: "Which answer matches?",
    options: [{ id: "a", text: "First" }, { id: "b", text: "Second" }], correctOptionId: "b", feedback: "Review the material." }] };
  const seed = async (name, { priorExpiry = null, preview = false, managed = true, withQuiz = true, withCanaries = false, durationSeconds = 32 } = {}) => {
    const fixture = input(`entry-${name}`, { status: "published", accessMode: "free", priceCents: 0 });
    await create(fixture);
    const { courseId } = fixture, actorId = randomUUID(), lessonId = randomUUID(), moduleId = randomUUID(), assetId = randomUUID();
    const contentDocument = withCanaries ? { version: 1, blocks: [{ _type: "block", _key: "private-block", style: "normal",
      children: [{ _type: "span", _key: "private-span", text: "p2q-s07-private-content", marks: [] }] }] } : null;
    const transcript = withCanaries ? "p2q-s07-private-transcript" : null;
    const quizSeed = withCanaries
      ? { ...quizDocument, questions: quizDocument.questions.map(question => ({ ...question, prompt: "p2q-s07-private-quiz" })) }
      : quizDocument;
    await course.query("INSERT INTO public.modules(id,course_id,slug,title,position) VALUES($1,$2,'module','Module',1)", [moduleId, courseId]);
    await course.query("INSERT INTO public.lessons(id,module_id,slug,title,position,is_preview,content_document,transcript) VALUES($1,$2,'lesson','Lesson',1,$3,$4,$5)",
      [lessonId, moduleId, preview, contentDocument, transcript]);
    if (withQuiz) await course.query("INSERT INTO public.quiz_revisions(lesson_id,revision,document,created_by) VALUES($1,1,$2::jsonb,$3)",
      [lessonId, quizSeed, randomUUID()]);
    await course.query(`INSERT INTO public.video_assets(id,lesson_id,mux_asset_id,mux_playback_id,status,managed_by_course,provider_environment_id,
      is_current,last_token_expires_at,duration_seconds) VALUES($1,$2,$3,$4,'ready',$5,'owned-mux',true,$6,$7)`,
    [assetId, lessonId, `owned-asset-${assetId}`, `owned-playback-${assetId}`, managed, priorExpiry, durationSeconds]);
    const grant = await enrollment.enrollFree({ userId: actorId, courseId, idempotencyKey: randomUUID() });
    assert.equal(grant.isReplay, false);
    return { selection: { actorId, courseId, lessonId, grantId: grant.record.id }, enrollmentId: grant.record.enrollmentId, assetId };
  };
  const begin = ({ selection: { actorId: userId, courseId, lessonId }, enrollmentId }, patch) => progress.recordProgress({
    userId, courseId, lessonId, enrollmentId, expectedProgressRevision: 0, markStarted: true, ...patch,
  });
  const authorize = async (test) => {
    const { selection: { actorId: userId, lessonId }, assetId } = test, at = Date.now();
    const expiresAt = new Date(at + 599_500).toISOString(), thumbnailExpiresAt = new Date(at + 600_000).toISOString();
    await video.withPlaybackAuthorization({ userId, lessonId }, async media => {
      assert.equal(media.id, assetId);
      return { playbackId: media.muxPlaybackId, token: "owned-fixture-token", expiresAt, thumbnailExpiresAt };
    });
    return { requestId: randomUUID(), expiresAt, thumbnailExpiresAt, lifetimeMs: 599_500 };
  };
  const enter = async (test, progressPatch) => {
    const { selection: { courseId, lessonId } } = test;
    const playback = await authorize(test);
    const started = await begin(test, progressPatch);
    return { page: { pathname: `/academy/courses/${courseId}/lessons/${lessonId}`, flight: true },
      playback,
      progress: { requestId: randomUUID(), progressId: started.id, enrollmentId: started.enrollmentId, revision: started.revision } };
  };
  const capture = ({ selection }) => captureP2InteractiveLessonEntryBaseline(job, selection, dependencies);
  const observe = (test, baseline, receipt) => observeP2InteractiveLessonEntryCase(job, test.selection, baseline, receipt, dependencies);

  for (const name of ["first", "prior-longer"]) {
    const priorExpiry = name === "prior-longer" ? new Date(Date.now() + 900_000).toISOString() : null;
    const test = await seed(name, { priorExpiry });
    await assert.rejects(capture({ ...test, selection: { ...test.selection, grantId: randomUUID() } }), { check: "course-lesson-entry-grant" });
    const baseline = await capture(test), receipt = await enter(test);
    assert.equal(JSON.stringify(baseline), "{}");
    await assert.rejects(observe(test, {}, receipt), { check: "course-lesson-entry-receipt" });
    await assert.rejects(observe(test, baseline, { ...receipt, page: { ...receipt.page, flight: false } }), { check: "course-lesson-entry-receipt" });
    await assert.rejects(observe(test, baseline, { ...receipt, playback: { ...receipt.playback, lifetimeMs: 601_000 } }), { check: "course-lesson-entry-receipt" });
    await assert.rejects(observe(test, baseline, { ...receipt, progress: { ...receipt.progress, enrollmentId: randomUUID() } }), { check: "course-lesson-entry-receipt" });
    await assert.rejects(observeP2InteractiveLessonEntryCase(job, test.selection, baseline, receipt,
      { ...dependencies, verifySession: async () => {} }), { check: "course-lesson-entry-receipt" });
    assert.deepEqual(await observe(test, baseline, receipt), { ...test.selection, enrollmentId: test.enrollmentId,
      progressId: receipt.progress.progressId, revision: 1, playbackExpiresAt: receipt.playback.thumbnailExpiresAt, readOnly: true });
    await assert.rejects(observe(test, baseline, receipt), { check: "course-lesson-entry-receipt" });
    await assert.rejects(capture(test), { check: "course-lesson-entry-baseline" });
  }

  for (const [name, options] of [["preview", { preview: true }], ["unmanaged", { managed: false }], ["no-quiz", { withQuiz: false }]]) {
    await assert.rejects(capture(await seed(name, options)), { check: "course-lesson-entry-lesson" });
  }
  const attempted = await seed("prior-attempt");
  await quiz.submitAttempt({ userId: attempted.selection.actorId, lessonId: attempted.selection.lessonId, quizRevision: 1, requestId: randomUUID(),
    answers: [{ questionId: "question", optionId: "b" }] });
  await assert.rejects(capture(attempted), { check: "course-lesson-entry-attempt" });

  for (const [name, check] of [["position", "course-lesson-entry-progress"], ["progress-id", "course-lesson-entry-progress"],
    ["expiry", "course-lesson-entry-media"], ["generation", "course-lesson-entry-media"], ["metadata", "course-lesson-entry-history"]]) {
    const test = await seed(name), baseline = await capture(test);
    const receipt = await enter(test, name === "position" ? { resumePositionSeconds: 7 } : undefined);
    if (name === "progress-id") receipt.progress.progressId = randomUUID();
    if (name === "expiry") receipt.playback.thumbnailExpiresAt = new Date(Date.parse(receipt.playback.thumbnailExpiresAt) + 500).toISOString();
    if (name === "generation") await course.query(`INSERT INTO public.video_assets(lesson_id,generation,status,managed_by_course,provider_environment_id)
      VALUES($1,2,'pending',true,'owned-mux')`, [test.selection.lessonId]);
    if (name === "metadata") await course.query("UPDATE public.courses SET description='different' WHERE id=$1::uuid", [test.selection.courseId]);
    await assert.rejects(observe(test, baseline, receipt), { check });
    await assert.rejects(observe(test, baseline, receipt), { check: "course-lesson-entry-receipt" });
  }

  await runOwnedLessonDenialWitness({ course, job, dependencies, seed, enter, enrollment, progress, video, quiz,
    entitlement: createDrizzleEntitlementRepository(db), admin: createDrizzleAdminEntitlementCommandRepository(db) });
  await runOwnedAssessmentWitness({ course, job, dependencies, input, create, enrollment, progress, video, quiz });
  await runOwnedLessonResumeWitness({ course, job, dependencies, seed, enter, authorize, progress, quiz });
}

async function runOwnedLessonResumeWitness({ course, job, dependencies, seed, enter, authorize, progress, quiz }) {
  const capture = ({ selection }) => captureP2InteractiveResumeBaseline(job, selection, dependencies);
  const observe = ({ selection }, baseline, receipt) => observeP2InteractiveResumeCase(job, selection, baseline, receipt, dependencies);
  const write = (test, expectedProgressRevision, resumePositionSeconds, maxPositionSeconds) => progress.recordProgress({
    userId: test.selection.actorId, courseId: test.selection.courseId, lessonId: test.selection.lessonId,
    enrollmentId: test.enrollmentId, expectedProgressRevision, resumePositionSeconds, maxPositionSeconds,
  });
  const play = async (test, pauseWatched = 13) => {
    const entry = await enter(test), writes = [];
    for (const [index, [resume, submittedMax, savedMax]] of [[10, 10, 10], [14, pauseWatched, 14], [4, 14, 14]].entries()) {
      const expectedProgressRevision = index + 1, result = await write(test, expectedProgressRevision, resume, submittedMax);
      assert.deepEqual({
        id: result.id, enrollmentId: result.enrollmentId, revision: result.revision,
        resumePositionSeconds: result.resumePositionSeconds, maxPositionSeconds: result.maxPositionSeconds,
        completedAt: result.completedAt, completedQuizRevision: result.completedQuizRevision,
      }, { id: entry.progress.progressId, enrollmentId: test.enrollmentId, revision: index + 2,
        resumePositionSeconds: resume, maxPositionSeconds: savedMax, completedAt: null, completedQuizRevision: null });
      writes.push({ requestId: randomUUID(), expectedProgressRevision, revision: result.revision, resumePositionSeconds: resume,
        submittedMaxPositionSeconds: submittedMax, maxPositionSeconds: savedMax });
    }
    return { page: { pathname: entry.page.pathname, status: 200 },
      playback: { ...entry.playback, playbackIdSha256: hash(`owned-playback-${test.assetId}`) },
      started: entry.progress, writes, media: { durationSeconds: 32, videoWidth: 320,
        heartbeatSeconds: 11, pausedSeconds: 14, rewoundSeconds: 4, manifestObserved: true, segmentObserved: true } };
  };

  for (const name of ["fresh-expiry", "prior-longer-expiry"]) {
    const longer = name === "prior-longer-expiry";
    const test = await seed(`resume-${name}`, { priorExpiry: longer ? new Date(Date.now() + 900_000).toISOString() : null });
    const baseline = await capture(test), receipt = await play(test, longer ? 14 : 13);
    assert.equal(JSON.stringify(baseline), "{}");
    await assert.rejects(write(test, 3, 9, 14), { name: "ProgressRevisionConflictError" });
    await assert.rejects(observe(test, {}, receipt), { check: "course-lesson-resume-receipt" });
    for (const mutate of [
      ({ playback }) => { playback.playbackIdSha256 = hash("foreign-playback"); },
      ({ playback }) => { playback.token = "owned-private-value"; },
      ({ started }) => { started.enrollmentId = randomUUID(); },
      ({ writes }) => { writes[1].requestId = writes[0].requestId; },
      ({ writes }) => { writes[1].submittedMaxPositionSeconds = 12; },
      ({ writes }) => { writes[2].expectedProgressRevision = 2; },
      ({ writes }) => { writes[2].maxPositionSeconds = 4; },
      ({ writes, media }) => { writes[2].resumePositionSeconds = 5; media.rewoundSeconds = 5; },
      ({ media }) => { media.durationSeconds = 21; },
      ({ media }) => { media.heartbeatSeconds = 12; },
      ({ media }) => { media.segmentObserved = false; },
    ]) {
      const malformed = structuredClone(receipt);
      mutate(malformed);
      await assert.rejects(observe(test, baseline, malformed), { check: "course-lesson-resume-receipt" });
    }
    assert.deepEqual(await observe(test, baseline, receipt), { ...test.selection, enrollmentId: test.enrollmentId,
      progressId: receipt.started.progressId, revision: 4, resumePositionSeconds: 4, maxPositionSeconds: 14,
      playbackExpiresAt: receipt.playback.thumbnailExpiresAt, playbackIdSha256: receipt.playback.playbackIdSha256, readOnly: true });
    await assert.rejects(observe(test, baseline, receipt), { check: "course-lesson-resume-receipt" });
    await assert.rejects(capture(test), { check: "course-lesson-resume-baseline" });
  }

  const ineligible = await seed("resume-ineligible");
  await assert.rejects(capture({ selection: { ...ineligible.selection, grantId: randomUUID() } }), { check: "course-lesson-resume-grant" });
  for (const [name, options] of [["preview", { preview: true }], ["unmanaged", { managed: false }], ["no-quiz", { withQuiz: false }],
    ["short-asset", { durationSeconds: 21 }], ["unknown-duration", { durationSeconds: null }]]) {
    await assert.rejects(capture(await seed(`resume-${name}`, options)), { check: "course-lesson-resume-lesson" });
  }
  const attempted = await seed("resume-prior-attempt");
  await quiz.submitAttempt({ userId: attempted.selection.actorId, lessonId: attempted.selection.lessonId, quizRevision: 1, requestId: randomUUID(),
    answers: [{ questionId: "question", optionId: "b" }] });
  await assert.rejects(capture(attempted), { check: "course-lesson-resume-attempt" });

  for (const [name, check] of [["progress", "course-lesson-resume-progress"], ["progress-id", "course-lesson-resume-progress"],
    ["asset", "course-lesson-resume-media"], ["expiry", "course-lesson-resume-media"], ["outbox", "course-lesson-resume-history"]]) {
    const test = await seed(`resume-${name}`), eventId = randomUUID();
    if (name === "outbox") {
      // Own a preexisting event independently of the two pinned enrollment producers.
      const { courseId } = test.selection, streamId = randomUUID(), userId = randomUUID(), at = new Date().toISOString();
      const body = JSON.stringify({ data: { courseId, effectiveAt: at, state: "active", userId }, eventId, eventType: "enrollment.activated",
        occurredAt: at, producer: "lash-her-course-api", schemaVersion: 1, stream: { id: streamId, version: 1 } });
      await course.query("INSERT INTO public.users(id) VALUES($1)", [userId]);
      await course.query("INSERT INTO public.community_enrollment_streams(id,user_id,course_id,version,state,effective_at) VALUES($1,$2,$3,1,'active',$4)",
        [streamId, userId, courseId, at]);
      await course.query(`INSERT INTO public.community_enrollment_outbox(event_id,stream_id,stream_version,canonical_body,canonical_digest)
        VALUES($1,$2,1,$3,$4)`, [eventId, streamId, body, hash(body)]);
    }
    const baseline = await capture(test), receipt = await play(test);
    if (name === "progress") await write(test, 4, 5, 14);
    if (name === "progress-id") receipt.started.progressId = randomUUID();
    if (name === "asset") await course.query("UPDATE public.video_assets SET mux_playback_id=$2 WHERE id=$1::uuid",
      [test.assetId, `owned-replaced-${test.assetId}`]);
    if (name === "expiry") receipt.playback.thumbnailExpiresAt = new Date(Date.parse(receipt.playback.thumbnailExpiresAt) + 500).toISOString();
    if (name === "outbox") {
      const update = await course.query("UPDATE public.community_enrollment_outbox SET updated_at=pg_catalog.clock_timestamp() WHERE event_id=$1::uuid", [eventId]);
      assert.equal(update.rowCount, 1);
    }
    await assert.rejects(observe(test, baseline, receipt), { check });
    await assert.rejects(observe(test, baseline, receipt), { check: "course-lesson-resume-receipt" });
  }

  const rewind = async test => {
    const baseline = await capture(test), receipt = await play(test);
    return observe(test, baseline, receipt);
  };
  await runOwnedLessonRestoreWitness({ course, job, dependencies, seed, rewind, authorize, progress, write });
}

async function runOwnedLessonRestoreWitness({ course, job, dependencies, seed, rewind, authorize, progress, write }) {
  const prepare = async (name, options) => {
    const test = await seed(`restore-${name}`, options);
    const prior = await rewind(test);
    const { progressId, enrollmentId, resumePositionSeconds, maxPositionSeconds, playbackIdSha256, playbackExpiresAt } = prior;
    return { ...test, selection: { ...test.selection, prior: { actionId: `owned-restore-${name}`, outcomeSha256: hash(JSON.stringify(prior)),
      progressId, enrollmentId, resumePositionSeconds, maxPositionSeconds, playbackIdSha256, playbackExpiresAt } } };
  };
  const capture = selection => captureP2InteractiveRestoreBaseline(job, selection, dependencies);
  const observe = (selection, baseline, receipt) => observeP2InteractiveRestoreCase(job, selection, baseline, receipt, dependencies);
  const restore = async test => {
    const { actorId: userId, courseId, lessonId, prior } = test.selection;
    const playback = { ...await authorize(test), playbackIdSha256: prior.playbackIdSha256 };
    const started = await progress.recordProgress({ userId, courseId, lessonId, enrollmentId: prior.enrollmentId, expectedProgressRevision: 4, markStarted: true });
    const restored = await write(test, 5, prior.resumePositionSeconds, prior.maxPositionSeconds);
    for (const [index, result] of [started, restored].entries()) {
      assert.deepEqual({
        id: result.id, enrollmentId: result.enrollmentId, revision: result.revision, resumePositionSeconds: result.resumePositionSeconds,
        maxPositionSeconds: result.maxPositionSeconds, completedAt: result.completedAt, completedQuizRevision: result.completedQuizRevision,
      }, { id: prior.progressId, enrollmentId: prior.enrollmentId, revision: 5 + index, resumePositionSeconds: prior.resumePositionSeconds,
        maxPositionSeconds: prior.maxPositionSeconds, completedAt: null, completedQuizRevision: null });
    }
    return { page: { pathname: `/academy/courses/${courseId}/lessons/${lessonId}`, status: 200 }, playback,
      started: { requestId: randomUUID(), progressId: started.id, enrollmentId: started.enrollmentId, revision: started.revision },
      restored: { requestId: randomUUID(), progressId: restored.id, enrollmentId: restored.enrollmentId, revision: restored.revision,
        resumePositionSeconds: restored.resumePositionSeconds, maxPositionSeconds: restored.maxPositionSeconds },
      media: { durationSeconds: 32, videoWidth: 320, restoredSeconds: restored.resumePositionSeconds, paused: true,
        manifestObserved: true, segmentObserved: true } };
  };
  for (const name of ["fresh-expiry", "prior-longer-expiry"]) {
    const priorExpiry = name === "prior-longer-expiry" ? new Date(Date.now() + 900_000).toISOString() : null;
    const test = await prepare(name, { priorExpiry });
    const { selection } = test, { prior, ...selected } = selection;
    for (const patch of [{ progressId: randomUUID() }, { enrollmentId: randomUUID() }, { resumePositionSeconds: 5, maxPositionSeconds: 15 }]) {
      await assert.rejects(capture({ ...selection, prior: { ...prior, ...patch } }), { check: "course-lesson-restore-progress" });
    }
    for (const patch of [{ playbackIdSha256: hash("foreign-playback") }, { playbackExpiresAt: new Date(Date.now() + 1_000_000).toISOString() }]) {
      await assert.rejects(capture({ ...selection, prior: { ...prior, ...patch } }), { check: "course-lesson-restore-media" });
    }
    for (const patch of [{ actionId: "../different" }, { outcomeSha256: "0".repeat(64) }, { maxPositionSeconds: 15 }, { revision: 4 },
      { playbackExpiresAt: "0000-01-01T00:00:00.000Z" }]) {
      await assert.rejects(capture({ ...selection, prior: { ...prior, ...patch } }), { check: "course-lesson-restore-selection" });
    }
    const baseline = await capture(selection);
    assert.equal(JSON.stringify(baseline), "{}");
    const receipt = await restore(test);
    await assert.rejects(write(test, 5, 4, 14), { name: "ProgressRevisionConflictError" });
    await assert.rejects(observe({ ...selection, prior: { ...prior, outcomeSha256: hash("different receipt") } }, baseline, receipt),
      { check: "course-lesson-restore-receipt" });
    await assert.rejects(observe(selection, {}, receipt), { check: "course-lesson-restore-receipt" });
    for (const mutate of [
      value => { value.page.status = 204; },
      ({ playback }) => { playback.playbackIdSha256 = hash("foreign-playback"); },
      ({ playback }) => { playback.token = "owned-private-value"; },
      ({ playback }) => { playback.expiresAt = new Date(Date.parse(prior.playbackExpiresAt) - 1500).toISOString();
        playback.thumbnailExpiresAt = new Date(Date.parse(prior.playbackExpiresAt) - 1000).toISOString(); },
      ({ playback }) => { playback.expiresAt = prior.playbackExpiresAt; playback.thumbnailExpiresAt = prior.playbackExpiresAt; },
      ({ started }) => { started.revision = 4; },
      ({ started, restored }) => { restored.requestId = started.requestId; },
      ({ restored }) => { restored.progressId = randomUUID(); },
      ({ restored }) => { restored.maxPositionSeconds = 4; },
      ({ media }) => { media.restoredSeconds = 5; },
      ({ media }) => { media.paused = false; },
      ({ media }) => { media.segmentObserved = false; },
    ]) {
      const malformed = structuredClone(receipt);
      mutate(malformed);
      await assert.rejects(observe(selection, baseline, malformed), { check: "course-lesson-restore-receipt" });
    }
    assert.deepEqual(await observe(selection, baseline, receipt), { ...selected, enrollmentId: prior.enrollmentId, progressId: prior.progressId,
      revision: 6, resumePositionSeconds: 4, maxPositionSeconds: 14, playbackIdSha256: prior.playbackIdSha256,
      playbackExpiresAt: receipt.playback.thumbnailExpiresAt, readOnly: true });
    await assert.rejects(observe(selection, baseline, receipt), { check: "course-lesson-restore-receipt" });
    await assert.rejects(capture(selection), { check: "course-lesson-restore-progress" });
  }
  for (const [name, check] of [["position", "course-lesson-restore-progress"], ["duration", "course-lesson-restore-media"],
    ["expiry", "course-lesson-restore-media"], ["metadata", "course-lesson-restore-history"]]) {
    const test = await prepare(name), { selection } = test, baseline = await capture(selection), receipt = await restore(test);
    if (name === "position") await write(test, 6, 5, 14);
    if (name === "duration") await course.query("UPDATE public.video_assets SET duration_seconds=31 WHERE id=$1::uuid", [test.assetId]);
    if (name === "expiry") receipt.playback.thumbnailExpiresAt = new Date(Date.parse(receipt.playback.thumbnailExpiresAt) + 500).toISOString();
    if (name === "metadata") await course.query("UPDATE public.courses SET description='different' WHERE id=$1::uuid", [selection.courseId]);
    await assert.rejects(observe(selection, baseline, receipt), { check });
    await assert.rejects(observe(selection, baseline, receipt), { check: "course-lesson-restore-receipt" });
  }

  const prepareRestored = async (name, options) => {
    const test = await prepare(`ack-loss-${name}`, options), baseline = await capture(test.selection);
    const { actorId, courseId, lessonId, grantId, progressId, enrollmentId, resumePositionSeconds, maxPositionSeconds, playbackIdSha256 } =
      await observe(test.selection, baseline, await restore(test));
    return { ...test, selection: { actorId, courseId, lessonId, grantId, progressId, enrollmentId,
      resumePositionSeconds, maxPositionSeconds, playbackIdSha256 } };
  };
  await runOwnedLessonAckLossWitness({ course, job, dependencies, prepareRestored, authorize, progress, write });
}

async function runOwnedLessonAckLossWitness({ course, job, dependencies, prepareRestored, authorize, progress, write }) {
  const capture = selection => captureP2InteractiveAckLossBaseline(job, selection, dependencies);
  const observe = (selection, baseline, receipt) => observeP2InteractiveAckLossCase(job, selection, baseline, receipt, dependencies);
  const playbackExpiry = receipt => new Date(Math.max(...receipt.playback.flatMap(
    item => [Date.parse(item.expiresAt), Date.parse(item.thumbnailExpiresAt)]))).toISOString();
  const runRecovery = async test => {
    const { actorId: userId, courseId, lessonId, progressId, enrollmentId, resumePositionSeconds, maxPositionSeconds, playbackIdSha256 } = test.selection;
    const identify = result => {
      assert.equal(result.completedAt, null);
      assert.equal(result.completedQuizRevision, null);
      const { id, enrollmentId, revision, resumePositionSeconds, maxPositionSeconds } = result;
      return { progressId: id, enrollmentId, revision, resumePositionSeconds, maxPositionSeconds };
    };
    const started = revision => progress.recordProgress({ userId, courseId, lessonId, enrollmentId,
      expectedProgressRevision: revision, markStarted: true });
    const sign = async () => ({ ...await authorize(test), playbackIdSha256 });
    const initialPlayback = await sign();
    const initialStart = await started(6);
    const restore = await write(test, 7, resumePositionSeconds, maxPositionSeconds);
    const committed = await write(test, 8, maxPositionSeconds, maxPositionSeconds);
    const [authoritative, ...duplicates] = await progress.listProgress({ userId, courseId, lessonId });
    assert.equal(duplicates.length, 0);
    assert.deepEqual(authoritative, committed);
    await wait(2);
    const reloadedPlayback = await sign();
    const reloadStart = await started(9);
    const reload = await write(test, 10, maxPositionSeconds, maxPositionSeconds);
    const writes = [initialStart, restore, committed, reloadStart, reload].map((result, index) => {
      const stored = identify(result);
      assert.deepEqual(stored, { progressId, enrollmentId, revision: index + 7,
        resumePositionSeconds: index < 2 ? resumePositionSeconds : maxPositionSeconds, maxPositionSeconds });
      return { requestId: randomUUID(), ...stored };
    });
    return { page: { pathname: `/academy/courses/${courseId}/lessons/${lessonId}`, status: 200 },
      playback: [initialPlayback, reloadedPlayback], writes,
      recovery: { requestId: randomUUID(), ...identify(authoritative), browserFailure: "connectionreset", unconfirmedObserved: true, noReplay: true },
      media: { beforeSeconds: resumePositionSeconds, afterSeconds: maxPositionSeconds, paused: true,
        manifestObserved: true, segmentObserved: true } };
  };

  for (const name of ["fresh-expiry", "prior-longer-expiry"]) {
    const priorExpiry = name === "prior-longer-expiry" ? new Date(Date.now() + 900_000).toISOString() : null;
    const test = await prepareRestored(name, { priorExpiry }), { selection } = test;
    for (const patch of [{ progressId: randomUUID() }, { enrollmentId: randomUUID() }, { resumePositionSeconds: 5, maxPositionSeconds: 15 }]) {
      await assert.rejects(capture({ ...selection, ...patch }), { check: "course-lesson-ack-loss-progress" });
    }
    await assert.rejects(capture({ ...selection, grantId: randomUUID() }), { check: "course-lesson-ack-loss-grant" });
    await assert.rejects(capture({ ...selection, playbackIdSha256: hash("foreign-playback") }), { check: "course-lesson-ack-loss-media" });
    for (const patch of [{ playbackIdSha256: "0".repeat(64) }, { maxPositionSeconds: 13 }, { revision: 6 }]) {
      await assert.rejects(capture({ ...selection, ...patch }), { check: "course-lesson-ack-loss-selection" });
    }
    const baseline = await capture(selection);
    assert.equal(JSON.stringify(baseline), "{}");
    const receipt = await runRecovery(test);
    await assert.rejects(observe(selection, {}, receipt), { check: "course-lesson-ack-loss-receipt" });
    await assert.rejects(observe({ ...selection, progressId: randomUUID() }, baseline, receipt), { check: "course-lesson-ack-loss-receipt" });
    await assert.rejects(observeP2InteractiveAckLossCase(job, selection, baseline, receipt, { ...dependencies, verifySession: async () => {} }),
      { check: "course-lesson-ack-loss-receipt" });
    for (const mutate of [
      ({ page }) => { page.status = 204; },
      ({ playback }) => { playback[0].playbackIdSha256 = hash("foreign-playback"); },
      ({ playback }) => { playback[1].lifetimeMs = 601_000; },
      ({ playback }) => { playback[1].token = "owned-private-value"; },
      ({ writes }) => { writes[0].resumePositionSeconds = 14; },
      ({ writes }) => { writes[4].revision = 12; },
      ({ recovery }) => { recovery.revision = 8; },
      ({ recovery }) => { recovery.noReplay = false; },
      ({ recovery }) => { recovery.unconfirmedObserved = false; },
      ({ recovery, writes }) => { recovery.requestId = writes[2].requestId; },
      ({ media }) => { media.segmentObserved = false; },
    ]) {
      const malformed = structuredClone(receipt);
      mutate(malformed);
      await assert.rejects(observe(selection, baseline, malformed), { check: "course-lesson-ack-loss-receipt" });
    }
    assert.deepEqual(await observe(selection, baseline, receipt), { ...selection, revision: 11,
      resumePositionSeconds: 14, playbackExpiresAt: playbackExpiry(receipt), readOnly: true });
    await assert.rejects(write(test, 8, 14, 14), { name: "ProgressRevisionConflictError" });
    await assert.rejects(observe(selection, baseline, receipt), { check: "course-lesson-ack-loss-receipt" });
    await assert.rejects(capture(selection), { check: "course-lesson-ack-loss-progress" });
  }

  for (const [name, check] of [["position", "course-lesson-ack-loss-progress"], ["duration", "course-lesson-ack-loss-media"],
    ["expiry", "course-lesson-ack-loss-media"], ["metadata", "course-lesson-ack-loss-history"]]) {
    const test = await prepareRestored(name), { selection } = test, baseline = await capture(selection), receipt = await runRecovery(test);
    if (name === "position") await write(test, 11, 13, 14);
    if (name === "duration") await course.query("UPDATE public.video_assets SET duration_seconds=31 WHERE id=$1::uuid", [test.assetId]);
    if (name === "expiry") receipt.playback[1].thumbnailExpiresAt = new Date(Date.parse(receipt.playback[1].thumbnailExpiresAt) + 500).toISOString();
    if (name === "metadata") await course.query("UPDATE public.courses SET description='different' WHERE id=$1::uuid", [selection.courseId]);
    await assert.rejects(observe(selection, baseline, receipt), { check });
    await assert.rejects(observe(selection, baseline, receipt), { check: "course-lesson-ack-loss-receipt" });
  }
}

async function runOwnedLessonDenialWitness({ course, job, dependencies, seed, enter, enrollment, progress, video, quiz, entitlement, admin }) {
  const selected = async (name, options) => {
    const test = await seed(`denial-${name}`, { withCanaries: true, ...options });
    return { test, selection: { ...test.selection, enrolledActorId: test.selection.actorId, actorId: randomUUID() } };
  };
  const receiptFor = ({ courseId, lessonId }) => {
    const lesson = `/api/academy/lessons/${lessonId}`;
    const targets = [lesson, `${lesson}/playback`, `/api/academy/progress?lessonId=${lessonId}`, `${lesson}/quiz`, `${lesson}/quiz/attempts`];
    return { page: { pathname: `/academy/courses/${courseId}/lessons/${lessonId}`, documentStatus: 200, flightStatus: 200,
      documentRequestId: randomUUID(), flightRequestId: randomUUID() },
      reads: targets.map(target => ({ target, status: 403, requestId: randomUUID(), code: "access_required" })) };
  };
  const capture = selection => captureP2InteractiveLessonDenialBaseline(job, selection, dependencies);
  const observe = (selection, baseline, receipt = receiptFor(selection)) =>
    observeP2InteractiveLessonDenialCase(job, selection, baseline, receipt, dependencies);
  const prepared = async name => {
    const result = await selected(name);
    await enter(result.test);
    return result;
  };
  const { test, selection } = await prepared("positive");
  const { actorId: userId, courseId, lessonId } = selection;
  const unrelated = await seed("denial-unrelated");
  await enrollment.enrollFree({ userId, courseId: unrelated.selection.courseId, idempotencyKey: randomUUID() });
  await course.query("INSERT INTO public.account_lifecycle_states(user_id,account_version,status,updated_at) VALUES($1,1,'active',pg_catalog.clock_timestamp())",
    [userId]);

  const baseline = await capture(selection);
  assert.equal(JSON.stringify(baseline), "{}");
  assert.equal(await entitlement.findActiveEnrollment({ userId, courseId }), null);
  assert.equal(await entitlement.hasActiveEnrollment({ userId, courseId: unrelated.selection.courseId }), true);
  await assert.rejects(video.withPlaybackAuthorization({ userId, lessonId }, async () => assert.fail("Denied learner reached the signer")),
    { statusCode: 403, code: "ACTIVE_ENROLLMENT_REQUIRED" });
  await assert.rejects(progress.recordProgress({ userId, courseId, lessonId, enrollmentId: test.enrollmentId, expectedProgressRevision: 0,
    markStarted: true }), { name: "ProgressEnrollmentNotActiveError" });
  assert.deepEqual(await progress.listProgress({ userId, lessonId }), []);
  await assert.rejects(quiz.readStudentQuiz({ userId, lessonId }), { name: "QuizAccessDeniedError" });
  await assert.rejects(quiz.listAttempts({ userId, lessonId }), { name: "QuizAccessDeniedError" });
  await assert.rejects(quiz.submitAttempt({ userId, lessonId, quizRevision: 1, requestId: randomUUID(),
    answers: [{ questionId: "question", optionId: "b" }] }), { name: "QuizAccessDeniedError" });

  const receipt = receiptFor(selection);
  await assert.rejects(observe(selection, {}, receipt), { check: "course-lesson-denial-receipt" });
  await assert.rejects(observe({ ...selection, actorId: randomUUID() }, baseline, receipt), { check: "course-lesson-denial-receipt" });
  await assert.rejects(observe(selection, baseline, { ...receipt, page: { ...receipt.page, flightStatus: 404 } }),
    { check: "course-lesson-denial-receipt" });
  for (const flightRequestId of [receipt.page.documentRequestId, receipt.reads[0].requestId]) {
    await assert.rejects(observe(selection, baseline, { ...receipt, page: { ...receipt.page, flightRequestId } }),
      { check: "course-lesson-denial-receipt" });
  }
  for (const patch of [{ status: 200 }, { code: "access_revoked" }, { target: receipt.reads[1].target }, { requestId: receipt.reads[1].requestId }]) {
    await assert.rejects(observe(selection, baseline, { ...receipt, reads: [{ ...receipt.reads[0], ...patch }, ...receipt.reads.slice(1)] }),
      { check: "course-lesson-denial-receipt" });
  }
  await assert.rejects(observeP2InteractiveLessonDenialCase(job, selection, baseline, receipt,
    { ...dependencies, verifySession: async () => {} }), { check: "course-lesson-denial-receipt" });
  assert.deepEqual(await observe(selection, baseline, receipt), { ...selection, effectiveAccess: false, readOnly: true });
  await assert.rejects(observe(selection, baseline, receipt), { check: "course-lesson-denial-receipt" });

  await assert.rejects(capture({ ...selection, actorId: selection.enrolledActorId }), { check: "course-lesson-denial-selection" });
  await assert.rejects(capture({ ...selection, grantId: randomUUID() }), { check: "course-lesson-denial-grant" });
  await assert.rejects(capture({ ...selection, courseId: unrelated.selection.courseId }), { check: "course-lesson-denial-lesson" });
  for (const [name, options] of [["preview", { preview: true }], ["unmanaged", { managed: false }], ["no-quiz", { withQuiz: false }]]) {
    const { selection: invalid } = await selected(name, { ...options, priorExpiry: new Date() });
    await assert.rejects(capture(invalid), { check: "course-lesson-denial-lesson" });
  }
  const { selection: unstarted } = await selected("unstarted", { priorExpiry: new Date() });
  await assert.rejects(capture(unstarted), { check: "course-lesson-denial-progress" });
  const missingCanaries = await selected("missing-canaries", { withCanaries: false });
  await enter(missingCanaries.test);
  await assert.rejects(capture(missingCanaries.selection), { check: "course-lesson-denial-canaries" });
  const former = await prepared("former");
  const oldGrant = await enrollment.enrollFree({ userId: former.selection.actorId, courseId: former.selection.courseId, idempotencyKey: randomUUID() });
  await assert.rejects(capture(former.selection), { check: "course-lesson-denial-access" });
  await admin.revoke({ scope: "grantId", grantId: oldGrant.record.id, actorUserId: randomUUID(), reason: "Owned historical access fixture",
    idempotencyKey: randomUUID() });
  await assert.rejects(capture(former.selection), { check: "course-lesson-denial-pristine" });

  for (const [name, check, change] of [
    ["media", "course-lesson-denial-media", ({ test }) => course.query(
      "UPDATE public.video_assets SET last_token_expires_at=last_token_expires_at+interval '1 second' WHERE id=$1", [test.assetId])],
    ["quiz", "course-lesson-denial-history", ({ selection }) => course.query(
      "INSERT INTO public.quiz_revisions(lesson_id,revision,document,created_by) SELECT lesson_id,2,document,$2 FROM public.quiz_revisions WHERE lesson_id=$1 AND revision=1",
      [selection.lessonId, randomUUID()])],
    ["account", "course-lesson-denial-account", ({ selection }) => course.query(
      "INSERT INTO public.account_lifecycle_states(user_id,account_version,status,updated_at) VALUES($1,1,'deleted',pg_catalog.clock_timestamp())",
      [selection.actorId])],
  ]) {
    const fixture = await prepared(name), before = await capture(fixture.selection);
    await change(fixture);
    await assert.rejects(observe(fixture.selection, before), { check });
    await assert.rejects(observe(fixture.selection, before), { check: "course-lesson-denial-receipt" });
  }
}

async function runOwnedAssessmentWitness({ course, job, dependencies, input, create, enrollment, progress, video, quiz }) {
  const document = { version: 1, mode: "graded", passingPercent: 80, questions: ["z-first", "a-second"].map(id => ({
    id, prompt: `Owned question ${id}`, options: [{ id: "left", text: "Left" }, { id: "right", text: "Right" }],
    correctOptionId: "right", feedback: "Owned feedback",
  })) };
  const seed = async (name, { mode = "graded", preview = false, withMedia = false } = {}) => {
    const fixture = input(`assessment-${name}`, { status: "published", accessMode: "free", priceCents: 0 });
    await create(fixture);
    const { courseId } = fixture, moduleId = randomUUID(), lessonId = randomUUID(), actorId = randomUUID(), quizId = randomUUID();
    await course.query("INSERT INTO public.modules(id,course_id,slug,title,position) VALUES($1,$2,'module','Module',1)", [moduleId, courseId]);
    await course.query("INSERT INTO public.lessons(id,module_id,slug,title,position,is_preview) VALUES($1,$2,'assessment','Assessment',1,$3)", [lessonId, moduleId, preview]);
    await course.query("INSERT INTO public.quiz_revisions(id,lesson_id,revision,document,created_by) VALUES($1,$2,1,$3::jsonb,$4)",
      [quizId, lessonId, { ...document, mode }, randomUUID()]);
    if (withMedia) await course.query("INSERT INTO public.video_assets(lesson_id,status) VALUES($1,'pending')", [lessonId]);
    const grant = await enrollment.enrollFree({ userId: actorId, courseId, idempotencyKey: randomUUID() });
    return { enrollmentId: grant.record.enrollmentId, quizId,
      selection: { actorId, courseId, lessonId, grantId: grant.record.id, quizRevision: 1,
        failAnswers: document.questions.map(({ id }, index) => ({ questionId: id, optionId: index === 0 ? "left" : "right" })),
        passAnswers: document.questions.map(({ id }) => ({ questionId: id, optionId: "right" })) } };
  };
  const capture = ({ selection }) => captureP2InteractiveAssessmentBaseline(job, selection, dependencies);
  const observe = ({ selection }, baseline, receipt) => observeP2InteractiveAssessmentCase(job, selection, baseline, receipt, dependencies);
  const start = ({ selection: { actorId: userId, courseId, lessonId }, enrollmentId }) =>
    progress.recordProgress({ userId, courseId, lessonId, enrollmentId, expectedProgressRevision: 0, markStarted: true });
  const perform = async ({ selection: { actorId: userId, courseId, lessonId, quizRevision, failAnswers, passAnswers }, enrollmentId, quizId }) => {
    assert.equal((await quiz.readStudentQuiz({ userId, lessonId })).id, quizId);
    await assert.rejects(video.withPlaybackAuthorization({ userId, lessonId }, async () => assert.fail("Text-only lesson reached signer")),
      { statusCode: 404, code: "LESSON_NOT_FOUND" });
    const started = await start({ selection: { actorId: userId, courseId, lessonId }, enrollmentId });
    assert.equal(started.revision, 1);
    await assert.rejects(progress.recordProgress({ userId, courseId, lessonId, enrollmentId, expectedProgressRevision: 1, markCompleted: true }),
      { name: "GradedQuizCompletionRequiredError" });
    const attempts = [];
    for (const [index, answers] of [failAnswers, passAnswers].entries()) {
      const payloadRequestId = randomUUID();
      const result = await quiz.submitAttempt({ userId, lessonId, quizRevision, requestId: payloadRequestId, answers });
      assert.deepEqual(result.answers.map(answer => answer.questionId), ["a-second", "z-first"]);
      assert.equal(result.passed, index === 1);
      const [stored] = await progress.listProgress({ userId, lessonId });
      assert.equal(stored.revision, index + 2);
      attempts.push({ requestId: randomUUID(), payloadRequestId, attemptId: result.id, quizRevisionId: result.quizRevisionId,
        quizRevision: result.quizRevision, correctCount: result.correctCount, totalCount: result.totalCount, passed: result.passed,
        completed: result.completed, createdAt: result.createdAt.toISOString(), progress: {
          requestId: randomUUID(), progressId: stored.id, enrollmentId: stored.enrollmentId, revision: stored.revision,
          completedAt: stored.completedAt?.toISOString() ?? null, completedQuizRevision: stored.completedQuizRevision,
        } });
    }
    assert.equal((await quiz.listAttempts({ userId, lessonId })).length, 2);
    return { page: { pathname: `/academy/courses/${courseId}/lessons/${lessonId}`, status: 200 },
      playback: { requestId: randomUUID(), status: 404 },
      started: { requestId: randomUUID(), progressId: started.id, enrollmentId, revision: started.revision }, attempts };
  };

  const fixture = await seed("valid"), { selection, enrollmentId } = fixture;
  const baseline = await capture(fixture), receipt = await perform(fixture);
  assert.equal(JSON.stringify(baseline), "{}");
  for (const mutate of [
    value => { value.playback.status = 200; },
    value => { value.attempts[0].payloadRequestId = value.attempts[1].payloadRequestId; },
    value => { value.attempts[0].correctCount = 0; },
    value => { value.attempts[1].progress.completedQuizRevision = null; },
    value => { value.attempts[0].answers = selection.failAnswers; },
    value => { value.attempts.reverse(); },
  ]) {
    const invalid = structuredClone(receipt);
    mutate(invalid);
    await assert.rejects(observe(fixture, baseline, invalid), { check: "course-assessment-receipt" });
  }
  assert.deepEqual(await observe(fixture, baseline, receipt), { actorId: selection.actorId, courseId: selection.courseId,
    lessonId: selection.lessonId, grantId: selection.grantId, quizRevision: selection.quizRevision, enrollmentId, progressId: receipt.started.progressId,
    attemptIds: receipt.attempts.map(attempt => attempt.attemptId), progressRevision: 3, readOnly: true });
  await assert.rejects(observe(fixture, baseline, receipt), { check: "course-assessment-receipt" });
  await assert.rejects(capture(fixture), { check: "course-assessment-pristine" });

  for (const [name, settings] of [["preview", { preview: true }], ["practice", { mode: "practice" }], ["media", { withMedia: true }]]) {
    await assert.rejects(capture(await seed(name, settings)), { check: "course-assessment-lesson" });
  }
  const pristine = await seed("pristine");
  const refuseSelection = (patch, check) =>
    assert.rejects(capture({ selection: { ...pristine.selection, ...patch } }), { check });
  await refuseSelection({ grantId: randomUUID() }, "course-assessment-grant");
  await refuseSelection({ quizRevision: 2 }, "course-assessment-lesson");
  await refuseSelection({ passAnswers: pristine.selection.failAnswers }, "course-assessment-selection");
  await refuseSelection({ passAnswers: pristine.selection.passAnswers.toReversed(),
    failAnswers: pristine.selection.failAnswers.toReversed() }, "course-assessment-lesson");
  await refuseSelection({ failAnswers: pristine.selection.failAnswers.map(answer => ({ ...answer, optionId: "other" })) }, "course-assessment-lesson");
  await refuseSelection({ failAnswers: pristine.selection.passAnswers, passAnswers: pristine.selection.failAnswers }, "course-assessment-lesson");
  await start(pristine);
  await assert.rejects(capture(pristine), { check: "course-assessment-pristine" });

  const otherAnswers = await seed("other-answers"), answersBaseline = await capture(otherAnswers);
  const alternateSelection = { ...otherAnswers.selection,
    failAnswers: otherAnswers.selection.failAnswers.map((answer, index) => ({ ...answer, optionId: index === 0 ? "right" : "left" })) };
  const alternateReceipt = await perform({ ...otherAnswers, selection: alternateSelection });
  assert.equal(alternateReceipt.attempts[0].correctCount, 1);
  await assert.rejects(observe(otherAnswers, answersBaseline, alternateReceipt), { check: "course-assessment-attempts" });

  for (const [name, check, drift] of [
    ["payload", "course-assessment-attempts", ({ attempts }) => { attempts[0].payloadRequestId = randomUUID(); }],
    ["progress", "course-assessment-progress", ({ started }) => course.query("UPDATE public.lesson_progress SET revision=4 WHERE id=$1",
      [started.progressId])],
    ["history", "course-assessment-history", (_receipt, { selection: { courseId } }) => course.query(
      "UPDATE public.courses SET description='Owned history change' WHERE id=$1", [courseId])],
  ]) {
    const fixture = await seed(name), baseline = await capture(fixture), receipt = await perform(fixture);
    await drift(receipt, fixture);
    await assert.rejects(observe(fixture, baseline, receipt), { check });
    await assert.rejects(observe(fixture, baseline, receipt), { check: "course-assessment-receipt" });
  }
}

async function ownedEnrollmentSettlement(course, community, communitySource) {
  const { tsImport } = createRequire(import.meta.url)("tsx/esm/api");
  const importCommunity = path => tsImport(pathToFileURL(join(communitySource, "src/integrations/course", path)).href, import.meta.url);
  const { createDrizzleCourseEnrollmentReceiptRepository } = await importCommunity("inbox/course-enrollment-receipt.repository.ts");
  const { canonicalizeEnrollmentEvent } = await importCommunity("contracts/enrollment-event.ts");
  const { drizzle } = createRequire(join(communitySource, "package.json"))("drizzle-orm/node-postgres");
  const receiver = createDrizzleCourseEnrollmentReceiptRepository(drizzle(community));
  return async ({ streamId }, version, apply = true) => {
    const { rows: [event] } = await course.query(`SELECT event_id::text,canonical_body,canonical_digest FROM public.community_enrollment_outbox
      WHERE stream_id=$1::uuid AND stream_version=$2::int AND state='pending'`, [streamId, version]);
    const canonical = canonicalizeEnrollmentEvent(JSON.parse(event.canonical_body));
    assert.equal(canonical.digest, event.canonical_digest);
    await course.query("UPDATE public.community_enrollment_outbox SET last_attempt_at=pg_catalog.clock_timestamp() WHERE event_id=$1::uuid", [event.event_id]);
    if (apply) assert.deepEqual(await receiver.receive({ canonical, receivedAt: new Date() }), { status: "accepted", disposition: "applied" });
    await course.query(`UPDATE public.community_enrollment_outbox SET state='delivered',delivered_at=pg_catalog.clock_timestamp(),
      lease_owner=NULL,lease_expires_at=NULL,updated_at=pg_catalog.clock_timestamp() WHERE event_id=$1::uuid`, [event.event_id]);
    return { eventId: event.event_id, canonicalDigest: canonical.digest };
  };
}

async function runOwnedPaidRevokeWitness({ course, job, dependencies, input, create, courseSource, expiryFixed, community, settle }) {
  const { seed, progress, write } = ownedPaidGrantFixtures({ course, input, create });
  const { db, importSource } = await ownedCourseRepository(course, courseSource);
  const [{ createDrizzleAdminEntitlementCommandRepository }] =
    await importOwnedAccountAwareCourseSource(importSource, "src/entitlements/admin-entitlement-command.repository.ts");
  const admin = createDrizzleAdminEntitlementCommandRepository(db);
  const independent = ({ selected: { userId, courseId, actorId } }) => admin.grant({ userId, courseId, actorUserId: actorId,
    idempotencyKey: randomUUID(), reason: "Owned independent manual access" });
  const datedGrant = async ({ selection: { userId, courseId }, enrollmentId }, expiresInSeconds) => {
    const key = randomUUID(), digest = hash(`owned-legacy-${key}`);
    // Current Course grants reject expiry input. Exercise retained historical rows on the disposable database.
    await course.query("BEGIN");
    try {
      await course.query("INSERT INTO public.entitlement_idempotency_keys(idempotency_key,command_type,request_hash) VALUES($1,'internal_grant',$2)", [key, digest]);
      await course.query(`INSERT INTO public.entitlement_grants(user_id,course_id,enrollment_id,idempotency_key,request_hash,grant_reason,
        external_order_id,external_payment_id,provider,granted_at,expires_at) VALUES($1,$2,$3,$4,$5,'purchase',$6,$7,'square',
        pg_catalog.clock_timestamp()-interval '2 minutes',pg_catalog.clock_timestamp()+$8::int*interval '1 second')`,
      [userId, courseId, enrollmentId, key, digest, `owned-order-${randomUUID()}`, `owned-payment-${randomUUID()}`, expiresInSeconds]);
      await course.query("COMMIT");
    } catch (error) {
      await course.query("ROLLBACK");
      throw error;
    }
  };
  const prepare = async (name, kind = "last", { targetDelivered = true, independentDelivered = true } = {}) => {
    const test = await seed(`revoke-${name}`), { courseId, userId, actorId, revision } = test.selection;
    await write(test);
    await progress(test, test.enrollmentId);
    const attemptId = randomUUID(), quizRevisionId = randomUUID();
    await course.query("INSERT INTO public.quiz_revisions(id,lesson_id,revision,document,created_by) VALUES($1,$2,1,$3::jsonb,$4)",
      [quizRevisionId, test.lessonId, { version: 1, mode: "graded", questions: [] }, actorId]);
    await course.query(`INSERT INTO public.quiz_attempts(id,user_id,lesson_id,quiz_revision_id,enrollment_id,request_id,request_hash,answers,
      correct_count,total_count,passed,completed) VALUES($1,$2,$3,$4,$5,$6,$7,'[]'::jsonb,1,1,true,true)`,
    [attemptId, userId, test.lessonId, quizRevisionId, test.enrollmentId, randomUUID(), hash("owned-revoke-attempt")]);
    const selected = { courseId, userId, grantId: test.grantId, actorId, revision, idempotencyKey: randomUUID(),
      reason: "Reviewed revoke é", remainingAccess: kind === "remaining" };
    const fixture = { ...test, selected, attemptId };
    if (kind === "remaining") await independent(fixture);
    if (kind === "expired") await datedGrant(fixture, -60);
    const other = await seed(`revoke-independent-${name}`, {}, userId);
    await write(other);
    if (independentDelivered) await settle(other, 1);
    const delivery = targetDelivered ? await settle(test, 1) : undefined;
    return { ...fixture, independentStreamId: other.streamId, independentCourseId: other.selection.courseId, delivery };
  };
  const capture = test => captureP2InteractivePaidRevokeBaseline(job, test.selected, dependencies);
  const command = ({ selected }, changes = {}) => admin.revoke({ scope: "grantId", grantId: selected.grantId, actorUserId: selected.actorId,
    reason: `[paid-course revision ${selected.revision}] ${selected.reason}`, idempotencyKey: `owner-paid-revoke:${selected.idempotencyKey}`, ...changes });
  const browser = ({ selected: { courseId, userId, grantId, revision } }, commandId) => ({ courseId, userId, grantId, commandId, courseRevision: revision });
  const observe = (test, baseline, receipt) => observeP2InteractivePaidRevokeCase(job, test.selected, baseline, receipt, dependencies);
  const newEvent = async test => (await course.query(`SELECT event_id::text FROM public.community_enrollment_outbox
    WHERE stream_id=$1::uuid AND stream_version=2`, [test.streamId])).rows[0]?.event_id ?? null;
  const assertEvidence = (test, receipt, transitionId, delivery, evidence) => {
    const remainingAccess = test.selected.remainingAccess;
    const { communityDelivery } = evidence;
    assert.match(communityDelivery.independentActiveSha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(evidence, { ...receipt, remainingAccess, transitionId, readOnly: true, communityDelivery: {
      ...delivery, streamId: test.streamId, streamVersion: remainingAccess ? 1 : 2, state: remainingAccess ? "active" : "revoked",
      independentActiveCount: 1, independentActiveSha256: communityDelivery.independentActiveSha256 } });
  };

  for (const kind of ["last", "remaining", "expired"]) {
    const test = await prepare(kind, kind), { selected } = test;
    assert.equal(validateP2InteractivePaidRevoke(selected, undefined), undefined);
    assert.throws(() => validateP2InteractivePaidRevoke(selected, {}), { check: "course-paid-revoke-selection" });
    assert.throws(() => validateP2InteractivePaidRevoke({ ...selected, reason: ` ${selected.reason}` }, undefined), { check: "course-paid-revoke-selection" });
    await assert.rejects(capture({ ...test, selected: { ...selected, grantId: randomUUID() } }), { check: "course-paid-revoke-grant" });
    await assert.rejects(capture({ ...test, selected: { ...selected, remainingAccess: !selected.remainingAccess } }), { check: "course-paid-revoke-access" });
    const baseline = await capture(test);
    assert.equal(JSON.stringify(baseline), "{}");
    const result = await command(test), receipt = browser(test, result.command.id), transitionId = await newEvent(test);
    assert.equal(result.isReplay, false);
    assert.equal(transitionId === null, selected.remainingAccess);
    await assert.rejects(observe(test, {}, receipt), { check: "course-paid-revoke-receipt" });
    await assert.rejects(observe(test, baseline, { ...receipt, courseRevision: 2 }), { check: "course-paid-revoke-receipt" });
    await assert.rejects(observeP2InteractivePaidRevokeCase(job, selected, baseline, receipt,
      { ...dependencies, verifySession: async () => {} }), { check: "course-paid-revoke-receipt" });
    if (kind === "last") {
      await course.query(`UPDATE public.community_enrollment_outbox SET lease_owner='owned-worker',
        lease_expires_at=pg_catalog.clock_timestamp()+interval '1 minute' WHERE event_id=$1::uuid`, [transitionId]);
      const [evidence, delivery] = await Promise.all([observe(test, baseline, receipt), wait(350).then(() => settle(test, 2))]);
      assertEvidence(test, receipt, transitionId, delivery, evidence);
    } else {
      const delivery = kind === "expired" ? await settle(test, 2) : test.delivery;
      assertEvidence(test, receipt, transitionId, delivery, await observe(test, baseline, receipt));
    }
    await assert.rejects(observe(test, baseline, receipt), { check: "course-paid-revoke-receipt" });
    await assert.rejects(capture(test), { check: "course-paid-revoke-grant" });
  }

  const occupied = await prepare("occupied"), owner = await prepare("occupied-foreign");
  await command(owner);
  await assert.rejects(capture({ ...occupied, selected: { ...occupied.selected, idempotencyKey: owner.selected.idempotencyKey } }),
    { check: "course-paid-revoke-baseline" });
  await assert.rejects(capture(await prepare("pending-baseline", "last", { targetDelivered: false })), { check: "course-paid-revoke-delivery-baseline" });
  await assert.rejects(capture(await prepare("missing-independent", "last", { independentDelivered: false })), { check: "community-paid-revoke-independent" });
  const disjoint = await prepare("disjoint-independent");
  await course.query("UPDATE public.courses SET status='archived' WHERE id=$1::uuid", [disjoint.independentCourseId]);
  await write(await seed("revoke-disjoint-course-only", {}, disjoint.selected.userId));
  await assert.rejects(capture(disjoint), { check: "community-paid-revoke-independent" });
  await assert.rejects(captureP2InteractivePaidRevokeBaseline(job, occupied.selected, { ...dependencies, readCommunityDatabaseUrl: undefined }),
    { check: "community-delivery-held-session" });
  await assert.rejects(captureP2InteractivePaidRevokeBaseline(job, occupied.selected,
    { ...dependencies, communityJob: { ...dependencies.communityJob, releaseId: "foreign-release" } }), { check: "community-delivery-job" });

  for (const [name, check] of [["reason", "course-paid-revoke-command"], ["actor", "course-paid-revoke-command"],
    ["command-id", "course-paid-revoke-command"], ["revision", "course-publication-state"], ["progress", "course-paid-revoke-history"],
    ["attempt", "course-paid-revoke-history"], ["independent", "course-paid-revoke-history"], ["dead-letter", "course-paid-revoke-outbox"],
    ["missing-attempt", "course-paid-revoke-outbox"], ["missing-inbox", "community-paid-revoke-inbox"], ["quarantined", "community-paid-revoke-inbox"],
    ["projection-drift", "community-paid-revoke-projection"], ["independent-drift", "community-paid-revoke-independent"]]) {
    const test = await prepare(name, name === "independent" ? "remaining" : "last"), { courseId } = test.selected;
    const baseline = await capture(test);
    const options = name === "reason" ? { reason: "Unreviewed reason" } : name === "actor" ? { actorUserId: randomUUID() } : {};
    const result = await command(test, options), receipt = browser(test, name === "command-id" ? randomUUID() : result.command.id);
    if (name === "revision") await course.query("UPDATE public.courses SET revision=revision+1 WHERE id=$1::uuid", [courseId]);
    if (name === "progress") await course.query("UPDATE public.lesson_progress SET resume_position_seconds=20 WHERE lesson_id=$1::uuid", [test.lessonId]);
    if (name === "attempt") await course.query(`UPDATE public.quiz_attempts SET user_id=NULL,enrollment_id=NULL,request_id=NULL,request_hash=NULL,
      answers='[]'::jsonb,deidentified_at=pg_catalog.clock_timestamp() WHERE id=$1::uuid`, [test.attemptId]);
    if (name === "independent") await independent(test);
    if (name === "dead-letter") await course.query(`UPDATE public.community_enrollment_outbox SET state='dead_letter',
      dead_lettered_at=pg_catalog.clock_timestamp() WHERE event_id=$1::uuid`, [await newEvent(test)]);
    if (["missing-attempt", "missing-inbox", "quarantined", "projection-drift", "independent-drift"].includes(name)) await settle(test, 2, name !== "missing-inbox");
    if (name === "missing-attempt") await course.query("UPDATE public.community_enrollment_outbox SET last_attempt_at=NULL WHERE event_id=$1::uuid",
      [await newEvent(test)]);
    if (name === "quarantined") await community.query(`UPDATE public.course_enrollment_inbox SET status='quarantined',quarantine_code='owned-fixture'
      WHERE event_id=$1::uuid`, [await newEvent(test)]);
    if (name === "projection-drift") await community.query(`UPDATE public.course_enrollment_projections SET status='gapped',highest_observed_version=3
      WHERE stream_id=$1::uuid`, [test.streamId]);
    if (name === "independent-drift") await community.query(`UPDATE public.course_enrollment_projections SET updated_at=pg_catalog.clock_timestamp()
      WHERE stream_id=$1::uuid`, [test.independentStreamId]);
    await assert.rejects(observe(test, baseline, receipt), { check });
    await assert.rejects(observe(test, baseline, receipt), { check: "course-paid-revoke-receipt" });
  }

  const test = await prepare("foreign-expiry"), foreign = await seed("revoke-foreign-future-grant");
  await write(foreign);
  await datedGrant(foreign, 3600);
  const baseline = await capture(test), result = await command(test);
  const receipt = browser(test, result.command.id), transitionId = await newEvent(test);
  if (expiryFixed) {
    assert.ok(transitionId);
    const delivery = await settle(test, 2);
    assertEvidence(test, receipt, transitionId, delivery, await observe(test, baseline, receipt));
  } else {
    // The original Course pin groups the expiry OR outside the user/course/status filter.
    assert.equal(transitionId, null);
    await assert.rejects(observe(test, baseline, receipt), { check: "course-paid-revoke-stream" });
  }
}

try { await main(); }
catch (error) { console.error(JSON.stringify({ status: "P2_LIFECYCLE_PERSISTENCE_OWNED_POSTGRES_FAILED", phase, code: error?.code ?? error?.name ?? "Error",
  ...(typeof error?.constraint === "string" ? { constraint: error.constraint } : {}), ...(typeof error?.table === "string" ? { table: error.table } : {}),
  ...(typeof error?.check === "string" ? { check: error.check } : {}),
  diagnostic: String(error?.message ?? "failure").replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gu, "{uuid}").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/gu, "{email}").slice(0, 180), providerTouched: false })); process.exitCode = 1; }
