// Fixed private probes. Course is real protected HTTPS; Community is the actual
// configured private guard and repository, because no member feature route exists.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { createRequire } from "node:module";
import { PROFILES, signProbeToken } from "./p2-identity-negative-probe.mjs";

const demand = condition => { if (!condition) throw new Error("P2_LIFECYCLE_RECEIVER_DENIAL_REFUSED"); };
const sha = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const closed = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === [...names].sort().join();
export function validateP2ReceiverDenialInput(input) {
  demand(closed(input, ["version", "mode", "environment", "bindingSha256", "subject", "courseId", "currentKey", "gatewayCaSha256", "runtimeEnvironment", "target"])
    && input.version === 1 && input.environment === "staging" && ["course-http", "community-private-guard"].includes(input.mode)
    && digest(input.bindingSha256) && uuid(input.subject) && uuid(input.courseId)
    && typeof input.currentKey === "string" && input.currentKey.length >= 32 && input.currentKey.length <= 8192 && /^[!-~]+$/u.test(input.currentKey));
  if (input.mode === "course-http") demand(digest(input.gatewayCaSha256) && input.runtimeEnvironment === null && input.target === null);
  else demand(input.gatewayCaSha256 === null && input.runtimeEnvironment && typeof input.runtimeEnvironment === "object" && !Array.isArray(input.runtimeEnvironment)
    && Object.values(input.runtimeEnvironment).every(value => typeof value === "string")
    && closed(input.target, ["host", "port", "database", "runtimeRole", "runtimeRoleOid", "serverMajor"])
    && typeof input.target.host === "string" && Number.isInteger(input.target.port) && input.target.port > 0 && input.target.port <= 65535 && typeof input.target.database === "string"
    && /^[a-z][a-z0-9_]{0,62}$/u.test(input.target.runtimeRole) && /^[1-9][0-9]{0,9}$/u.test(input.target.runtimeRoleOid)
    && [16,18].includes(input.target.serverMajor));
  return input;
}
function claims(profile, subject) {
  const now = Math.floor(Date.now()/1000);
  return { version: 1, iss: "lash-her-frontend", aud: PROFILES[profile].audience, sub: subject, iat: now, exp: now+300, jti: randomUUID() };
}
export async function observeCourseSuspensionDenial(input, options = {}) {
  validateP2ReceiverDenialInput(input); demand(input.mode === "course-http");
  const ca = options.ca ?? readFileSync("/tls/ca.pem"); demand(sha(ca) === input.gatewayCaSha256);
  const token = signProbeToken(claims("course-learner", input.subject), input.currentKey), start = new Date().toISOString();
  const result = await new Promise((done, fail) => {
    const pending = (options.request ?? request)({ hostname: "course-tls", port: 8443, servername: "course-tls", ca, rejectUnauthorized: true,
      minVersion: "TLSv1.2", method: "GET", path: `/v1/student/courses/${input.courseId}`, agent: false, signal: AbortSignal.timeout(8000),
      headers: { authorization: "Bearer " + token, accept: "application/json", connection: "close" } }, response => {
      const chunks = []; let count = 0;
      response.on("data", chunk => { count += chunk.length; if (count > 8192) response.destroy(); else chunks.push(chunk); });
      response.once("error", fail); response.once("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")), requestId = response.headers["x-request-id"];
          demand(response.statusCode === 403 && typeof requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(requestId)
            && /private/iu.test(response.headers["cache-control"] ?? "") && /no-store/iu.test(response.headers["cache-control"] ?? "")
            && closed(body, ["error"]) && closed(body.error, ["code", "message"]) && body.error.code === "FORBIDDEN"
            && body.error.message === "Account access is unavailable");
          done({ requestId, httpStatus: 403 });
        } catch { fail(new Error("P2_COURSE_ACCOUNT_DENIAL_UNVERIFIED")); }
      });
    });
    pending.once("error", fail); pending.end();
  });
  return { version: 1, status: "P2_LIFECYCLE_RECEIVER_DENIAL_OBSERVED", bindingSha256: input.bindingSha256, service: "course",
    evidenceClass: "actual-protected-course-http", ...result, denialStatusCode: 403, errorCode: "FORBIDDEN", startedAt: start,
    observedAt: new Date().toISOString(), freshCurrentToken: true, accountRestrictionVerified: true, tokenBytesOutput: false, releaseAccepted: false };
}

