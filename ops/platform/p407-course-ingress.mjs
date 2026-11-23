import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { request as requestTls } from "node:https";
import { pathToFileURL } from "node:url";

const host = "api-p407.lashher.com";
const prefix = "/course/v1/internal/";
const proofHeader = "x-lash-p407-course-proof";
const grant = `${prefix}entitlements/grants`;
const revoke = `${prefix}entitlements/revocations`;
const maxBody = 4096;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// Forward only the three candidate Course operations, keeping gateway OIDC,
// application authorization and TLS verification in their established paths.
export function createP407CourseIngress(scope, upstream = requestTls, now = Date.now) {
  if (!scope || ![scope.customerId, scope.courseId, scope.orderId].every(id => typeof id === "string" && uuid.test(id)) ||
      !/^[0-9a-f]{64}$/u.test(scope.proofSha256 ?? "") || /^0+$/u.test(scope.proofSha256) ||
      typeof scope.expiresAt !== "string" || new Date(scope.expiresAt).toISOString() !== scope.expiresAt)
    throw new Error("P4-07 Course ingress binding refused");
  const proofDigest = Buffer.from(scope.proofSha256, "hex");
  const expiresAt = Date.parse(scope.expiresAt);
  const offer = `${prefix}checkout-offer?userId=${scope.customerId}&courseId=${scope.courseId}`;
  return createServer({ maxHeaderSize: 32 * 1024, requestTimeout: 8_000 }, async (req, res) => {
    const finish = status => res.writeHead(status, { "cache-control": "no-store" }).end();
    const isOffer = req.method === "GET" && req.url === offer;
    const isWrite = req.method === "POST" && (req.url === grant || req.url === revoke);
    if (req.headers.host !== host || !(isOffer || isWrite)) return finish(404);
    const presented = req.headersDistinct[proofHeader];
    if (now() >= expiresAt || presented?.length !== 1 ||
        !/^[0-9a-f]{64}$/u.test(presented[0]) ||
        !timingSafeEqual(createHash("sha256").update(presented[0]).digest(), proofDigest))
      return finish(401);
    if (req.headersDistinct["x-lash-workload-token"]?.length !== 1 ||
        req.headersDistinct.authorization?.length !== 1)
      return finish(401);

    let body;
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxBody) return finish(413);
        chunks.push(chunk);
      }
      if (isOffer && bytes !== 0) return finish(400);
      if (isWrite) {
        if (req.headers["content-type"] !== "application/json" ||
            req.headersDistinct["x-idempotency-key"]?.length !== 1)
          return finish(400);
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!payload || Array.isArray(payload) || payload.orderId !== scope.orderId ||
            payload.userId !== scope.customerId || payload.courseId !== scope.courseId ||
            payload.idempotencyKey !== req.headers["x-idempotency-key"])
          return finish(404);
        body = JSON.stringify(payload);
      }
    } catch { return finish(400); }
    if (now() >= expiresAt) return finish(401);
    const headers = {
      host,
      accept: "application/json",
      authorization: req.headers.authorization,
      "x-lash-workload-token": req.headers["x-lash-workload-token"],
    };
    if (req.headers["x-request-id"]) headers["x-request-id"] = req.headers["x-request-id"];
    if (isWrite) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
      headers["x-idempotency-key"] = req.headers["x-idempotency-key"];
    }
    const proxy = upstream({
      hostname: "gateway", port: 8443, servername: host,
      method: req.method, path: req.url, headers,
      signal: AbortSignal.timeout(8_000),
    }, response => {
      res.writeHead(response.statusCode, {
        "content-type": response.headers["content-type"] ?? "application/json",
        "cache-control": "no-store",
      });
      response.once("error", () => res.destroy());
      response.pipe(res);
    });
    proxy.once("error", () => res.headersSent ? res.destroy() : finish(502));
    res.once("close", () => proxy.destroy());
    proxy.end(body);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createP407CourseIngress(JSON.parse(process.env.P407_COURSE_INGRESS_SCOPE_JSON ?? "null"))
    .listen(8081, "0.0.0.0");
}
