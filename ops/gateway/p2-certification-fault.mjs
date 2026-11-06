// One staging-only source-owned transport fault. No activation HTTP surface.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

export const P2_FAULT_LEASE_FILE = "/admission/p2-certification-fault.json";
export const P2_FAULT_MAX_MILLISECONDS = 120000;
const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,255}$/u;
const STAGING = Object.freeze({ projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM", ownerId: "team_2Hrn5eMZyZxfAWdmYvyKi9t3", publicHost: "api-staging.lashher.com" });
const closed = (value, names) => value && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort());
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
const hash = value => createHash("sha256").update(value).digest("hex");
const demand = condition => { if (!condition) throw new Error("P2_CERTIFICATION_FAULT_REFUSED"); };

export function p2GatewayProcessBinding({ bootId, pid, startTicks }) {
  demand(typeof bootId === "string" && /^[a-f0-9-]{36}$/u.test(bootId) && Number.isSafeInteger(pid) && pid > 0
    && typeof startTicks === "string" && /^[1-9][0-9]{0,29}$/u.test(startTicks));
  return hash(canonical({ bootId, pid, startTicks }));
}
export function readP2GatewayProcessBinding() {
  const text = readFileSync("/proc/self/stat", "utf8"), end = text.lastIndexOf(")");
  demand(end > 0);
  const fields = text.slice(end + 2).trim().split(/\s+/u);
  return p2GatewayProcessBinding({ bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), pid: process.pid, startTicks: fields[19] });
}

