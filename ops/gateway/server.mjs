import { randomUUID, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request as httpsRequest, Agent } from "node:https";
import { pathToFileURL } from "node:url";
import { createWorkloadVerifier } from "./oidc.mjs";
import { matchRoute, MinuteBudget, validateConfig } from "./policy.mjs";
import { createOperationsServer } from "./operations.mjs";
import {
  admissionClass, createAdmissionReader, isScopedMuxRoute, lessonAssessmentPhasePermits, lessonResumePhasePermits, scopedLessonPositionPhasePermits,
  scopedAssessmentAcknowledged, scopedResumeAcknowledged,
  scopedInteractiveAcknowledged, scopedMuxAcknowledged,
  selectScopedInteractiveRequest, selectScopedMuxCallback, SCOPED_INTERACTIVE_HEADER, SCOPED_MUX_BODY_LIMIT, SCOPED_MUX_HEADER,
} from "./admission.mjs";
import { createP2CertificationFault } from "./p2-certification-fault.mjs";

const MAX_BODY = 1024 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
const MAX_SCOPED_MUX_REQUESTS = 16;
const REQUEST_HEADERS = new Set(["accept", "authorization", "content-type", "x-idempotency-key", "mux-signature"]);
const RESPONSE_HEADERS = new Set(["content-type", "retry-after"]);
const oneShotMuxFence = admission => admission?.muxCallback?.oneShot === true || admission?.muxCallbackActive === false;
const emptyMuxEvidence = () => ({ admitted: 0, managedAcks: [] });

