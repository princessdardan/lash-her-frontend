import * as receiverCrypto from "node:crypto";
import { readFileSync as receiverReadFile } from "node:fs";
import { request as receiverHttpsRequest } from "node:https";
import { validateP2LifecycleStateWitness, p2LifecycleStateWitnessSha256 } from "./p2-lifecycle-state-witness.mjs";

const receiverUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const receiverSha = /^[a-f0-9]{64}$/u;
const receiverCases = Object.freeze(["exact-replay", "changed-replay", "stale-restore", "future-gap"]);
const receiverClosed = (value, names) => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort()));
const receiverHash = value => receiverCrypto.createHash("sha256").update(value).digest("hex");
const receiverCanonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
export class P2LifecycleReceiverError extends Error {
  constructor(check) { super("P2_LIFECYCLE_RECEIVER_REFUSED"); this.check = check; }
}
const receiverDemand = (condition, check) => { if (!condition) throw new P2LifecycleReceiverError(check); };

export function assertReceiverNegativeBaseline(value) {
  const witness = validateP2LifecycleStateWitness(value), command = witness.command, frontend = witness.frontend;
  receiverDemand(witness.profile === "lifecycle-account-v1" && command.action === "suspend"
    && frontend.status === "suspended" && frontend.latestCommandId === command.commandId
    && frontend.laterCommandCount === 0 && frontend.pendingOrDeliveringCount === 0
    && frontend.deliveries.every(row => row.status === "acknowledged" && row.leaseId === null && row.leaseUntil === null && row.acknowledgedAt !== null)
    && Object.values(witness.receivers).every(row => row.status === "suspended" && row.latestCommandId === command.commandId), "suspended-head-both-acknowledged");
  const canonical = { version: 1, commandId: command.commandId, userId: witness.userId, accountVersion: command.accountVersion,
    action: command.action, issuedAt: command.issuedAt };
  receiverDemand(receiverHash(receiverCanonical(canonical)) === command.canonicalSha256, "canonical-command-digest");
  return witness;
}

export function deriveReceiverNegativeCommand(witness, caseName, freshCommandId = null) {
  assertReceiverNegativeBaseline(witness);
  receiverDemand(receiverCases.includes(caseName), "fixed-case-required");
  const command = { version: 1, commandId: witness.command.commandId, userId: witness.userId,
    accountVersion: witness.command.accountVersion, action: "suspend", issuedAt: witness.command.issuedAt };
  if (["stale-restore", "future-gap"].includes(caseName)) {
    receiverDemand(receiverUuid.test(freshCommandId) && freshCommandId !== command.commandId, "fresh-command-id-required");
    command.commandId = freshCommandId;
  } else receiverDemand(freshCommandId === null, "unexpected-fresh-command-id");
  if (["changed-replay", "stale-restore"].includes(caseName)) command.action = "restore";
  if (caseName === "future-gap") {
    receiverDemand(command.accountVersion <= Number.MAX_SAFE_INTEGER - 2, "version-space-required");
    command.accountVersion += 2;
  }
  return Object.freeze(command);
}

export function validateReceiverPostInput(input) {
  receiverDemand(receiverClosed(input, ["version", "mode", "environment", "service", "case", "bindingSha256", "witness", "freshCommandId", "secret",
    "gatewayConfigurationSha256", "gatewayCaSha256"]) && input.version === 1 && input.environment === "staging"
    && input.mode === "post"
    && ["course", "community"].includes(input.service) && receiverSha.test(input.bindingSha256)
    && receiverSha.test(input.gatewayConfigurationSha256) && receiverSha.test(input.gatewayCaSha256)
    && typeof input.secret === "string" && Buffer.byteLength(input.secret) >= 32 && Buffer.byteLength(input.secret) <= 8192, "private-input-shape");
  // No serializable caller assertion can establish the live gap's quiescence.
  // Its command derivation remains pure for the exclusive owned fixture only.
  receiverDemand(input.case !== "future-gap", "live-future-gap-quiescence-unproved");
  deriveReceiverNegativeCommand(input.witness, input.case, input.freshCommandId);
  return input;
}

export function verifyLifecycleReceiverRuntime(input, environment = process.env) {
  receiverDemand(receiverClosed(input, ["version", "mode", "environment", "service", "bindingSha256", "runtimeEnvironment"])
    && input.version === 1 && input.mode === "runtime-binding" && input.environment === "staging"
    && ["course", "community"].includes(input.service) && receiverSha.test(input.bindingSha256)
    && input.runtimeEnvironment?.DATABASE_TARGET === "staging" && typeof input.runtimeEnvironment.STAGING_DATABASE_URL === "string"
    && environment.DATABASE_TARGET === "staging" && environment.NODE_ENV === "production", "running-staging-runtime-required");
  const overrides = new Set(["NODE_ENV", "NODE_OPTIONS", "PORT", "HTTP_BIND_ADDRESS", "INTERNAL_SERVICE_TRUSTED_PROXY_CIDRS",
    "INTERNAL_SERVICE_ALLOWED_IPS", "COURSE_COMMUNITY_READ_ALLOWED_IPS", "INTERNAL_TRUSTED_PROXY_CIDRS"]);
  receiverDemand(Object.entries(input.runtimeEnvironment).every(([key, value]) => overrides.has(key) || environment[key] === value), "running-runtime-configuration");
  const key = input.service.toUpperCase() + "_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET";
  receiverDemand(typeof environment[key] === "string" && Buffer.byteLength(environment[key]) >= 32
    && environment[key] === input.runtimeEnvironment[key], "running-dedicated-lifecycle-key");
  return { version: 1, status: "P2_LIFECYCLE_RECEIVER_RUNTIME_BOUND", service: input.service, bindingSha256: input.bindingSha256,
    runtimeConfigurationVerified: true, globallyReadOnly: true, releaseAccepted: false };
}

