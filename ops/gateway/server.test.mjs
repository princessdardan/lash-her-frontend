import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer, request } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { createGateway } from "./server.mjs";
import { createPrivateTlsProxy } from "./private-tls.mjs";

let folder, key, cert, keyFile, certFile, wrongCertFile;
before(() => {
  folder = mkdtempSync(join(tmpdir(), "lash-gateway-test-"));
  keyFile = join(folder, "key.pem"); certFile = join(folder, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", keyFile,
    "-out", certFile, "-subj", "/CN=localhost.localdomain", "-addext", "subjectAltName=DNS:localhost.localdomain,DNS:other.test,IP:127.0.0.1"], { stdio: "ignore" });
  wrongCertFile = join(folder, "wrong-cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(folder, "wrong-key.pem"),
    "-out", wrongCertFile, "-subj", "/CN=untrusted.test"], { stdio: "ignore" });
  key = readFileSync(keyFile); cert = readFileSync(certFile);
});
after(() => rmSync(folder, { recursive: true, force: true }));

async function fixture(t, handler, overrides = {}, options = {}) {
  const upstream = createServer({ key, cert }, handler);
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const config = {
    issuer: "https://oidc.vercel.com/test-team", audience: "https://vercel.com/test-team",
    subject: "owner:test-team:project:test-project:environment:production", ownerId: "team_test", projectId: "prj_test",
    environment: "production", appEnv: "staging", publicHost: "localhost.localdomain",
    courseOrigin: `https://127.0.0.1:${upstream.address().port}`,
    tlsKeyFile: keyFile, tlsCertFile: certFile, upstreamCaFile: certFile, ...overrides,
  };
  const { server, counters } = createGateway(config, {
    verify: async (proof) => { if (proof !== "synthetic-valid-proof") throw new Error("invalid"); return { projectId: config.projectId }; },
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await Promise.all([server, upstream].map((item) => new Promise((resolve) => { item.close(resolve); item.closeAllConnections(); })));
  });
  return {
    counters,
    send: ({ path = "/course/v1/courses", method = "GET", headers = {}, body, servername = "localhost.localdomain", rawHeaders } = {}) => new Promise((resolve, reject) => {
      const call = request({ host: "127.0.0.1", port: server.address().port, path, method, servername, ca: cert,
        headers: rawHeaders ?? { host: config.publicHost, "x-lash-workload-token": "synthetic-valid-proof", ...headers } }, (reply) => {
        const chunks = [];
        reply.on("data", (chunk) => chunks.push(chunk));
        reply.on("end", () => resolve({ status: reply.statusCode, headers: reply.headers, body: Buffer.concat(chunks).toString() }));
        reply.on("error", reject);
      });
      call.on("error", reject); call.end(body);
    }),
  };
}

test("private TLS upstream receives only selected headers, original query and application authorization", async (t) => {
  let received;
  const f = await fixture(t, (req, res) => { received = req; res.end('{"courses":[]}'); });
  const result = await f.send({ path: "/course/v1/student/courses?cursor=x%2Fy", headers: {
    authorization: "Bearer application.jwt.proof", "x-forwarded-for": "8.8.8.8", "x-real-ip": "8.8.8.8",
    "x-user-id": "forged", forwarded: "for=8.8.8.8", cookie: "session=private", "x-request-id": "caller-id",
    "x-vercel-oidc-token": "forged", "mux-signature": "forged",
  } });
  assert.equal(result.status, 200);
  assert.equal(received.url, "/v1/student/courses?cursor=x%2Fy");
  assert.equal(received.headers.authorization, "Bearer application.jwt.proof");
  assert.equal(received.socket.remoteAddress, "127.0.0.1");
  for (const name of ["x-lash-workload-token", "x-forwarded-for", "x-real-ip", "x-user-id", "forwarded", "cookie", "x-vercel-oidc-token", "mux-signature"]) assert.equal(received.headers[name], undefined, name);
  assert.match(received.headers["x-request-id"], /^[a-f0-9-]{36}$/u);
  assert.equal(result.headers["cache-control"], "no-store");
});

test("missing workload, OIDC-only protected requests, wrong host and duplicate credentials never reach upstream", async (t) => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls++; res.end(); });
  assert.equal((await f.send({ headers: { "x-lash-workload-token": "", authorization: "Bearer app" } })).status, 401);
  assert.equal((await f.send({ path: "/course/v1/student/courses" })).status, 401);
  assert.equal((await f.send({ headers: { host: "attacker.test" } })).status, 421);
  assert.equal((await f.send({ servername: "other.test" })).status, 421);
  assert.equal((await f.send({ rawHeaders: ["Host", "localhost.localdomain", "X-Lash-Workload-Token", "synthetic-valid-proof", "X-Lash-Workload-Token", "second"] })).status, 400);
  assert.equal((await f.send({ rawHeaders: ["Host", "localhost.localdomain", "X-Lash-Workload-Token", "synthetic-valid-proof", "Authorization", "Bearer a", "Authorization", "Bearer b"] })).status, 400);
  assert.equal((await f.send({ path: "/course/v1/internal/community/entitlements/check", method: "POST" })).status, 404);
  assert.equal((await f.send({ path: "/course/metrics" })).status, 404);
  assert.equal(calls, 0);
});