export function createGateway(input, options = {}) {
  const config = validateConfig(input);
  const verify = options.verify ?? createWorkloadVerifier(config);
  const certification = (options.certificationFault ?? createP2CertificationFault)(config);
  const admissionOptions = options.scopedAdmission ?? options.scopedMuxAdmission;
  const readAdmission = createAdmissionReader(config, admissionOptions);
  const admissionNow = admissionOptions?.now ?? Date.now;
  const scopedMuxEvidence = new Map();
  const usedOneShotMuxAttempts = new Set();
  let lastOneShot;
  const currentAdmission = () => {
    if (config.admission === undefined) return undefined;
    const state = readAdmission();
    if (state.muxCallback?.oneShot === true && state.sha256 !== lastOneShot?.scopedStateSha256) {
      lastOneShot = { scopedStateSha256: state.sha256 };
    } else if (lastOneShot && state.valid && state.version === 1 && !state.newWork && !state.recovery) {
      lastOneShot.closedStateSha256 ??= state.sha256;
    }
    return state;
  };
  const scopedInteractiveEvidence = new Map();
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
    let admissionCategory, uncertaintyRecorded = false, scopedRequest = false;
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
    void handle().catch(() => {
      if (scopedRequest) markUncertain();
      if (!res.headersSent && !res.destroyed) refuse(502, "upstream_unavailable");
      else res.destroy();
    });

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
      const scopedMuxRoute = isScopedMuxRoute(route, req.url);
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
      const admission = currentAdmission();
      let muxAdmission, interactiveAdmission;
      if (oneShotMuxFence(admission)) {
        if (!admission.muxCallback || !scopedMuxRoute || req.headers[SCOPED_INTERACTIVE_HEADER] !== undefined) {
          return refuse(503, "release_maintenance", 30);
        }
        muxAdmission = admission;
      } else if (admission?.version === 3 || req.headers[SCOPED_INTERACTIVE_HEADER] !== undefined) {
        if (!admission?.interactive || !admission.interactive.requests.some(row => row.method === req.method && row.target === req.url)) {
          return refuse(503, "release_maintenance", 30);
        }
        interactiveAdmission = admission;
      } else if (category && admission) {
        if (admission[category]) accountAdmission(category);
        else if (category === "recovery" && admission.muxCallback && scopedMuxRoute) muxAdmission = admission;
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
      let muxSelection, muxEvidence;
      let interactiveSelection, interactiveEvidence;
      if (interactiveAdmission) {
        const current = currentAdmission();
        if (res.destroyed || uncertain.newWork !== 0 || uncertain.recovery !== 0 || current.sha256 !== interactiveAdmission.sha256) {
          return refuse(503, "release_maintenance", 30);
        }
        interactiveSelection = selectScopedInteractiveRequest(current.interactive, {
          method: req.method, target: req.url, body, headers: req.headers, now: admissionNow(),
        });
        if (!interactiveSelection) return refuse(503, "release_maintenance", 30);
        const { stage } = current.interactive;
        const assessment = stage === "lesson-assessment";
        const restore = stage === "lesson-restore";
        const exitSave = stage === "lesson-exit-save";
        const phasedPositionSave = ["lesson-ack-loss", "lesson-exit-save", "lesson-visibility-save", "lesson-stale-revision"].includes(stage);
        interactiveEvidence = scopedInteractiveEvidence.get(current.sha256);
        if (!interactiveEvidence) {
          interactiveEvidence = { ids: new Set(), used: new Map(), acknowledged: [], ...(assessment ? { attemptIds: new Set() } : {}) };
          scopedInteractiveEvidence.set(current.sha256, interactiveEvidence);
        }
        const used = interactiveEvidence.used.get(interactiveSelection.requestIndex) ?? 0;
        if (interactiveEvidence.ids.has(interactiveSelection.requestId) || used >= interactiveSelection.uses ||
            (interactiveSelection.mediaReservation &&
              (interactiveSelection.requestIndex !== interactiveEvidence.acknowledged.length ||
                interactiveEvidence.acknowledged.some(row => row.upstreamStatus !== 200))) ||
            (assessment && !lessonAssessmentPhasePermits(interactiveSelection, interactiveEvidence)) ||
            (phasedPositionSave && !scopedLessonPositionPhasePermits(interactiveSelection, interactiveEvidence, stage)) ||
            ((restore || stage === "lesson-resume") && !lessonResumePhasePermits(interactiveSelection, interactiveEvidence, restore))) {
          return refuse(503, "release_maintenance", 30);
        }
        interactiveEvidence.ids.add(interactiveSelection.requestId);
        if (interactiveSelection.attemptRequestId) interactiveEvidence.attemptIds.add(interactiveSelection.attemptRequestId);
        interactiveEvidence.used.set(interactiveSelection.requestIndex, used + 1);
        if (exitSave && interactiveSelection.requestIndex === 8) {
          interactiveEvidence.exitRequestedPosition = interactiveSelection.resumePosition.resumePositionSeconds;
        }
        scopedRequest = true;
        // Catalog, playback and other scoped GETs are part of the same drain.
        accountAdmission("newWork");
      } else if (admission && !muxAdmission) {
        const current = currentAdmission();
        if (current.version === 3 || oneShotMuxFence(current)) return refuse(503, "release_maintenance", 30);
      }
      const oneShotMux = muxAdmission?.muxCallback.oneShot === true;
      if (muxAdmission) {
        const current = currentAdmission();
        if (res.destroyed || current.sha256 !== muxAdmission.sha256) return refuse(503, "release_maintenance", 30);
        muxSelection = selectScopedMuxCallback(current.muxCallback, body, req.headers["mux-signature"]);
        if (!muxSelection) return refuse(503, "release_maintenance", 30);
        muxEvidence = scopedMuxEvidence.get(current.sha256);
        if (!muxEvidence) {
          muxEvidence = emptyMuxEvidence();
          scopedMuxEvidence.set(current.sha256, muxEvidence);
        }
        if (oneShotMux) {
          const attempt = current.muxCallback.environmentId + ":" + muxSelection.target;
          if (usedOneShotMuxAttempts.has(attempt) || admitted.newWork !== 0 || admitted.recovery !== 0 ||
              uncertain.newWork !== 0 || uncertain.recovery !== 0) return refuse(503, "release_maintenance", 30);
          // Consume before contacting Course. Neither a concurrent callback
          // nor a new scope for this attempt may retry an ambiguous effect.
          usedOneShotMuxAttempts.add(attempt);
          scopedRequest = true;
        } else if (muxEvidence.admitted >= MAX_SCOPED_MUX_REQUESTS) return refuse(503, "release_maintenance", 30);
        muxEvidence.admitted++;
        // Account only a selected upstream operation. Rejecting a foreign
        // callback cannot dirty drain.
        accountAdmission("recovery");
      }
      const fault = interactiveSelection || oneShotMux ? undefined : certification.select({ route, method: req.method, target: req.url, headers: req.headers, body });
      if (certification.beforeUpstream(fault, res, () => refuse(503, "upstream_unavailable", 1))) return;
      const headers = { "x-request-id": requestId, "content-length": String(body.length) };
      for (const [name, value] of Object.entries(req.headers)) {
        if (REQUEST_HEADERS.has(name) && typeof value === "string") headers[name] = value;
      }
      if (route.auth !== "webhook") delete headers["mux-signature"];
      else delete headers.authorization;
      if (muxSelection) headers[SCOPED_MUX_HEADER] = muxSelection.target;
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
            if (muxSelection) {
              const acknowledged = scopedMuxAcknowledged(muxAdmission.muxCallback, reply.statusCode, buffered) &&
                (!oneShotMux || reply.headers["content-type"]?.split(";", 1)[0] === "application/json");
              if (!acknowledged) {
                markUncertain();
                if (oneShotMux) {
                  refuse(502, "upstream_unavailable");
                  return resolve();
                }
              } else if (reply.statusCode === 200) {
                muxEvidence.managedAcks.push({
                  requestId, eventId: muxSelection.eventId, upstreamStatus: 200,
                  ...(oneShotMux ? { assetId: muxSelection.assetId } : {}),
                });
                if (oneShotMux) {
                  const { id, lessonId, status } = JSON.parse(buffered.toString("utf8")).videoAsset;
                  res.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
                  res.end(JSON.stringify({ videoAsset: { id, lessonId, status } }));
                  return resolve();
                }
              }
            }
            if (interactiveSelection) {
              const stage = interactiveAdmission.interactive.stage;
              const scopedPosition = ["lesson-resume", "lesson-restore", "lesson-ack-loss", "lesson-exit-save", "lesson-visibility-save", "lesson-stale-revision"].includes(stage);
              const strictInteractive = scopedPosition || stage === "lesson-denial" || stage === "lesson-assessment" ||
                interactiveSelection.mediaReservation;
              const acknowledged = scopedPosition
                ? scopedResumeAcknowledged(req.url, reply.statusCode, reply.headers["content-type"], buffered,
                  interactiveSelection, interactiveEvidence, interactiveAdmission.interactive, admissionNow())
                : stage === "lesson-assessment"
                ? scopedAssessmentAcknowledged(req.url, reply.statusCode, reply.headers["content-type"], buffered,
                  interactiveSelection, interactiveEvidence, interactiveAdmission.interactive.actorId)
                : scopedInteractiveAcknowledged(route, req.url, reply.statusCode, reply.headers["content-type"], buffered, stage);
              if (!acknowledged) {
                markUncertain();
                if (strictInteractive) {
                  refuse(502, "upstream_unavailable");
                  return resolve();
                }
              } else {
                interactiveEvidence.acknowledged.push({ requestId, proofRequestId: interactiveSelection.requestId,
                  requestIndex: interactiveSelection.requestIndex, upstreamStatus: reply.statusCode });
                if (strictInteractive) {
                  res.writeHead(reply.statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" });
                  res.end(buffered);
                  return resolve();
                }
              }
            }
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
    const { interactive, muxCallback, ...state } = config.admission === undefined
      ? { valid: false, newWork: false, recovery: false } : currentAdmission();
    // Older release readers require the ordinary admission flags. A scoped
    // window cannot be used as evidence that ordinary admission is closed.
    const interactiveEvidence = interactive && scopedInteractiveEvidence.get(state.sha256);
    const scoped = interactive ? { valid: false, newWork: null, recovery: null, interactiveActive: true,
      interactiveEvidence: { admitted: interactiveEvidence?.ids.size ?? 0, acknowledged: structuredClone(interactiveEvidence?.acknowledged ?? []) },
    } : muxCallback ? { valid: false, newWork: null, recovery: null, muxCallbackActive: true,
      muxCallbackEvidence: structuredClone(scopedMuxEvidence.get(state.sha256) ?? emptyMuxEvidence()),
    } : {};
    const final = state.valid && state.version === 1 && state.sha256 === lastOneShot?.closedStateSha256 ?
      { muxCallbackFinal: { scopedStateSha256: lastOneShot.scopedStateSha256,
        ...structuredClone(scopedMuxEvidence.get(lastOneShot.scopedStateSha256) ?? emptyMuxEvidence()) } } : {};
    return { ...state, ...scoped, ...final, active: { ...admitted }, uncertain: { ...uncertain } };
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
