import * as receiverCrypto from "node:crypto";
import { readFileSync as receiverReadFile } from "node:fs";
import { request as receiverHttpsRequest } from "node:https";
import { validateP2LifecycleStateWitness, p2LifecycleStateWitnessSha256 } from "./p2-lifecycle-state-witness.mjs";

const receiverUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const receiverSha = /^[a-f0-9]{64}$/u;
const receiverCases = Object.freeze(["exact-replay", "changed-replay", "stale-restore", "future-gap"]);
const receiverPostFields = ["version", "mode", "environment", "service", "case", "bindingSha256", "witness", "freshCommandId", "secret",
  "gatewayConfigurationSha256", "gatewayCaSha256"];
const receiverRuntimeFields = ["version", "mode", "environment", "service", "bindingSha256", "runtimeEnvironment"];
const canonicalCommandFields = ["version", "commandId", "userId", "accountVersion", "action", "issuedAt"];
const receiverClosed = (value, names) => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort()));
const receiverHash = value => receiverCrypto.createHash("sha256").update(value).digest("hex");
const receiverCanonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
export class P2LifecycleReceiverError extends Error {
  constructor(check) { super("P2_LIFECYCLE_RECEIVER_REFUSED"); this.check = check; }
}
const receiverDemand = (condition, check) => { if (!condition) throw new P2LifecycleReceiverError(check); };

async function loadProfiledReceiverProtocol(expectedProfile) {
  const { decodeQualificationTargetJson, requireQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE } =
    await import("./qualification-target-profile.mjs");
  const profile = requireQualificationTargetProfile(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, {
    qualificationTargetProfile: expectedProfile,
  });
  return { profile, decode: raw => decodeQualificationTargetJson(raw, "private-packet"),
    verify: input => requireQualificationTargetProfile(profile, input) };
}

const receiverVersionFields = protocol => protocol ? { version: 2, qualificationTargetProfile: protocol.profile } : { version: 1 };
const receiverEnvelope = (input, fields, protocol) => {
  protocol?.verify(input);
  return receiverClosed(input, protocol ? [...fields, "qualificationTargetProfile"] : fields) && input.version === (protocol ? 2 : 1);
};
const profiledReceiverDigest = value => typeof value === "string" && receiverSha.test(value) && value !== "0".repeat(64);

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

function deriveReceiverPostEnvelope(input, protocol, allowFutureGap = false) {
  receiverDemand(receiverEnvelope(input, receiverPostFields, protocol) && input.environment === "staging"
    && input.mode === "post"
    && ["course", "community"].includes(input.service) && receiverSha.test(input.bindingSha256)
    && receiverSha.test(input.gatewayConfigurationSha256) && receiverSha.test(input.gatewayCaSha256)
    && (!protocol || ([input.bindingSha256, input.gatewayConfigurationSha256, input.gatewayCaSha256].every(profiledReceiverDigest)
      && (input.freshCommandId === null || typeof input.freshCommandId === "string")))
    && typeof input.secret === "string" && Buffer.byteLength(input.secret) >= 32 && Buffer.byteLength(input.secret) <= 8192, "private-input-shape");
  receiverDemand(allowFutureGap || input.case !== "future-gap", "live-future-gap-quiescence-unproved");
  return deriveReceiverNegativeCommand(input.witness, input.case, input.freshCommandId);
}

export function validateReceiverPostInput(input) {
  deriveReceiverPostEnvelope(input);
  return input;
}

export async function deriveProfiledReceiverPostCommand(input, expectedProfile) {
  return deriveReceiverPostEnvelope(input, await loadProfiledReceiverProtocol(expectedProfile), true);
}

function verifyReceiverRuntime(input, environment, protocol) {
  receiverDemand(receiverEnvelope(input, receiverRuntimeFields, protocol) && input.mode === "runtime-binding" && input.environment === "staging"
    && ["course", "community"].includes(input.service) && receiverSha.test(input.bindingSha256)
    && input.runtimeEnvironment?.DATABASE_TARGET === "staging" && typeof input.runtimeEnvironment.STAGING_DATABASE_URL === "string"
    && (!protocol || (profiledReceiverDigest(input.bindingSha256)
      && Object.values(input.runtimeEnvironment).every(value => typeof value === "string")))
    && environment.DATABASE_TARGET === "staging" && environment.NODE_ENV === "production", "running-staging-runtime-required");
  const overrides = new Set(["NODE_ENV", "NODE_OPTIONS", "PORT", "HTTP_BIND_ADDRESS", "INTERNAL_SERVICE_TRUSTED_PROXY_CIDRS",
    "INTERNAL_SERVICE_ALLOWED_IPS", "COURSE_COMMUNITY_READ_ALLOWED_IPS", "INTERNAL_TRUSTED_PROXY_CIDRS"]);
  receiverDemand(Object.entries(input.runtimeEnvironment).every(([key, value]) => overrides.has(key) || environment[key] === value), "running-runtime-configuration");
  const key = input.service.toUpperCase() + "_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET";
  receiverDemand(typeof environment[key] === "string" && Buffer.byteLength(environment[key]) >= 32
    && environment[key] === input.runtimeEnvironment[key], "running-dedicated-lifecycle-key");
  return { ...receiverVersionFields(protocol), status: "P2_LIFECYCLE_RECEIVER_RUNTIME_BOUND", service: input.service, bindingSha256: input.bindingSha256,
    runtimeConfigurationVerified: true, globallyReadOnly: true, releaseAccepted: false };
}

