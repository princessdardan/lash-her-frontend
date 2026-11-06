// Source-owned private operator program, evaluated inside the exact selected
// gateway/API image. No public endpoint, arbitrary URL/path or token output.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:https";

export const PROFILES = Object.freeze({
  "course-learner": { service: "course", kind: "learner", prefix: "COURSE_LEARNER", audience: "lash-her-course-api:learner" },
  "course-admin": { service: "course", kind: "admin", prefix: "COURSE_ADMIN", audience: "lash-her-course-api:admin" },
  "community-member": { service: "community", kind: "member", prefix: "COMMUNITY_MEMBER", audience: "lash-her-community-api:member" },
  "community-admin": { service: "community", kind: "admin", prefix: "COMMUNITY_ADMIN", audience: "lash-her-community-api:admin" },
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const refuse = name => { throw new ProbeFailure(name); };
class ProbeFailure extends Error { constructor(check) { super("P2_IDENTITY_NEGATIVE_PROBE_REFUSED"); this.check = check; } }
const demand = (condition, name) => { if (!condition) refuse(name); };
const closed = (value, fields) => Boolean(value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...fields].sort().join());
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const secret = value => typeof value === "string" && Buffer.byteLength(value) >= 32 && Buffer.byteLength(value) <= 8192 && /^[!-~]+$/u.test(value);
const equal = (a, b) => typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function validatePrivateInput(input) {
  demand(closed(input, ["version", "mode", "environment", "bindingSha256", "subjects", "resources", "keys", "serviceKeys", "previousProfiles", "httpCheck",
    "runtimeEnvironment", "gatewayConfigurationSha256", "gatewayCaSha256"]), "input-shape");
  demand(input.version === 1 && input.environment === "staging" && ["course-http", "course-http-plan", "course-verifier", "community-verifier"].includes(input.mode) &&
    DIGEST.test(input.bindingSha256) && (input.httpCheck === null || typeof input.httpCheck === "string" && /^[a-z0-9.-]{1,120}$/u.test(input.httpCheck)), "staging-binding");
  demand(closed(input.subjects, ["learnerA", "learnerB", "admin"]) && Object.values(input.subjects).every(value => UUID.test(value)) &&
    new Set(Object.values(input.subjects)).size === 3, "dedicated-subjects");
  demand(closed(input.resources, ["courseA", "courseB", "sharedCourse", "lesson", "completedAttempt"]) && Object.values(input.resources).every(value => UUID.test(value)) &&
    new Set(Object.values(input.resources)).size === 5, "dedicated-resources");
  demand(closed(input.keys, Object.keys(PROFILES)) && Array.isArray(input.previousProfiles) &&
    input.previousProfiles.join() === [...new Set(input.previousProfiles)].sort().join() &&
    input.previousProfiles.every(name => Object.hasOwn(PROFILES, name)), "profile-inventory");
  const all = [];
  for (const [name, keys] of Object.entries(input.keys)) {
    demand(closed(keys, input.previousProfiles.includes(name) ? ["current", "previous"] : ["current"]) &&
      Object.values(keys).every(secret), "configured-key-baseline");
    all.push(...Object.values(keys));
  }
  demand(new Set(all).size === all.length && Array.isArray(input.serviceKeys) && input.serviceKeys.length > 0 && input.serviceKeys.length <= 24 &&
    input.serviceKeys.every(secret) && new Set(input.serviceKeys).size === input.serviceKeys.length &&
    !input.serviceKeys.some(value => all.includes(value)), "service-user-key-separation");
  demand(DIGEST.test(input.gatewayConfigurationSha256) && DIGEST.test(input.gatewayCaSha256) &&
    (input.mode.endsWith("-verifier") ? input.runtimeEnvironment && typeof input.runtimeEnvironment === "object" && !Array.isArray(input.runtimeEnvironment) &&
      Object.entries(input.runtimeEnvironment).every(([key, value]) => /^[A-Z][A-Z0-9_]*$/u.test(key) && typeof value === "string") : input.runtimeEnvironment === null),
  "private-runtime-binding-shape");
  return input;
}

function claims(profile, subject, now) {
  return { version: 1, iss: "lash-her-frontend", aud: PROFILES[profile].audience, sub: subject, iat: now, exp: now + 300, jti: randomUUID(),
    ...(PROFILES[profile].kind === "admin" ? { capabilities: profile === "course-admin" ? ["course-editor", "course-support"] : ["community-moderator"] } : {}) };
}
export function signProbeToken(payload, key, header = { alg: "HS256", typ: "JWT" }) {
  const unsigned = [header, payload].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  const signature = header.alg === "none" ? "" : createHmac(header.alg === "HS512" ? "sha512" : "sha256", key).update(unsigned).digest("base64url");
  return unsigned + "." + signature;
}

function negatives(input, profile, now) {
  const base = claims(profile, input.subjects[PROFILES[profile].kind === "admin" ? "admin" : "learnerA"], now);
  const current = input.keys[profile].current;
  const ownOther = Object.keys(PROFILES).find(name => PROFILES[name].service === PROFILES[profile].service && name !== profile);
  const foreign = Object.keys(PROFILES).find(name => PROFILES[name].service !== PROFILES[profile].service);
  const altered = (name, delta) => ({ name, token: signProbeToken({ ...base, ...delta }, current) });
  const rows = [
    { name: "missing-token", token: null },
    altered("wrong-issuer", { iss: "untrusted-issuer" }), altered("wrong-audience", { aud: "untrusted-audience" }),
    altered("array-audience", { aud: [PROFILES[profile].audience] }), altered("wrong-profile", { aud: PROFILES[ownOther].audience }),
    altered("invalid-subject", { sub: "not-a-uuid" }), altered("uppercase-subject", { sub: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }),
    altered("invalid-jti", { jti: "not-a-uuid" }), altered("wrong-version", { version: 2 }),
    altered("overlong-lifetime", { exp: now + 301 }), altered("nonpositive-lifetime", { exp: now }), altered("expired-outside-skew", { iat: now - 300, exp: now - 60 }),
    altered("future-iat-outside-skew", { iat: now + 60 }), altered("fractional-iat", { iat: now + 0.5 }),
    altered("extra-pii-claim", { email: "operator-probe@example.invalid" }),
    { name: "wrong-signature", token: signProbeToken(base, randomBytes(48).toString("hex")) },
    { name: "cross-profile-key", token: signProbeToken(base, input.keys[ownOther].current) },
    { name: "cross-service-key", token: signProbeToken(base, input.keys[foreign].current) },
    { name: "wrong-algorithm", token: signProbeToken(base, current, { alg: "HS512", typ: "JWT" }) },
    { name: "unsigned-token", token: signProbeToken(base, current, { alg: "none", typ: "JWT" }) },
  ];
  for (const field of ["iss", "aud", "sub", "iat", "exp", "jti", "version"]) {
    const value = { ...base }; delete value[field]; rows.push({ name: "missing-" + field, token: signProbeToken(value, current) });
  }
  for (const [index, key] of input.serviceKeys.entries()) rows.push({ name: "service-key-" + index, token: signProbeToken(base, key) });
  if (PROFILES[profile].kind === "admin") {
    rows.push(altered("missing-capability", { capabilities: [] }), altered("unknown-capability", { capabilities: ["untrusted-capability"] }),
      altered("duplicate-capability", { capabilities: [...base.capabilities, base.capabilities[0]] }));
  } else rows.push(altered("unexpected-capability", { capabilities: ["course-editor"] }));
  return rows;
}

function receipt(input, scope, checks, extra = {}) {
  return { version: 1, status: "P2_IDENTITY_NEGATIVE_PROBE_PASS", environment: "staging", bindingSha256: input.bindingSha256,
    scope, checks, ...extra, readOnly: true, oidcVerified: false, keyRemovalVerified: false, releaseAccepted: false };
}

const MODULES = {
  course: ["dist/auth/first-party.js", "dist/auth/jwt-profile.js", "dist/config/env.js"],
  community: ["dist/auth/community-user-auth.js", "dist/config/runtime.js", "dist/config/env.js"],
};
async function loadActualVerifier(service) {
  const implementation = await import(service === "course" ? "/app/dist/auth/first-party.js" : "/app/dist/auth/community-user-auth.js");
  const configured = await import("/app/dist/config/env.js");
  return service === "course" ? { ...implementation, ...configured } : { ...implementation, ...configured, ...await import("/app/dist/config/runtime.js") };
}

export async function probeActualVerifier(input, options = {}) {
  validatePrivateInput(input);
  demand(input.mode.endsWith("-verifier"), "verifier-mode");
  const service = input.mode.split("-")[0], environment = options.environment ?? process.env;
  demand(environment.DATABASE_TARGET === "staging", "running-staging-target");
  // Compose owns these nonsecret overrides; the exec child deliberately has a
  // smaller NODE_OPTIONS budget. Every other original configured value must
  // match the actual process, including the named staging database URL.
  const overrides = new Set(["NODE_ENV", "NODE_OPTIONS", "PORT", "HTTP_BIND_ADDRESS", "INTERNAL_SERVICE_TRUSTED_PROXY_CIDRS",
    "INTERNAL_SERVICE_ALLOWED_IPS", "COURSE_COMMUNITY_READ_ALLOWED_IPS", "INTERNAL_TRUSTED_PROXY_CIDRS"]);
  demand(input.runtimeEnvironment.DATABASE_TARGET === "staging" && typeof input.runtimeEnvironment.STAGING_DATABASE_URL === "string" &&
    environment.NODE_ENV === "production" && Object.entries(input.runtimeEnvironment).every(([key, value]) => overrides.has(key) || equal(environment[key], value)),
  "running-runtime-configuration");
  const selected = Object.keys(PROFILES).filter(name => PROFILES[name].service === service);
  for (const profile of selected) {
    for (const [slot, suffix] of [["current", "CURRENT"], ["previous", "PREVIOUS"]]) {
      const actual = environment[`${PROFILES[profile].prefix}_JWT_${suffix}_SECRET`], expected = input.keys[profile][slot];
      demand(expected === undefined ? actual === undefined : equal(actual, expected), "running-key-configuration");
    }
  }
  const implementation = await (options.loadVerifier ?? loadActualVerifier)(service);
  for (const profile of selected) for (const [slot, suffix] of [["current", "CURRENT"], ["previous", "PREVIOUS"]]) {
    const actual = implementation.env[`${PROFILES[profile].prefix}_JWT_${suffix}_SECRET`], expected = input.keys[profile][slot];
    demand(expected === undefined ? actual === undefined : equal(actual, expected), "parsed-runtime-key-configuration");
  }
  // Course's default constructor consumes the actual image's parsed env.
  // Community's source-owned constructor consumes the exact verified runtime keys.
  const verifier = service === "course" ? implementation.createFirstPartyJwtVerifier() : implementation.createCommunityUserVerifier(implementation.resolveCommunityUserRuntime(implementation.env));
  const checks = [], now = Math.floor(Date.now() / 1000);
  const verify = async (profile, token, selectedVerifier = verifier) => {
    const authorization = token === null ? undefined : "Bearer " + token;
    return service === "course" ? selectedVerifier.verify({ headers: { authorization } }) :
      selectedVerifier[PROFILES[profile].kind === "admin" ? "verifyAdmin" : "verifyMember"](authorization);
  };
  for (const profile of selected) {
    for (const slot of Object.keys(input.keys[profile])) {
      const expected = claims(profile, input.subjects[PROFILES[profile].kind === "admin" ? "admin" : "learnerA"], now);
      const value = await verify(profile, signProbeToken(expected, input.keys[profile][slot]));
      demand(value && (service === "course" ? value.profile === PROFILES[profile].kind && value.user?.userId === expected.sub :
        value.kind === PROFILES[profile].kind && value.claims?.sub === expected.sub), profile + "." + slot + ".valid-baseline");
      checks.push({ name: profile + "." + slot + ".valid-baseline", status: "passed" });
    }
    for (const row of negatives(input, profile, now)) {
      const value = await verify(profile, row.token);
      demand(value === null, profile + "." + row.name);
      checks.push({ name: profile + "." + row.name, status: "passed" });
    }
    // Deterministic code-boundary checks in the actual image module. These do
    // not change the server clock or claim measured deployed revocation time.
    const bounded = Object.fromEntries(selected.map(name => [PROFILES[name].kind, { currentSecret: input.keys[name].current,
      ...(input.keys[name].previous === undefined ? {} : { previousSecret: input.keys[name].previous }) }]));
    const edgeVerifier = service === "course" ? implementation.createFirstPartyJwtVerifier({ ...bounded, nowSeconds: () => now }) :
      implementation.createCommunityUserVerifier({ ...bounded, nowSeconds: () => now });
    const base = claims(profile, input.subjects[PROFILES[profile].kind === "admin" ? "admin" : "learnerA"], now);
    for (const [name, delta, accepted] of [["fixed-clock-expired-29-baseline", { iat: now - 300, exp: now - 29 }, true],
      ["fixed-clock-expired-31", { iat: now - 300, exp: now - 31 }, false], ["fixed-clock-future-31", { iat: now + 31 }, false]]) {
      const value = await verify(profile, signProbeToken({ ...base, ...delta }, input.keys[profile].current), edgeVerifier);
      demand(Boolean(value) === accepted, profile + "." + name);
      checks.push({ name: profile + "." + name, status: "passed" });
    }
  }
  const moduleSha256 = Object.fromEntries(MODULES[service].map(file => [file, hash((options.readModule ?? (name => readFileSync("/app/" + name)))(file))]));
  return receipt(input, "actual-" + service + "-image-verifier-only", checks, { moduleSha256, runtimeConfigurationBindingVerified: true });
}

export function createPrivateTlsReader(ca, makeRequest = request) {
  demand(typeof ca === "string" || Buffer.isBuffer(ca), "private-ca");
  return (path, token) => new Promise((resolve, reject) => {
    demand(/^\/v1\/(?:(?:student|admin)\/courses\/[a-f0-9-]{36}|student\/lessons\/[a-f0-9-]{36}\/quiz\/attempts)$/u.test(path), "fixed-readonly-path");
    const pending = makeRequest({ hostname: "course-tls", port: 8443, servername: "course-tls", rejectUnauthorized: true, minVersion: "TLSv1.2",
      ca, method: "GET", path, agent: false, headers: { accept: "application/json", connection: "close", ...(token === null ? {} : { authorization: "Bearer " + token }) },
      signal: AbortSignal.timeout(5000) }, response => {
      const chunks = []; let size = 0;
      response.on("data", chunk => { size += chunk.length; if (size > 65_536) response.destroy(new Error("P2_PROBE_RESPONSE_BOUND")); else chunks.push(chunk); });
      response.once("error", reject);
      response.once("end", () => {
        if (response.statusCode >= 300 && response.statusCode < 400) return reject(new Error("P2_PROBE_REDIRECT_REFUSED"));
        let body;
        if (response.statusCode === 200) {
          try { demand(response.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() === "application/json", "positive-json-baseline");
            body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reject(new Error("P2_PROBE_BASELINE_REFUSED")); }
        }
        resolve({ status: response.statusCode, body });
      });
    });
    pending.once("error", reject); pending.end();
  });
}

function httpCases(input) {
  const now = Math.floor(Date.now() / 1000), rows = [];
  const check = (name, path, token, expected, course, history) => rows.push({ name, path, token, expected, course, history });
  const studentPath = id => "/v1/student/courses/" + id, adminPath = id => "/v1/admin/courses/" + id;
  const token = (profile, subject, slot = "current", capability) => signProbeToken({ ...claims(profile, subject, now),
    ...(capability ? { capabilities: capability } : {}) }, input.keys[profile][slot]);
  for (const slot of Object.keys(input.keys["course-learner"])) {
    check("course-http." + slot + ".learner-a-baseline", studentPath(input.resources.courseA), token("course-learner", input.subjects.learnerA, slot), 200, input.resources.courseA);
    check("course-http." + slot + ".learner-b-baseline", studentPath(input.resources.courseB), token("course-learner", input.subjects.learnerB, slot), 200, input.resources.courseB);
  }
  for (const slot of Object.keys(input.keys["course-admin"])) check("course-http." + slot + ".admin-baseline", adminPath(input.resources.courseA),
    token("course-admin", input.subjects.admin, slot), 200, input.resources.courseA);
  for (const profile of ["course-learner", "course-admin"]) for (const row of negatives(input, profile, now)) {
    const path = profile === "course-admin" ? adminPath(input.resources.courseA) : studentPath(input.resources.courseA);
    // A learner token with an administrator audience but signed by the learner
    // key is still invalid; a valid learner lacks administrator capability.
    check("course-http." + profile + "." + row.name, path, row.token, 401);
  }
  check("course-http.customer-cannot-administer", adminPath(input.resources.courseA), token("course-learner", input.subjects.learnerA), 403);
  check("course-http.admin-cannot-impersonate-learner", studentPath(input.resources.courseA), token("course-admin", input.subjects.admin), 401);
  check("course-http.support-cannot-edit", adminPath(input.resources.courseA), token("course-admin", input.subjects.admin, "current", ["course-support"]), 403);
  check("course-http.account-a-cannot-read-b", studentPath(input.resources.courseB), token("course-learner", input.subjects.learnerA), 403);
  check("course-http.account-b-cannot-read-a", studentPath(input.resources.courseA), token("course-learner", input.subjects.learnerB), 403);
  check("course-http.shared-course-a-baseline", studentPath(input.resources.sharedCourse), token("course-learner", input.subjects.learnerA), 200, input.resources.sharedCourse);
  check("course-http.shared-course-b-baseline", studentPath(input.resources.sharedCourse), token("course-learner", input.subjects.learnerB), 200, input.resources.sharedCourse);
  const attempts = "/v1/student/lessons/" + input.resources.lesson + "/quiz/attempts";
  check("course-http.completed-attempt-a-baseline", attempts, token("course-learner", input.subjects.learnerA), 200, undefined, "owner");
  check("course-http.completed-attempt-isolated-from-b", attempts, token("course-learner", input.subjects.learnerB), 200, undefined, "other");
  check("course-http.final-valid-baseline", studentPath(input.resources.courseA), token("course-learner", input.subjects.learnerA), 200, input.resources.courseA);
  return rows;
}

export function courseHttpCheckPlan(input) {
  validatePrivateInput(input);
  demand(input.mode === "course-http-plan" && input.httpCheck === null, "http-plan-mode");
  return { version: 1, status: "P2_IDENTITY_HTTP_CHECK_PLAN", bindingSha256: input.bindingSha256,
    checks: httpCases(input).map(row => ({ name: row.name, expectedStatus: row.expected })), networkCalled: false };
}

export async function probeCourseHttps(input, options = {}) {
  validatePrivateInput(input); demand(input.mode === "course-http", "http-mode");
  const raw = (options.readGateway ?? (() => readFileSync("/config/gateway.json")))(), ca = (options.readCa ?? (() => readFileSync("/tls/ca.pem")))();
  demand(hash(raw) === input.gatewayConfigurationSha256 && hash(ca) === input.gatewayCaSha256, "running-gateway-configuration");
  const config = JSON.parse(raw.toString("utf8"));
  demand(config.appEnv === "staging" && config.courseOrigin === "https://course-tls:8443" && config.upstreamCaFile === "/tls/ca.pem", "fixed-private-tls-target");
  const read = options.read ?? createPrivateTlsReader(ca);
  const selected = httpCases(input).filter(row => input.httpCheck === null || row.name === input.httpCheck), checks = [];
  demand(selected.length > 0 && (input.httpCheck === null || selected.length === 1), "fixed-http-check");
  for (const row of selected) {
    const response = await read(row.path, row.token);
    let positive = row.expected !== 200 || response.body?.course?.id === row.course;
    if (row.history) {
      const attempts = response.body?.attempts;
      positive = Array.isArray(attempts) && attempts.every(item => UUID.test(item?.id) && item.lessonId === input.resources.lesson) &&
        (row.history === "owner" ? attempts.some(item => item.id === input.resources.completedAttempt && item.completed === true) :
          attempts.every(item => item.id !== input.resources.completedAttempt));
    }
    demand(response.status === row.expected && positive, row.name);
    checks.push({ name: row.name, status: "passed", httpStatus: response.status });
  }
  return receipt(input, "actual-course-private-tls-readonly-http", checks, { completeHttpSuite: input.httpCheck === null,
    gatewayConfigurationBindingVerified: true, workloadOidcVerified: false });
}

export async function runPrivateProbeFromStdin() {
  let size = 0; const chunks = [];
  try {
    for await (const chunk of process.stdin) { size += chunk.length; demand(size <= 262_144, "private-input-bound"); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = input.mode === "course-http-plan" ? courseHttpCheckPlan(input) : input.mode === "course-http" ? await probeCourseHttps(input) : await probeActualVerifier(input);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    const check = error instanceof ProbeFailure && /^[a-z0-9.-]{1,120}$/u.test(error.check) ? error.check : "private-probe-failed";
    process.stdout.write(JSON.stringify({ version: 1, status: "P2_IDENTITY_NEGATIVE_PROBE_FAILED", check, readOnly: true, oidcVerified: false, releaseAccepted: false }) + "\n");
    process.exitCode = 1;
  }
}