function readLease() {
  let descriptor;
  try {
    descriptor = openSync(P2_FAULT_LEASE_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    demand(info.isFile() && info.uid === 0 && info.gid === 65532 && (info.mode & 0o777) === 0o640 && info.size > 0 && info.size <= 8192);
    const raw = readFileSync(descriptor); demand(raw.length <= 8192); return raw;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function parseP2MuxCreatedAt(value) {
  demand(typeof value === "string");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  demand(match);
  const milliseconds = Date.parse(match[1] + match[3]); demand(Number.isFinite(milliseconds));
  return BigInt(milliseconds) * 1000000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}

export function validateP2FaultLease(value, config, processBinding, gatewayConfigurationSha256, now) {
  demand(closed(value, ["version", "environment", "profile", "stageId", "releaseId", "candidateSha256", "configurationSha256", "gatewayConfigurationSha256",
    "gatewayProcessSha256", "gatewayImageSha256", "sourceWitnessSha256", "issuedAt", "expiresAt", "maxMatches", "mode", "receiver", "record"])
    && value.version === 1 && value.environment === "staging" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.stageId)
    && value.releaseId === config.admission.releaseId && value.candidateSha256 === config.admission.candidateSha256
    && value.gatewayProcessSha256 === processBinding && value.gatewayConfigurationSha256 === gatewayConfigurationSha256
    && [value.candidateSha256, value.configurationSha256, value.gatewayConfigurationSha256, value.gatewayImageSha256, value.sourceWitnessSha256].every(item => SHA.test(item))
    && value.maxMatches === 1 && ["503-before-upstream", "drop-after-ack"].includes(value.mode));
  const issued = Date.parse(value.issuedAt), expires = Date.parse(value.expiresAt);
  demand(typeof value.issuedAt === "string" && new Date(issued).toISOString() === value.issuedAt
    && typeof value.expiresAt === "string" && new Date(expires).toISOString() === value.expiresAt
    && expires > issued && expires - issued <= P2_FAULT_MAX_MILLISECONDS && now >= issued && now < expires);
  if (value.profile === "lifecycle-known-command-v1") demand(["course", "community"].includes(value.receiver)
    && closed(value.record, ["commandId", "accountVersion", "canonicalSha256"]) && UUID.test(value.record.commandId)
    && Number.isSafeInteger(value.record.accountVersion) && value.record.accountVersion >= 1 && SHA.test(value.record.canonicalSha256));
  else demand(value.profile === "mux-managed-track-ready-v1" && value.receiver === "course" && value.mode === "drop-after-ack"
    && closed(value.record, ["attemptId", "lessonId", "generation", "environmentId", "assetId", "uploadId", "eventType"])
    && UUID.test(value.record.attemptId) && UUID.test(value.record.lessonId) && Number.isSafeInteger(value.record.generation) && value.record.generation >= 1
    && PROVIDER_ID.test(value.record.environmentId) && PROVIDER_ID.test(value.record.assetId)
    && (value.record.uploadId === null || PROVIDER_ID.test(value.record.uploadId)) && value.record.eventType === "video.asset.track.ready");
  return value;
}

function lifecycleMatch(lease, context) {
  if (context.method !== "POST" || context.target !== `/${lease.receiver}/v1/internal/accounts/commands` || context.route.auth !== "application"
    || context.route.path !== "/v1/internal/accounts/commands" || context.route.admission !== "recovery"
    || (context.route.service ?? "course") !== lease.receiver || context.headers["x-idempotency-key"] !== lease.record.commandId) return null;
  const body = JSON.parse(context.body.toString("utf8"));
  if (!closed(body, ["version", "commandId", "userId", "accountVersion", "action", "issuedAt"]) || body.version !== 1
    || body.commandId !== lease.record.commandId || body.accountVersion !== lease.record.accountVersion || !UUID.test(body.userId)
    || !["suspend", "restore", "export", "delete"].includes(body.action) || hash(canonical(body)) !== lease.record.canonicalSha256) return null;
  return { commandId: body.commandId, accountVersion: body.accountVersion };
}

function muxMatch(lease, context) {
  if (context.method !== "POST" || context.target !== "/course/v1/webhooks/mux" || context.route.auth !== "webhook"
    || context.route.path !== "/v1/webhooks/mux") return null;
  const body = JSON.parse(context.body.toString("utf8")), record = lease.record;
  if (body.type !== record.eventType || !PROVIDER_ID.test(body.id) || body.environment?.id !== record.environmentId
    || body.data?.asset_id !== record.assetId || !PROVIDER_ID.test(body.data?.id)
    || body.data.passthrough !== `lash-her-course:${record.environmentId}:${record.attemptId}`) return null;
  parseP2MuxCreatedAt(body.created_at);
  return { eventId: body.id, eventType: body.type, createdAt: body.created_at, environmentId: record.environmentId,
    objectId: body.data.id, assetId: record.assetId, attemptId: record.attemptId, lessonId: record.lessonId, generation: record.generation };
}

export function createP2CertificationFault(config, options = {}) {
  const selections = new WeakMap(), leases = new Map();
  const now = options.now ?? Date.now, monotonic = options.monotonic ?? (() => process.hrtime.bigint());
  const emit = options.emit ?? (receipt => process.stdout.write(JSON.stringify({ component: "p2-certification-fault", ...receipt }) + "\n"));
  const send = value => { try { emit(value); return true; } catch { return false; } };
  const enabled = config?.appEnv === "staging" && Object.entries(STAGING).every(([key, value]) => config[key] === value)
    && config.admission?.file === "/admission/state.json" && SHA.test(config.admission?.candidateSha256 ?? "");
  let processBinding, configurationSha;
  function select(context) {
    try {
      if (!enabled || !Buffer.isBuffer(context.body) || context.body.length > 65536 || context.method !== "POST"
        || !["/v1/internal/accounts/commands", "/v1/webhooks/mux"].includes(context.route?.path)) return null;
      processBinding ??= (options.processBinding ?? readP2GatewayProcessBinding)();
      configurationSha ??= hash((options.readGateway ?? (() => readFileSync("/config/gateway.json")))());
      const raw = (options.readLease ?? readLease)();
      demand(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= 8192);
      const lease = validateP2FaultLease(JSON.parse(raw.toString("utf8")), config, processBinding, configurationSha, now());
      const leaseSha256 = hash(raw), tick = monotonic();
      let state = leases.get(lease.stageId);
      if (state === undefined) {
        demand(leases.size < 16);
        state = { leaseSha256, used: false, deadline: tick + BigInt(Date.parse(lease.expiresAt) - now()) * 1000000n };
        leases.set(lease.stageId, state);
      }
      demand(state.leaseSha256 === leaseSha256 && tick < state.deadline);
      const matched = lease.profile === "lifecycle-known-command-v1" ? lifecycleMatch(lease, context) : muxMatch(lease, context);
      if (matched === null || state.used && lease.profile === "lifecycle-known-command-v1") return null;
      // Reserve synchronously before the caller can perform upstream I/O. A
      // failed upstream response does not make the one-match fuse reusable.
      const inject = !state.used; state.used = true;
      const token = Object.freeze({});
      selections.set(token, { lease, leaseSha256, matched, inject, deadline: state.deadline, finished: false });
      return token;
    } catch { return null; }
  }
  function receipt(selection, status, fields = {}) {
    return { version: 1, status, environment: "staging", profile: selection.lease.profile, stageId: selection.lease.stageId,
      candidateSha256: selection.lease.candidateSha256, configurationSha256: selection.lease.configurationSha256,
      gatewayProcessSha256: processBinding, gatewayImageSha256: selection.lease.gatewayImageSha256,
      sourceWitnessSha256: selection.lease.sourceWitnessSha256, leaseSha256: selection.leaseSha256,
      mode: selection.lease.mode, receiver: selection.lease.receiver, ...fields };
  }
  function current(token) {
    try {
      const selected = selections.get(token);
      if (!selected || selected.finished || monotonic() >= selected.deadline || now() >= Date.parse(selected.lease.expiresAt)
        || hash((options.readLease ?? readLease)()) !== selected.leaseSha256) return null;
      return selected;
    } catch { return null; }
  }
  return Object.freeze({
    select,
    beforeUpstream(token, response, refuse) {
      const selected = current(token);
      if (!selected || !selected.inject || selected.lease.mode !== "503-before-upstream" || response.headersSent || response.destroyed) return false;
      selected.finished = true;
      refuse();
      if (response.statusCode === 503 && response.headersSent && response.writableEnded) send(receipt(selected, "P2_TRANSPORT_FAULT_INJECTED",
        { upstreamStarted: false, downstreamDisposition: "503", upstreamReceiptVerified: false }));
      return true;
    },
    afterUpstream(token, upstream, response) {
      const selected = current(token);
      if (!selected || upstream.status !== 200 || !Buffer.isBuffer(upstream.body) || upstream.body.length > 4096) return false;
      let body;
      try { body = JSON.parse(upstream.body.toString("utf8")); } catch { return false; }
      if (selected.lease.profile === "lifecycle-known-command-v1") {
        if (!closed(body, ["commandId", "accountVersion", "status"]) || body.commandId !== selected.matched.commandId
          || body.accountVersion !== selected.matched.accountVersion || !["accepted", "duplicate"].includes(body.status)) return false;
      } else if (!closed(body, ["videoAsset"]) || !closed(body.videoAsset, ["id", "lessonId", "status"])
        || body.videoAsset.id !== selected.matched.attemptId || body.videoAsset.lessonId !== selected.matched.lessonId
        || !["pending", "uploading", "processing", "ready", "errored"].includes(body.videoAsset.status)) return false;
      selected.finished = true;
      const beforeDownstream = !response.headersSent && !response.writableEnded && !response.destroyed;
      if (selected.lease.profile === "mux-managed-track-ready-v1" && !send(receipt(selected, "P2_MUX_VERIFIED_INGRESS_OBSERVED",
        { ...selected.matched, receivedAt: new Date(now()).toISOString(), monotonicNanoseconds: monotonic().toString(), upstreamStatus: 200,
          managedResponse: body.videoAsset, downstreamBytesStarted: !beforeDownstream, sourceManagedRowJoinRequired: true }))) return false;
      if (!selected.inject || selected.lease.mode !== "drop-after-ack" || !beforeDownstream) return false;
      response.destroy();
      if (response.destroyed) send(receipt(selected, "P2_TRANSPORT_FAULT_INJECTED", { upstreamStarted: true, upstreamReceiptVerified: true,
        upstreamStatus: 200, downstreamDisposition: "dropped-before-any-response-bytes", downstreamBytesStarted: false,
        ...(selected.lease.profile === "mux-managed-track-ready-v1" ? { eventId: selected.matched.eventId } : {}) }));
      return true;
    },
  });
}