export function verifyLifecycleReceiverRuntime(input, environment = process.env) {
  return verifyReceiverRuntime(input, environment);
}

function receiverToken(service, secret) {
  const now = Math.floor(Date.now() / 1000);
  const encoded = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = encoded({ alg: "HS256", typ: "JWT" }) + "." + encoded({ iss: "lash-her-frontend", aud: `lash-her-${service}-api:account-lifecycle`,
    sub: "frontend-account-lifecycle", iat: now, exp: now + 120, jti: receiverCrypto.randomUUID() });
  return unsigned + "." + receiverCrypto.createHmac("sha256", secret).update(unsigned).digest("base64url");
}

export function createReceiverPrivateTlsPost(ca, makeRequest = receiverHttpsRequest) {
  return async (service, wire, token) => {
    const guarded = wire?.version === 2;
    const command = guarded ? wire.command : wire;
    receiverDemand(["course", "community"].includes(service) && receiverClosed(command, canonicalCommandFields)
      && command.version === 1 && (!guarded || (receiverClosed(wire, ["version", "command", "expectedHead"])
        && receiverClosed(wire.expectedHead, ["accountVersion", "commandId", "canonicalSha256"]))), "fixed-private-receiver-required");
    const body = Buffer.from(receiverCanonical(wire));
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

async function sendReceiverNegative(input, command, options, protocol) {
  const gateway = (options.readGateway ?? (() => receiverReadFile("/config/gateway.json")))();
  const ca = (options.readCa ?? (() => receiverReadFile("/tls/ca.pem")))();
  receiverDemand(receiverHash(gateway) === input.gatewayConfigurationSha256 && receiverHash(ca) === input.gatewayCaSha256, "private-gateway-configuration-changed");
  const config = JSON.parse(gateway.toString());
  receiverDemand(config.appEnv === "staging" && config.courseOrigin === "https://course-tls:8443"
    && config.communityOrigin === "https://community-tls:8443" && config.upstreamCaFile === "/tls/ca.pem", "fixed-private-origins-required");
  let wire = command;
  if (input.case === "future-gap") {
    // This envelope is deliberately incompatible with a receiver that only
    // accepts v1. Sending the inner command by itself could mutate a newer head.
    const { accountVersion, commandId, canonicalSha256 } = input.witness.command;
    wire = { version: 2, command, expectedHead: { accountVersion, commandId, canonicalSha256 } };
  }
  const result = await (options.post ?? createReceiverPrivateTlsPost(ca))(input.service, wire, receiverToken(input.service, input.secret));
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
  return { ...receiverVersionFields(protocol), status: "P2_LIFECYCLE_RECEIVER_CASE_PASS", service: input.service, case: input.case,
    bindingSha256: input.bindingSha256, witnessSha256: p2LifecycleStateWitnessSha256(input.witness), httpStatus: result.status,
    result: expectedStatus === 200 ? "duplicate" : rawCode, domainStatePreservationRequiresReadback: true,
    globallyReadOnly: false, oidcVerified: false, releaseAccepted: false };
}

export async function postReceiverNegative(input, options = {}) {
  return sendReceiverNegative(input, deriveReceiverPostEnvelope(input), options);
}

function postProfiledReceiverCommand(input, protocol, guardedFutureGap = false) {
  receiverDemand(typeof guardedFutureGap === "boolean", "guarded-future-gap-profile-required");
  return sendReceiverNegative(input, deriveReceiverPostEnvelope(input, protocol, guardedFutureGap), {}, protocol);
}

export async function postProfiledReceiverNegative(input, expectedProfile, guardedFutureGap = false) {
  return postProfiledReceiverCommand(input, await loadProfiledReceiverProtocol(expectedProfile), guardedFutureGap);
}

export async function runPrivateReceiverPostFromStdin(expectedProfile, guardedFutureGap = false) {
  let protocol;
  try {
    if (expectedProfile !== undefined) protocol = await loadProfiledReceiverProtocol(expectedProfile);
    receiverDemand(guardedFutureGap === false || guardedFutureGap === true && protocol !== undefined, "guarded-future-gap-profile-required");
    let bytes = 0; const chunks = [];
    for await (const chunk of process.stdin) { bytes += chunk.length; receiverDemand(bytes <= 262144, "private-input-bound"); chunks.push(chunk); }
    const raw = Buffer.concat(chunks);
    const input = protocol ? protocol.decode(raw) : JSON.parse(raw.toString("utf8"));
    try {
      const result = input.mode === "runtime-binding" ? verifyReceiverRuntime(input, process.env, protocol)
        : await (protocol ? postProfiledReceiverCommand(input, protocol, guardedFutureGap) : postReceiverNegative(input));
      process.stdout.write(JSON.stringify(result) + "\n");
    } finally {
      if (input?.secret) input.secret = "";
    }
  } catch (error) {
    const check = error instanceof P2LifecycleReceiverError ? error.check : "private-receiver-case-failed";
    process.stdout.write(JSON.stringify({ ...receiverVersionFields(protocol), status: "P2_LIFECYCLE_RECEIVER_CASE_FAILED", check,
      globallyReadOnly: false, oidcVerified: false, releaseAccepted: false }) + "\n");
    process.exitCode = 1;
  }
}