function receiverToken(service, secret) {
  const now = Math.floor(Date.now() / 1000);
  const encoded = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = encoded({ alg: "HS256", typ: "JWT" }) + "." + encoded({ iss: "lash-her-frontend", aud: `lash-her-${service}-api:account-lifecycle`,
    sub: "frontend-account-lifecycle", iat: now, exp: now + 120, jti: receiverCrypto.randomUUID() });
  return unsigned + "." + receiverCrypto.createHmac("sha256", secret).update(unsigned).digest("base64url");
}

export function createReceiverPrivateTlsPost(ca, makeRequest = receiverHttpsRequest) {
  return async (service, command, token) => {
    receiverDemand(["course", "community"].includes(service) && receiverClosed(command,
      ["version", "commandId", "userId", "accountVersion", "action", "issuedAt"]), "fixed-private-receiver-required");
    const body = Buffer.from(receiverCanonical(command));
    receiverDemand(body.length <= 4096, "command-body-bound");
    return new Promise((resolve, reject) => {
      const request = makeRequest({ protocol: "https:", hostname: service + "-tls", port: 8443, servername: service + "-tls",
        method: "POST", path: "/v1/internal/accounts/commands", ca, rejectUnauthorized: true, minVersion: "TLSv1.2", timeout: 5000,
        headers: { authorization: "Bearer " + token, "content-type": "application/json", "content-length": String(body.length), "x-idempotency-key": command.commandId } }, response => {
        let bytes = 0; const chunks = [];
        response.on("data", chunk => { bytes += chunk.length; if (bytes > 8192) response.destroy(new Error("BOUND")); else chunks.push(chunk); });
        response.once("error", () => reject(new P2LifecycleReceiverError("private-response-failed")));
        response.once("end", () => {
          try { resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
          catch { reject(new P2LifecycleReceiverError("private-response-json")); }
        });
      });
      request.once("timeout", () => request.destroy(new Error("DEADLINE")));
      request.once("error", () => reject(new P2LifecycleReceiverError("private-https-failed")));
      request.end(body);
    });
  };
}

export async function postReceiverNegative(input, options = {}) {
  validateReceiverPostInput(input);
  const gateway = (options.readGateway ?? (() => receiverReadFile("/config/gateway.json")))();
  const ca = (options.readCa ?? (() => receiverReadFile("/tls/ca.pem")))();
  receiverDemand(receiverHash(gateway) === input.gatewayConfigurationSha256 && receiverHash(ca) === input.gatewayCaSha256, "private-gateway-configuration-changed");
  const config = JSON.parse(gateway.toString());
  receiverDemand(config.appEnv === "staging" && config.courseOrigin === "https://course-tls:8443"
    && config.communityOrigin === "https://community-tls:8443" && config.upstreamCaFile === "/tls/ca.pem", "fixed-private-origins-required");
  const command = deriveReceiverNegativeCommand(input.witness, input.case, input.freshCommandId);
  const result = await (options.post ?? createReceiverPrivateTlsPost(ca))(input.service, command, receiverToken(input.service, input.secret));
  receiverDemand(typeof result.headers?.["cache-control"] === "string" && /(?:^|,)\s*private\b/iu.test(result.headers["cache-control"])
    && /(?:^|,)\s*no-store\b/iu.test(result.headers["cache-control"]), "private-no-store-required");
  const expectedStatus = input.case === "exact-replay" ? 200 : 409;
  receiverDemand(result.status === expectedStatus, "exact-http-status-required");
  const rawCode = input.case === "changed-replay" ? "idempotency_conflict" : "account_version_conflict";
  const expectedCode = input.service === "course" ? rawCode.toUpperCase() : rawCode;
  if (expectedStatus === 200) receiverDemand(receiverClosed(result.body, ["commandId", "accountVersion", "status"])
    && result.body.commandId === command.commandId && result.body.accountVersion === command.accountVersion && result.body.status === "duplicate", "exact-duplicate-receipt-required");
  else receiverDemand(receiverClosed(result.body, input.service === "course" ? ["error"] : ["error", "requestId"]) && receiverClosed(result.body.error, ["code", "message"])
    && result.body.error.code === expectedCode && typeof result.body.error.message === "string"
    && (input.service === "course" || typeof result.body.requestId === "string" && result.body.requestId.length <= 200), "exact-conflict-receipt-required");
  return { version: 1, status: "P2_LIFECYCLE_RECEIVER_CASE_PASS", service: input.service, case: input.case,
    bindingSha256: input.bindingSha256, witnessSha256: p2LifecycleStateWitnessSha256(input.witness), httpStatus: result.status,
    result: expectedStatus === 200 ? "duplicate" : rawCode, domainStatePreservationRequiresReadback: true,
    globallyReadOnly: false, oidcVerified: false, releaseAccepted: false };
}

export async function runPrivateReceiverPostFromStdin() {
  try {
    let bytes = 0; const chunks = [];
    for await (const chunk of process.stdin) { bytes += chunk.length; receiverDemand(bytes <= 262144, "private-input-bound"); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = input.mode === "runtime-binding" ? verifyLifecycleReceiverRuntime(input) : await postReceiverNegative(input);
    if (input.secret) input.secret = "";
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    const check = error instanceof P2LifecycleReceiverError ? error.check : "private-receiver-case-failed";
    process.stdout.write(JSON.stringify({ version: 1, status: "P2_LIFECYCLE_RECEIVER_CASE_FAILED", check,
      globallyReadOnly: false, oidcVerified: false, releaseAccepted: false }) + "\n");
    process.exitCode = 1;
  }
}