async function deployedCommunity() {
  const configured = { ...await import("/app/dist/config/env.js"), ...await import("/app/dist/config/runtime.js") };
  return { configured, ...await import("/app/dist/auth/community-user-auth.js"), ...await import("/app/dist/auth/community-user-routes.js"),
    ...await import("/app/dist/accounts/lifecycle-repository.js"), require: createRequire("/app/package.json") };
}
export async function observeCommunitySuspensionDenial(input, options = {}) {
  validateP2ReceiverDenialInput(input); demand(input.mode === "community-private-guard");
  const environment = options.environment ?? process.env, excluded = new Set(["NODE_ENV", "NODE_OPTIONS", "PORT", "HTTP_BIND_ADDRESS", "INTERNAL_SERVICE_TRUSTED_PROXY_CIDRS", "INTERNAL_SERVICE_ALLOWED_IPS", "COURSE_COMMUNITY_READ_ALLOWED_IPS", "INTERNAL_TRUSTED_PROXY_CIDRS"]);
  demand(environment.NODE_ENV === "production" && environment.DATABASE_TARGET === "staging"
    && Object.entries(input.runtimeEnvironment).every(([key, value]) => excluded.has(key) || environment[key] === value)
    && environment.COMMUNITY_MEMBER_JWT_CURRENT_SECRET === input.currentKey && environment.COMMUNITY_ACCOUNT_LIFECYCLE_ENABLED === "true");
  const modules = await (options.load ?? deployedCommunity)(), { env } = modules.configured;
  demand(env.COMMUNITY_ACCOUNT_LIFECYCLE_ENABLED === true && env.COMMUNITY_MEMBER_JWT_CURRENT_SECRET === input.currentKey
    && modules.configured.resolveAccountLifecycleRuntime(env) !== null);
  const verifier = modules.createCommunityUserVerifier(modules.configured.resolveCommunityUserRuntime(env));
  const token = signProbeToken(claims("community-member", input.subject), input.currentKey), principal = verifier.verifyMember("Bearer " + token);
  demand(principal?.kind === "member" && principal.claims.sub === input.subject);
  const { Client } = modules.require("pg"), { drizzle } = modules.require("drizzle-orm/node-postgres");
  const url = new URL(env.DATABASE_URL), target = input.target;
  demand(url.hostname === target.host && Number(url.port || 5432) === target.port && decodeURIComponent(url.username) === target.runtimeRole
    && url.pathname === "/" + target.database && url.searchParams.get("sslmode") === "verify-full");
  const client = new Client({ connectionString: url.href, options: "-c search_path=pg_catalog,public -c default_transaction_read_only=on" });
  let began = false;
  try {
    await client.connect(); demand(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); began = true;
    const identity = (await client.query(`SELECT current_user AS role,current_user::regrole::oid::text AS oid,pg_catalog.current_database() AS database,
      (pg_catalog.current_setting('server_version_num')::int/10000)::int AS major,pg_catalog.current_setting('transaction_read_only') AS read_only`)).rows[0];
    demand(identity?.role === target.runtimeRole && identity.oid === target.runtimeRoleOid && identity.database === target.database && identity.major === target.serverMajor && identity.read_only === "on");
    const repository = modules.createAccountLifecycleRepository(drizzle(client)), headers = {}, hooks = [];
    demand(await repository.isActive(input.subject) === false);
    let reads = 0;
    modules.registerCommunityUserAuth({ decorateRequest() {}, addHook(name, callback) { demand(name === "onRequest"); hooks.push(callback); } }, verifier,
      { isActive: async subject => { demand(subject === input.subject); reads++; return repository.isActive(subject); } });
    demand(hooks.length === 1);
    const request = { routeOptions: { config: { communityAuth: "member" } }, headers: { authorization: "Bearer " + token }, communityPrincipal: null };
    let refusal;
    try { await hooks[0](request, { header(name, value) { headers[name] = value; } }); } catch (error) { refusal = error; }
    demand(refusal?.statusCode === 403 && refusal.code === "forbidden" && reads === 1 && request.communityPrincipal === null && headers["cache-control"] === "private, no-store");
    return { version: 1, status: "P2_LIFECYCLE_RECEIVER_DENIAL_OBSERVED", bindingSha256: input.bindingSha256, service: "community",
      evidenceClass: "deployed-private-community-account-access-guard", httpStatus: null, denialStatusCode: 403, errorCode: "forbidden",
      observedAt: new Date().toISOString(), freshCurrentToken: true, configuredVerifierVerified: true, actualRepositoryRead: true,
      actualGuardInvoked: true, accountRestrictionVerified: true, readOnlyDatabase: true, tokenBytesOutput: false, releaseAccepted: false };
  } finally { if (began) try { await client.query("ROLLBACK"); } catch {} await client.end(); }
}

export async function runPrivateReceiverDenialFromStdin() {
  let count = 0; const chunks = [];
  try {
    for await (const chunk of process.stdin) { count += chunk.length; demand(count <= 65536); chunks.push(chunk); }
    const input = validateP2ReceiverDenialInput(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const value = input.mode === "course-http" ? await observeCourseSuspensionDenial(input) : await observeCommunitySuspensionDenial(input);
    process.stdout.write(JSON.stringify(value) + "\n");
  } catch { process.stdout.write(JSON.stringify({ version: 1, status: "P2_LIFECYCLE_RECEIVER_DENIAL_REFUSED", tokenBytesOutput: false, releaseAccepted: false }) + "\n"); process.exitCode = 1; }
}
