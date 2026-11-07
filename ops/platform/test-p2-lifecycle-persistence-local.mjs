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
  captureP2InteractiveCurriculumCreateBaseline, observeP2InteractiveCourseDraftCase, observeP2InteractiveCourseDraftEditsCase,
  observeP2InteractiveCourseReorderCase, observeP2InteractiveCurriculumCreateCase, p2LifecyclePersistenceTargetSha256,
  validateP2InteractiveCourseDraft, validateP2InteractiveCourseDraftEdits, validateP2InteractiveCourseReorder,
  validateP2InteractiveCurriculumCreate } from "./p2-lifecycle-persistence-probe.mjs";
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
      target: targets.course, sourceCommit: commits.course, ca });
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

async function runOwnedDraftWitness({ control, course, frontend, target, sourceCommit, ca }) {
  const user = "owned_course_draft_migration", password = randomBytes(32).toString("hex"), database = target.database;
  await control.query(`CREATE ROLE ${user} LOGIN NOINHERIT PASSWORD '${password}'`);
  await control.query(`GRANT CONNECT ON DATABASE ${database} TO ${user}`);
  await course.query(`GRANT USAGE ON SCHEMA public TO ${user}`);
  await course.query(`GRANT SELECT ON public.courses, public.modules, public.lessons TO ${user}`);
  const job = { schemaVersion: 2, qualificationTargetProfile: profile, kind: "operator-migration", operator: "Dardan",
    environment: "staging", contractPhase: "p2", releaseId: "owned-draft-read", sourceCommit, runtimeRole: target.runtimeRole,
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
    await unlock();
    try { await assert.rejects(capture(input("unheld"))); }
    finally { await lock(); }
    return ["course-draft-exact-browser-bytes-held-absent-to-created-draft-and-private-fields", "course-draft-wrong-row-field-role-or-unheld-session-refused",
      "course-draft-edit-held-winning-fields-single-revision-and-stale-unchanged", "course-draft-edit-wrong-baseline-winner-stale-and-replay-refused",
      "course-module-and-lesson-full-reorder-archived-siblings-and-stale-zero-writes",
      "course-reorder-rejects-foreign-parent-sparse-result-sibling-identity-archive-and-order-drift",
      "course-curriculum-create-normal-module-and-lesson-fields-with-single-revision-and-preserved-siblings",
      "course-curriculum-create-refuses-occupied-or-foreign-baselines-and-storage-drift"];
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
}

try { await main(); }
catch (error) { console.error(JSON.stringify({ status: "P2_LIFECYCLE_PERSISTENCE_OWNED_POSTGRES_FAILED", phase, code: error?.code ?? error?.name ?? "Error",
  ...(typeof error?.constraint === "string" ? { constraint: error.constraint } : {}), ...(typeof error?.table === "string" ? { table: error.table } : {}),
  ...(typeof error?.check === "string" ? { check: error.check } : {}),
  diagnostic: String(error?.message ?? "failure").replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gu, "{uuid}").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/gu, "{email}").slice(0, 180), providerTouched: false })); process.exitCode = 1; }
