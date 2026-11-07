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
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { runOwnedPersistenceScenario } from "./harness/owned-p2-lifecycle-persistence.mjs";
import { captureP2InteractiveCourseDraftBaseline, captureP2InteractiveCourseDraftEditsBaseline, captureP2InteractiveCourseReorderBaseline,
  captureP2InteractiveCurriculumCreateBaseline, captureP2InteractivePublicationBaseline, captureP2InteractiveQuizSaveBaseline,
  captureP2InteractiveFreeEnrollmentBaseline, observeP2InteractiveFreeEnrollmentCase,
  captureP2InteractivePaidGrantBaseline, observeP2InteractivePaidGrantCase,
  captureP2InteractivePaidArchiveBaseline, observeP2InteractivePaidArchiveCase, validateP2InteractivePaidArchive,
  captureP2InteractivePaidRepublishBaseline, observeP2InteractivePaidRepublishCase, validateP2InteractivePaidRepublish,
  observeP2InteractiveCourseDraftCase, observeP2InteractiveCourseDraftEditsCase, observeP2InteractiveCourseReorderCase,
  observeP2InteractiveCurriculumCreateCase, observeP2InteractivePublicationCase, observeP2InteractiveQuizSaveCase, p2LifecyclePersistenceTargetSha256,
  validateP2InteractiveCourseDraft, validateP2InteractiveCourseDraftEdits, validateP2InteractiveCourseReorder,
  validateP2InteractiveCurriculumCreate, validateP2InteractivePublication, validateP2InteractiveQuizSave } from "./p2-lifecycle-persistence-probe.mjs";
