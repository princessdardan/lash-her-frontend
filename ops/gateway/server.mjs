import { randomUUID, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request as httpsRequest, Agent } from "node:https";
import { pathToFileURL } from "node:url";
import { createWorkloadVerifier } from "./oidc.mjs";
import { matchRoute, MinuteBudget, validateConfig } from "./policy.mjs";
import { createOperationsServer } from "./operations.mjs";
import {
  admissionClass, createAdmissionReader, isScopedMuxRoute, scopedMuxAcknowledged, scopedMuxTarget,
  SCOPED_MUX_BODY_LIMIT, SCOPED_MUX_HEADER,
} from "./admission.mjs";
import { createP2CertificationFault } from "./p2-certification-fault.mjs";

const MAX_BODY = 1024 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
const REQUEST_HEADERS = new Set(["accept", "authorization", "content-type", "x-idempotency-key", "mux-signature"]);
const RESPONSE_HEADERS = new Set(["content-type", "retry-after"]);

export function createGateway(input, options = {}) {
  const config = validateConfig(input);
  const verify = options.verify ?? createWorkloadVerifier(config);
  const certification = (options.certificationFault ?? createP2CertificationFault)(config);
  const currentAdmission = createAdmissionReader(config, options.scopedMuxAdmission);
  const budgets = new MinuteBudget(options.limits ?? {
    preauth: 2400, webhook: 600, workload: 1200, service: 600,
  });
  const agent = new Agent({
    ca: readFileSync(config.upstreamCaFile), rejectUnauthorized: true,
    keepAlive: true, maxSockets: 32, maxFreeSockets: 4,
  });
  let active = 0;
  const admitted = { newWork: 0, recovery: 0 };
  const uncertain = { newWork: 0, recovery: 0 };
  const counters = { requests: 0, rejected: 0, upstream_failures: 0 };
  const server = createServer({
    key: readFileSync(config.tlsKeyFile), cert: readFileSync(config.tlsCertFile),
    minVersion: "TLSv1.2", maxHeaderSize: 24 * 1024,
    headersTimeout: 5000, requestTimeout: 10_000, connectionsCheckingInterval: 1000,
  }, (req, res) => {
    const requestId = randomUUID();
    let admissionCategory, uncertaintyRecorded = false;
    const markUncertain = () => {
      if (admissionCategory && !uncertaintyRecorded) {
        uncertain[admissionCategory]++;
        uncertaintyRecorded = true;
      }
    };
    res.setHeader("x-request-id", requestId);
    res.setHeader("cache-control", "no-store");
    counters.requests++;
    if (active >= 64) return refuse(503, "unavailable");
    active++;
    const timer = setTimeout(() => { req.destroy(); res.destroy(); }, 12_000);
    res.once("close", () => { active--; clearTimeout(timer); });
    void handle().catch(() => { if (!res.headersSent && !res.destroyed) refuse(502, "upstream_unavailable"); else res.destroy(); });

    function refuse(status, code, retryAfter) {
      counters.rejected++;
      if (retryAfter) res.setHeader("retry-after", retryAfter);
      res.writeHead(status, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: { code, message: code.replaceAll("_", " ") }, requestId }));
    }

    function accountAdmission(category) {
      admitted[category]++;
      admissionCategory = category;
      res.once("close", () => {
        admitted[category]--;
        // A dropped response does not prove the upstream transaction stopped.
        if (!res.writableFinished) markUncertain();
      });
    }

    async function handle() {
      // Reject repeats before Node's normalized header map can discard them.
      const names = new Set();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i].toLowerCase();
        if (names.has(name)) return refuse(400, "ambiguous_headers");
        names.add(name);
      }
      if (req.headers.host !== config.publicHost || (req.socket.servername && req.socket.servername !== config.publicHost.split(":")[0])) return refuse(421, "invalid_host");
      const route = matchRoute(req.method, req.url);
      if (!route) return refuse(404, "route_not_allowed");
      const service = route.service ?? "course";
      const upstreamOrigin = service === "community" ? config.communityOrigin : config.courseOrigin;
      if (!upstreamOrigin) return refuse(503, "upstream_unavailable");
      const retry = budgets.consume(route.auth === "webhook" ? "webhook" : "preauth");
      if (retry) return refuse(429, "rate_limit_exceeded", retry);
      if (route.auth !== "webhook") {
        try { await verify(req.headers["x-lash-workload-token"]); }
        catch { return refuse(401, "invalid_workload"); }
        if (route.auth === "application" && (typeof req.headers.authorization !== "string" || !/^Bearer [A-Za-z0-9._~-]+$/u.test(req.headers.authorization))) return refuse(401, "application_authorization_required");
        const retry = budgets.consume(route.path.startsWith("/v1/internal/") ? "service" : "workload");
        if (retry) return refuse(429, "rate_limit_exceeded", retry);
      }
      const category = admissionClass(route);
      let muxAdmission;
      if (category && config.admission !== undefined) {
        const admission = currentAdmission();
        if (admission[category]) accountAdmission(category);
        else if (category === "recovery" && admission.muxCallback && isScopedMuxRoute(route, req.url)) muxAdmission = admission;
        else return refuse(503, "release_maintenance", 30);
      } else if (config.admission === undefined && config.maintenance === true && req.method !== "GET" && route.auth !== "webhook") {
        return refuse(503, "release_maintenance", 30);
      }
      // Raw bytes are buffered only within a fixed bound; Mux signs these bytes.
      const bodyLimit = muxAdmission ? SCOPED_MUX_BODY_LIMIT : MAX_BODY;
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > bodyLimit) return refuse(413, "body_too_large");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if ((req.method === "GET" || req.method === "HEAD") && body.length) return refuse(400, "body_not_allowed");
      let muxTarget;
      if (muxAdmission) {
        const current = currentAdmission();
        if (res.destroyed || current.sha256 !== muxAdmission.sha256) return refuse(503, "release_maintenance", 30);
        muxTarget = scopedMuxTarget(current.muxCallback, body, req.headers["mux-signature"]);
        if (!muxTarget) return refuse(503, "release_maintenance", 30);
        // Recheck the exact state after the body await. Account only a selected
        // upstream operation, so rejecting a foreign callback cannot dirty drain.
        accountAdmission("recovery");
      }
      const fault = certification.select({ route, method: req.method, target: req.url, headers: req.headers, body });
      if (certification.beforeUpstream(fault, res, () => refuse(503, "upstream_unavailable", 1))) return;
      const headers = { "x-request-id": requestId, "content-length": String(body.length) };
      for (const [name, value] of Object.entries(req.headers)) {
        if (REQUEST_HEADERS.has(name) && typeof value === "string") headers[name] = value;
      }
      if (route.auth !== "webhook") delete headers["mux-signature"];
      else delete headers.authorization;
      if (muxTarget) headers[SCOPED_MUX_HEADER] = muxTarget;
      const upstream = new URL(upstreamOrigin);
      await new Promise((resolve) => {
        const call = httpsRequest(upstream, {
          agent, method: req.method, path: req.url.slice(service.length + 1), headers,
          timeout: 5000,
        }, (reply) => {
          const result = [];
          let length = 0;
          reply.on("data", (chunk) => {
            length += chunk.length;
            if (length > MAX_RESPONSE) reply.destroy(new Error("Response limit exceeded"));
            else result.push(chunk);
          });
          reply.once("end", () => {
            if (res.destroyed) return resolve();
            const buffered = Buffer.concat(result);
            if (muxAdmission && !scopedMuxAcknowledged(muxAdmission.muxCallback, reply.statusCode, buffered)) markUncertain();
            // The complete upstream ACK must be checked before any downstream
            // status, headers or bytes. A deliberate drop retains uncertainty
            // through the existing admitted-request close accounting.
            if (certification.afterUpstream(fault, { status: reply.statusCode, body: buffered }, res)) return resolve();
            // Redirects must never expose internal locations or relay credentials.
            if ((reply.statusCode ?? 502) >= 300 && (reply.statusCode ?? 502) < 400) refuse(502, "upstream_redirect_refused");
            else {
              for (const [name, value] of Object.entries(reply.headers)) {
                if (RESPONSE_HEADERS.has(name) && typeof value === "string") res.setHeader(name, value);
              }
              res.writeHead(reply.statusCode ?? 502);
              res.end(buffered);
            }
            resolve();
          });
          reply.once("error", failed);
        });
        const cancel = () => call.destroy();
        res.once("close", cancel);
        call.once("close", () => res.off("close", cancel));
        call.once("timeout", () => call.destroy(new Error("Upstream deadline")));
        call.once("error", failed);
        call.end(body);
        function failed() {
          markUncertain();
          counters.upstream_failures++;
          if (!res.destroyed && !res.headersSent) refuse(502, "upstream_unavailable");
          resolve();
        }
      });
    }
  });
  server.maxConnections = 128;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.on("checkContinue", (_req, res) => { res.writeHead(417, { connection: "close" }); res.end(); });
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("close", () => agent.destroy());
  return { server, counters, admissionState: () => {
    const { muxCallback, ...state } = config.admission === undefined
      ? { valid: false, newWork: false, recovery: false } : currentAdmission();
    // Older release readers require the ordinary admission flags. A scoped
    // window cannot be used as evidence that ordinary admission is closed.
    const scoped = muxCallback ? { valid: false, newWork: null, recovery: null, muxCallbackActive: true } : {};
    return { ...state, ...scoped, active: { ...admitted }, uncertain: { ...uncertain } };
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configPath = process.env.GATEWAY_CONFIG_FILE;
  if (!configPath) throw new Error("GATEWAY_CONFIG_FILE is required");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const { server, counters, admissionState } = createGateway(config);
  const certificate = new X509Certificate(readFileSync(config.tlsCertFile));
  const operations = createOperationsServer(counters, { tls_not_after_seconds: Date.parse(certificate.validTo) / 1000 }, admissionState);
  operations.listen(9100, "0.0.0.0");
  server.listen(8443, "0.0.0.0");
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
    operations.close();
    server.close(() => { process.exitCode = 0; });
    setTimeout(() => server.closeAllConnections(), 10_000).unref();
  });
}
