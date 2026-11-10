// Actual qualified API modules/routes behind owned loopback HTTPS. Immutable
// in-memory business fixtures are not deployed resources or live SQL evidence.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:https";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { PROFILES, probeActualVerifier, probeCourseHttps, createPrivateTlsReader, courseHttpCheckPlan } from "../p2-identity-negative-probe.mjs";
import { identityProbeFixture, hashFixture } from "../p2-identity-negative-probe.fixture.mjs";

const course = process.env.P2_IDENTITY_COURSE_RUNTIME_DIR, community = process.env.P2_IDENTITY_COMMUNITY_RUNTIME_DIR;
assert.ok(course?.startsWith("/") && community?.startsWith("/"));
const input = identityProbeFixture(), mode = process.argv[2];
if (mode.endsWith("-current-only")) { input.previousProfiles = []; for (const value of Object.values(input.keys)) delete value.previous; }
Object.assign(process.env, { NODE_ENV: "test", DATABASE_TARGET: "test", TEST_DATABASE_URL: "postgresql://owned:owned@127.0.0.1:54321/owned_identity_probe?sslmode=verify-full" });
for (const [name, definition] of Object.entries(PROFILES)) for (const [slot, value] of Object.entries(input.keys[name]))
  process.env[`${definition.prefix}_JWT_${slot.toUpperCase()}_SECRET`] = value;

const load = async (service, file) => import(pathToFileURL(join(service === "course" ? course : community, "dist", file)).href);
const contract = JSON.parse(readFileSync(new URL("../../../contracts/api-integration/p2-candidate/manifest.json", import.meta.url)));
const sourceProof = {};
for (const [service, directory] of [["course", course], ["community", community]]) {
  assert.equal(execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), contract.artifacts[service].revision);
  const require = createRequire(join(directory, "package.json")), ts = require("typescript");
  const settings = ts.readConfigFile(join(directory, "tsconfig.build.json"), ts.sys.readFile);
  assert.equal(settings.error, undefined);
  const compiler = ts.parseJsonConfigFileContent(settings.config, ts.sys, directory).options;
  const files = service === "course" ? ["auth/first-party", "auth/jwt-profile", "config/env", "courses/student.routes", "quizzes/quiz.routes"] : ["auth/community-user-auth", "config/runtime", "config/env"];
  for (const file of files) {
    const text = readFileSync(join(directory, "src", file + ".ts"), "utf8");
    const compiled = ts.transpileModule(text, { compilerOptions: { ...compiler, module: ts.ModuleKind.ESNext }, fileName: file + ".ts" }).outputText;
    assert.equal(hashFixture(readFileSync(join(directory, "dist", file + ".js"))), hashFixture(compiled), "Owned compiled module must match the actual selected source");
    sourceProof[service + "/" + file] = hashFixture(compiled);
  }
}