test("exact Mux exception preserves raw bytes/signature; other webhook methods are denied", async (t) => {
  const body = '{ "type": "video.test", "data": {"id":"fixture"} }\n';
  let received, signature;
  const f = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = Buffer.concat(chunks).toString(); signature = req.headers["mux-signature"];
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(400); res.end('{"error":{"code":"INVALID_SIGNATURE","message":"Invalid signature"}}');
  });
  const result = await f.send({ method: "POST", path: "/course/v1/webhooks/mux", body,
    headers: { "x-lash-workload-token": "", "mux-signature": "synthetic-signature", authorization: "Bearer drop" } });
  assert.equal(result.status, 400); assert.equal(received, body); assert.equal(signature, "synthetic-signature");
  assert.equal((await f.send({ path: "/course/v1/webhooks/mux" })).status, 404);
});

test("upstream 429 envelope and Retry-After survive; internal locations and cookies cannot escape", async (t) => {
  let count = 0;
  const f = await fixture(t, (_req, res) => {
    if (++count === 1) {
      res.writeHead(429, { "retry-after": "12", "content-type": "application/json", "set-cookie": "private=value" });
      res.end('{"error":{"code":"TOO_MANY_REQUESTS","message":"Retry later"},"requestId":"safe-id"}');
    } else { res.writeHead(302, { location: "https://private.internal/secret" }); res.end(); }
  });
  const limited = await f.send();
  assert.equal(limited.status, 429); assert.equal(limited.headers["retry-after"], "12");
  assert.equal(JSON.parse(limited.body).requestId, "safe-id");
  assert.equal(limited.headers["set-cookie"], undefined);
  const redirect = await f.send();
  assert.equal(redirect.status, 502); assert.equal(redirect.headers.location, undefined);
  assert.ok(!redirect.body.includes("private.internal"));
});

test("workload admission does not consume independent webhook/service budgets", async (t) => {
  const f = await fixture(t, (_req, res) => res.end("ok"), {}, {
    limits: { preauth: 10, workload: 1, service: 1, webhook: 1 },
  });
  assert.equal((await f.send()).status, 200);
  const limited = await f.send();
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers["retry-after"]) >= 1);
  assert.equal((await f.send({ method: "POST", path: "/course/v1/webhooks/mux" })).status, 200);
  assert.equal((await f.send({ path: "/course/v1/internal/entitlements", headers: { authorization: "Bearer app" } })).status, 200);
});

test("untrusted private TLS certificate is refused without exposing connection details", async (t) => {
  let reached = false;
  const f = await fixture(t, (_req, res) => { reached = true; res.end("must not pass"); }, { upstreamCaFile: wrongCertFile });
  const result = await f.send();
  assert.equal(result.status, 502); assert.ok(!result.body.includes("localhost"));
  assert.equal(reached, false);
});

test("private TLS terminator checks actual peer and route, replacing spoofed forwarding metadata", async (t) => {
  let received;
  const backend = createHttpServer((req, res) => { received = req; res.end("private ok"); });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const proxy = createPrivateTlsProxy({
    upstream: `http://127.0.0.1:${backend.address().port}`, keyFile, certFile,
    peers: [{ address: "127.0.0.1", routes: [{ method: "POST", path: "/v1/internal/course/enrollment-events" }] }],
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await Promise.all([proxy, backend].map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }))); });
  const send = (path) => new Promise((resolve, reject) => {
    const call = request({ host: "127.0.0.1", port: proxy.address().port, ca: cert, method: "POST", path,
      headers: { authorization: "Bearer app", "x-forwarded-for": "8.8.8.8", "x-lash-workload-token": "forged" } }, (reply) => {
      reply.resume(); reply.once("end", () => resolve(reply.statusCode));
    });
    call.once("error", reject); call.end("{}");
  });
  assert.equal(await send("/v1/internal/course/enrollment-events"), 200);
  assert.equal(received.headers["x-forwarded-for"], "127.0.0.1");
  assert.equal(received.headers["x-lash-workload-token"], undefined);
  assert.equal(received.headers.authorization, "Bearer app");
  assert.equal(await send("/metrics"), 403);
  assert.equal(await send("/v1/internal/course/%65nrollment-events"), 403);
});