import { verifyP2LifecycleOwnedSourceManifest } from "./p2-lifecycle-owned-source-manifest.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const apiPins = { course: "0bb054d5a04db71c481a8b3d182db6df19782cdc", community: "8594d953a5c0e0849e7a2e5e0de21f03537c4dc4" };
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
      target: targets.course, sourceCommit: commits.course, courseSource: sources.course, ca });
    const receipt = { version: 1, status: `P2_LIFECYCLE_PERSISTENCE_OWNED_POSTGRES${postgresMajor}_PASS`, postgresMajor, frontendMigrations: 83,
      courseMigrations: 22, communityMigrations: 11, sourceCommits: commits, checks: [...result.checks, ...draftChecks], skipped: 0, readOnly: true,
      fixtureOnly: true, providerTouched: false, liveCertification: false, sourceMode: containerMode ? "parent-issued-manifest-and-mounted-readback" : "clean-git-checkouts",
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

async function runOwnedDraftWitness({ control, course, frontend, target, sourceCommit, courseSource, ca }) {
  const user = "owned_course_draft_migration", password = randomBytes(32).toString("hex"), database = target.database;
  await control.query(`CREATE ROLE ${user} LOGIN NOINHERIT PASSWORD '${password}'`);
  await control.query(`GRANT CONNECT ON DATABASE ${database} TO ${user}`);
  await course.query(`GRANT USAGE ON SCHEMA public TO ${user}`);
  await course.query(`GRANT SELECT ON public.courses, public.modules, public.lessons, public.quiz_revisions, public.quiz_attempts,
    public.entitlement_grants, public.enrollments, public.entitlement_idempotency_keys, public.community_enrollment_streams,
    public.community_enrollment_outbox, public.lesson_progress, public.admin_entitlement_commands,
    public.admin_entitlement_command_effects, public.entitlement_revocations, public.account_lifecycle_states TO ${user}`);
  const job = { schemaVersion: 2, qualificationTargetProfile: profile, kind: "operator-migration", operator: "Dardan",
    environment: "staging", contractPhase: "p2", releaseId: "owned-draft-read", sourceCommit, runtimeRole: target.runtimeRole,
    phase2ContractManifestSha256: `sha256:${hash(readFileSync(join(root, "contracts/api-integration/p2-candidate/manifest.json")))}`,
    target: { schemaVersion: 2, qualificationTargetProfile: profile, environment: "staging", service: "lash-her-course-api",
      host: target.host, port: target.port, database, user, serverMajor: target.serverMajor } };
  const dependencies = {
    verifyEnvironment: async () => {},
    verifySession: async () => assert.equal((await frontend.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks
      WHERE pid=pg_catalog.pg_backend_pid() AND locktype='advisory' AND granted AND mode='ExclusiveLock') AS held`)).rows[0].held, true),
    readCourseDatabaseUrl: () => `postgresql://${user}:${password}@${target.host}:${target.port}/${database}?sslmode=verify-full`,
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
    await runOwnedFreeEnrollmentWitness({ course, job, dependencies, input, create });
    await runOwnedPaidGrantWitness({ course, job, dependencies, input, create });
    await runOwnedPaidArchiveWitness({ course, job, dependencies, input, create, courseSource });
    await runOwnedPaidRepublishWitness({ course, job, dependencies, input, create, courseSource });
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
      "course-free-enrollment-orderless-grant-receipt-active-stream-and-canonical-pending-outbox",
      "course-free-enrollment-refuses-ineligible-occupied-and-persisted-outcome-drift",
      "course-paid-grant-orderless-manual-grant-audited-effect-and-canonical-pending-outbox",
      "course-paid-grant-refuses-ineligible-occupied-and-persisted-outcome-drift",
      "course-paid-archive-pinned-repository-preserves-history-without-community-outbox-mutation",
      "course-paid-archive-refuses-identity-history-projection-and-independent-eligibility-drift",
      "course-paid-republish-pinned-repository-restores-only-effective-access-and-keeps-blocked-draft",
      "course-paid-republish-refuses-inconsistent-access-revision-account-and-learning-history"];
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
  const module = await seed("module", "module-drift"), before = await capture(module);
  await write(module);
  await course.query("UPDATE public.modules SET description='unexpected' WHERE id=$1::uuid", [module.itemId]);
  await assert.rejects(observe(module, before), { check: "course-curriculum-create-persistence" });

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

async function runOwnedFreeEnrollmentWitness({ course, job, dependencies, input, create }) {
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
  assert.deepEqual(await observe(test, before), { ...browser(test), transitionId: test.eventId, readOnly: true });
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
    ["leased-outbox", {}, "course-free-enrollment-outbox"],
    ["mutated-progress", {}, "course-free-enrollment-progress"],
    ["extra-grant", {}, "course-free-enrollment-persistence"],
    ["receipt-grant", {}, "course-free-enrollment-persistence"],
  ]) {
    const selected = await seed(name), baseline = await capture(selected), at = await write(selected, options);
    if (name === "mutated-progress") await progress(selected, selected.enrollmentId);
    if (name === "leased-outbox") await course.query(`UPDATE public.community_enrollment_outbox SET lease_owner='owned-worker',
      lease_expires_at=pg_catalog.clock_timestamp()+interval '1 minute' WHERE event_id=$1::uuid`, [selected.eventId]);
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

async function runOwnedPaidGrantWitness({ course, job, dependencies, input, create }) {
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
  assert.deepEqual(await observe(test, before), { ...browser(test), enrollmentId: test.enrollmentId, transitionId: test.eventId, readOnly: true });
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
    ["revision", {}, "eligibility"], ["progress", {}, "progress"], ["leased", {}, "outbox"]]) {
    const selected = await seed(name), baseline = await capture(selected);
    await write(selected, changes);
    if (name === "revision") await course.query("UPDATE public.courses SET revision=revision+1 WHERE id=$1::uuid", [selected.selection.courseId]);
    if (name === "progress") await progress(selected, selected.enrollmentId);
    if (name === "leased") await course.query(`UPDATE public.community_enrollment_outbox SET lease_owner='owned-worker',
      lease_expires_at=pg_catalog.clock_timestamp()+interval '1 minute' WHERE event_id=$1::uuid`, [selected.eventId]);
    const receipt = name === "receipt" ? { ...browser(selected), commandId: randomUUID() } : browser(selected);
    await assert.rejects(observe(selected, baseline, receipt), { check: `course-paid-grant-${check}` });
    await assert.rejects(observe(selected, baseline), { check: "course-paid-grant-receipt" });
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
  const priorDotenv = process.env.DOTENV_CONFIG_PATH, priorAdmission = process.env.COURSE_ACCOUNT_LIFECYCLE_ENABLED;
  let entitlementCommands;
  try {
    process.env.DOTENV_CONFIG_PATH = "/dev/null";
    process.env.COURSE_ACCOUNT_LIFECYCLE_ENABLED = "true";
    const { createDrizzleAdminEntitlementCommandRepository } = await importSource("src/entitlements/admin-entitlement-command.repository.ts");
    entitlementCommands = createDrizzleAdminEntitlementCommandRepository(db);
  } finally {
    if (priorDotenv === undefined) delete process.env.DOTENV_CONFIG_PATH;
    else process.env.DOTENV_CONFIG_PATH = priorDotenv;
    if (priorAdmission === undefined) delete process.env.COURSE_ACCOUNT_LIFECYCLE_ENABLED;
    else process.env.COURSE_ACCOUNT_LIFECYCLE_ENABLED = priorAdmission;
  }
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

try { await main(); }
catch (error) { console.error(JSON.stringify({ status: "P2_LIFECYCLE_PERSISTENCE_OWNED_POSTGRES_FAILED", phase, code: error?.code ?? error?.name ?? "Error",
  ...(typeof error?.constraint === "string" ? { constraint: error.constraint } : {}), ...(typeof error?.table === "string" ? { table: error.table } : {}),
  ...(typeof error?.check === "string" ? { check: error.check } : {}),
  diagnostic: String(error?.message ?? "failure").replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gu, "{uuid}").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/gu, "{email}").slice(0, 180), providerTouched: false })); process.exitCode = 1; }