if (mode.startsWith("verifiers")) {
  const receipts = [];
  for (const service of ["course", "community"]) {
    const environment = { NODE_ENV: "production", DATABASE_TARGET: "staging", STAGING_DATABASE_URL: "owned-private-staging-url" };
    for (const [profile, definition] of Object.entries(PROFILES).filter(([, row]) => row.service === service))
      for (const [slot, key] of Object.entries(input.keys[profile])) environment[`${definition.prefix}_JWT_${slot.toUpperCase()}_SECRET`] = key;
    const value = { ...input, mode: service + "-verifier", runtimeEnvironment: environment };
    const receipt = await probeActualVerifier(value, { environment,
      loadVerifier: async selected => selected === "course" ? { ...await load("course", "auth/first-party.js"), ...await load("course", "config/env.js") } :
        { ...await load("community", "auth/community-user-auth.js"), ...await load("community", "config/runtime.js"), ...await load("community", "config/env.js") },
      readModule: name => readFileSync(join(service === "course" ? course : community, name)) });
    assert.equal(receipt.status, "P2_IDENTITY_NEGATIVE_PROBE_PASS"); receipts.push(receipt);
  }
  process.stdout.write(JSON.stringify({ status: "OWNED_P2_IDENTITY_MODULES_PASS", receipts, sourceProof, liveImage: false }) + "\n");
} else {
  const directory = mkdtempSync(join(tmpdir(), "owned-p2-identity-tls-"));
  let server, app;
  const calls = [];
  try {
    const certificate = join(directory, "cert.pem"), key = join(directory, "key.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=course-tls",
      "-addext", "subjectAltName=DNS:course-tls,IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
    const { buildApp } = await load("course", "app.js");
    const courses = Object.fromEntries([input.resources.courseA, input.resources.courseB, input.resources.sharedCourse].map((id, index) => [id,
      { id, slug: "owned-course-" + index, title: "Owned course", description: null, status: "published", priceCents: 0, currency: "CAD", accessMode: "free",
        revision: 1, introduction: null, cover: null, seo: null, taxClassification: null, modules: [] }]));
    const attempt = { id: input.resources.completedAttempt, lessonId: input.resources.lesson, quizRevisionId: "99999999-9999-4999-8999-999999999999", quizRevision: 1,
      mode: "practice", passingPercent: 80, answers: [{ questionId: "owned-question", optionId: "owned-option" }], correctCount: 1, totalCount: 1,
      passed: true, completed: true, createdAt: new Date("2026-11-01T12:00:00Z"), results: [{ questionId: "owned-question", selectedOptionId: "owned-option",
        correctOptionId: "owned-option", correct: true, feedback: "private-owned-answer" }] };
    const before = hashFixture(JSON.stringify({ courses, attempt }));
    const mutable = new Proxy({}, { get: () => () => { throw new Error("OWNED_MUTATION_REFUSED"); } });
    app = await buildApp({ courseRepository: { ...mutable, findCourseWithModulesById: async id => courses[id] ?? null },
      entitlementRepository: { ...mutable, hasActiveEnrollment: async ({ userId, courseId }) => courseId === input.resources.sharedCourse ||
        userId === input.subjects.learnerA && courseId === input.resources.courseA || userId === input.subjects.learnerB && courseId === input.resources.courseB,
      hasRevokedEnrollment: async () => false }, lessonProgressRepository: mutable,
      quizRepository: { ...mutable, listAttempts: async ({ userId }) => mode === "missing-attempt" ? [] :
        userId === input.subjects.learnerA || mode === "leak-attempt" ? [attempt] : [] } });
    server = createServer({ cert: readFileSync(certificate), key: readFileSync(key) }, async (incoming, outgoing) => {
      calls.push({ method: incoming.method, path: incoming.url });
      if (mode === "all-401" || mode === "all-404") { outgoing.writeHead(mode === "all-401" ? 401 : 404); outgoing.end(); return; }
      if (mode === "redirect") { outgoing.writeHead(302, { location: "https://foreign.example.invalid" }); outgoing.end(); return; }
      if (mode === "oversized") { outgoing.writeHead(200, { "content-type": "application/json" }); outgoing.end(JSON.stringify({ privateBody: "x".repeat(70_000) })); return; }
      const result = await app.inject({ method: incoming.method, url: incoming.url, headers: incoming.headers });
      outgoing.writeHead(result.statusCode, result.headers); outgoing.end(result.rawPayload);
    });
    server.on("tlsClientError", () => {});
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const gateway = Buffer.from(JSON.stringify({ appEnv: "staging", courseOrigin: "https://course-tls:8443", upstreamCaFile: "/tls/ca.pem" }));
    const ca = readFileSync(certificate);
    input.gatewayConfigurationSha256 = hashFixture(gateway); input.gatewayCaSha256 = hashFixture(ca);
    if (mode === "single-check") input.httpCheck = courseHttpCheckPlan({ ...input, mode: "course-http-plan" }).checks[0].name;
    const read = createPrivateTlsReader(mode === "untrusted-ca" ? "untrusted-owned-ca" : ca,
      (options, callback) => request({ ...options, hostname: "127.0.0.1", port: server.address().port }, callback));
    // The injected connector is test source only; the deployed stdin schema has
    // no origin, port, CA override, callback, filesystem path or command field.
    let receipt, error;
    try { receipt = await probeCourseHttps(input, { read, readGateway: () => gateway, readCa: () => ca }); }
    catch (failure) { error = failure; }
    if (["all-401", "all-404", "redirect", "oversized", "untrusted-ca", "leak-attempt", "missing-attempt"].includes(mode)) assert.ok(error, "Required negative fixture must refuse");
    else { assert.ifError(error); assert.equal(receipt.status, "P2_IDENTITY_NEGATIVE_PROBE_PASS"); }
    if (mode === "single-check") { assert.equal(calls.length, 1); assert.equal(receipt.completeHttpSuite, false); }
    assert.equal(hashFixture(JSON.stringify({ courses, attempt })), before);
    assert.ok(calls.every(row => row.method === "GET"));
    const common = JSON.stringify(receipt ?? {});
    for (const value of [...Object.values(input.keys).flatMap(row => Object.values(row)), "Bearer ", "private-owned-answer", "owned-option"]) assert.equal(common.includes(value), false);
    process.stdout.write(JSON.stringify({ status: "OWNED_P2_IDENTITY_TLS_PASS", mode, receipt, calls: calls.length, allMethodsGet: true,
      businessFixtureUnchanged: true, refused: Boolean(error), actualCourseAppModules: true, actualDatabase: false, sourceProof }) + "\n");
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (app) await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
