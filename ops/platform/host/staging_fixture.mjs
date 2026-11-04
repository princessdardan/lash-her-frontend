// Invoked only inside the existing gateway peer by the reviewed parent. The
// private application token arrives on stdin and is never written to receipts.
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { pathToFileURL } from "node:url";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const demand = (value, code) => { if (!value) throw new Error(code); };

export function validateInput(input, now = Date.now()) {
  demand(input && typeof input === "object" && !Array.isArray(input)
    && Object.keys(input).sort().join(",") === "actionId,actorUserId,applicationToken,environment,nonce,userIds,version"
    && input.version === 1 && input.environment === "staging", "STAGING_FIXTURE_EXACT_INPUT_REQUIRED");
  demand(typeof input.actionId === "string" && /^recovery-fixture-[a-z0-9][a-z0-9-]{0,64}$/u.test(input.actionId)
    && typeof input.nonce === "string" && /^[a-f0-9]{32}$/u.test(input.nonce)
    && uuid.test(input.actorUserId) && Array.isArray(input.userIds) && input.userIds.length === 2
    && input.userIds.every(id => typeof id === "string" && uuid.test(id))
    && new Set([input.actorUserId, ...input.userIds]).size === 3, "STAGING_FIXTURE_SYNTHETIC_IDENTITIES_REQUIRED");
  demand(typeof input.applicationToken === "string" && input.applicationToken.length <= 8192
    && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(input.applicationToken), "STAGING_FIXTURE_PRIVATE_TOKEN_REQUIRED");
  let claims;
  try { claims = JSON.parse(Buffer.from(input.applicationToken.split(".")[1], "base64url")); } catch { /* Static refusal below. */ }
  // This bounds a token minted privately by the parent. The actual Course API
  // still verifies its signature, issuer, audience and administrator authority.
  const seconds = Math.floor(now / 1000);
  demand(claims && claims.sub === input.actorUserId && claims.role === "courseAdmin"
    && Number.isSafeInteger(claims.iat) && Number.isSafeInteger(claims.exp)
    && claims.iat <= seconds && claims.iat >= seconds - 30
    && claims.exp > seconds + 30 && claims.exp <= claims.iat + 300
    && Object.keys(claims).every(key => ["sub", "role", "iat", "exp", "jti", "iss", "aud"].includes(key)),
  "STAGING_FIXTURE_BOUNDED_ADMIN_TOKEN_REQUIRED");
  return { courseSlug: `p1-recovery-${input.nonce}`,
    idempotencyKeys: input.userIds.map((_, index) => `${input.actionId}-${input.nonce}-grant-${index + 1}`) };
}

export async function prepareFixture(input, { call, onProgress = () => {}, now = Date.now } = {}) {
  const { courseSlug, idempotencyKeys } = validateInput(input, now());
  demand(typeof call === "function" && typeof onProgress === "function", "STAGING_FIXTURE_TRUSTED_CALLER_REQUIRED");
  const base = { actionId: input.actionId, environment: "staging", publicGatewayWritesAdmitted: false,
    migrationsExecuted: false, applicationAuthorizationVerifiedBy: "existing-course-api" };
  // Three deliberate calls, no retries. The parent persists its exclusive
  // intent before invoking this component and retains each sanitized progress
  // record if a later call fails. A course-create response loss needs review.
  const created = await call("POST", "/v1/admin/courses", input.applicationToken,
    { slug: courseSlug, title: "P1 staging recovery fixture", description: "Non-customer staging fixture",
      status: "draft", priceCents: 0, currency: "CAD" });
  demand(created.status === 201 && uuid.test(created.body?.course?.id)
    && created.body.course.slug === courseSlug && created.body.course.status === "draft",
  "STAGING_FIXTURE_COURSE_CREATION_UNVERIFIED");
  const courseId = created.body.course.id;
  onProgress({ ...base, status: "STAGING_FIXTURE_DRAFT_CREATED", courseId, courseSlug });
  const grants = [];
  for (let index = 0; index < input.userIds.length; index++) {
    const userId = input.userIds[index], idempotencyKey = idempotencyKeys[index];
    const response = await call("POST", "/v1/admin/entitlements/grants", input.applicationToken,
      { userId, courseId, reason: `P1 non-customer recovery qualification ${input.actionId}`, idempotencyKey }, idempotencyKey);
    const body = response.body;
    demand(response.status === 201 && body?.action === "grant" && body.outcome === "applied"
      && body.actorUserId === input.actorUserId && body.userId === userId && body.courseId === courseId
      && uuid.test(body.commandId) && body.affectedGrantCount === 1 && body.idempotentReplay !== true
      && Array.isArray(body.effects) && body.effects.length === 1
      && uuid.test(body.effects[0].grantId) && body.effects[0].effectType === "grant_created"
      && body.effects[0].resultingStatus === "active", "STAGING_FIXTURE_AUDITED_GRANT_UNVERIFIED");
    const grant = { userId, commandId: body.commandId, grantId: body.effects[0].grantId, idempotencyKey };
    grants.push(grant);
    onProgress({ ...base, status: "STAGING_FIXTURE_GRANT_CREATED", courseId, courseSlug, ...grant });
  }
  return { ...base, status: "STAGING_FIXTURE_TWO_GRANTS_CREATED", courseId, courseSlug, grants,
    syntheticIdentitiesOnly: true, coursePublished: false, publicRoutesAdded: false };
}

export function privateTlsCaller(ca) {
  return (method, path, token, body, idempotencyKey) => new Promise((resolve, reject) => {
    // No caller-controlled origin, redirect handling or proxy environment.
    if (method !== "POST" || !["/v1/admin/courses", "/v1/admin/entitlements/grants"].includes(path)) {
      reject(new Error("STAGING_FIXTURE_ROUTE_REFUSED")); return;
    }
    const payload = JSON.stringify(body);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) };
    if (idempotencyKey) headers["x-idempotency-key"] = idempotencyKey;
    const call = request(new URL(path, "https://course-tls:8443"), { method, headers, ca,
      minVersion: "TLSv1.2", rejectUnauthorized: true, timeout: 5000 }, response => {
      const chunks = []; let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 32768) call.destroy(new Error("STAGING_FIXTURE_RESPONSE_BOUND_EXCEEDED"));
        else chunks.push(chunk);
      });
      response.once("end", () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); }
        catch { reject(new Error("STAGING_FIXTURE_RESPONSE_REFUSED")); }
      });
      response.once("error", () => reject(new Error("STAGING_FIXTURE_TRANSPORT_FAILED")));
    });
    call.once("timeout", () => call.destroy(new Error("STAGING_FIXTURE_TRANSPORT_FAILED")));
    call.once("error", () => reject(new Error("STAGING_FIXTURE_TRANSPORT_FAILED")));
    call.end(payload);
  });
}

export async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    demand(Buffer.byteLength(raw) <= 16384, "STAGING_FIXTURE_PRIVATE_INPUT_BOUND_REQUIRED");
  }
  const input = JSON.parse(raw);
  validateInput(input);
  const result = await prepareFixture(input, { call: privateTlsCaller(readFileSync("/tls/ca.pem")),
    onProgress: value => process.stdout.write(JSON.stringify(value) + "\n") });
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = /^STAGING_FIXTURE_[A-Z_]+$/u.test(error.message) ? error.message : "STAGING_FIXTURE_EXECUTION_FAILED";
    process.stderr.write(JSON.stringify({ status: "STAGING_FIXTURE_REQUIRES_REVIEW", code }) + "\n");
    process.exitCode = 1;
  });
}
