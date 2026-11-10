import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { request, Agent } from "node:http";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { X509Certificate } from "node:crypto";
import { createOperationsServer } from "./operations.mjs";
import { SCOPED_MUX_HEADER } from "./admission.mjs";

// Each application is on a two-peer backend network with this TLS terminator.
// The application trusts only this proxy's address, never the whole mesh CIDR.
export function createPrivateTlsProxy(config) {
  const upstream = new URL(config.upstream);
  if (upstream.protocol !== "http:" || upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash) throw new Error("Invalid private backend");
  if (!Array.isArray(config.peers) || config.peers.length === 0 || config.peers.some((peer) =>
    !isIP(peer.address) || !Array.isArray(peer.routes) || peer.routes.length === 0 ||
    peer.routes.some((route) => !["GET", "POST", "PATCH", "PUT", "DELETE"].includes(route.method) || !/^\/[A-Za-z0-9/{}_-]+$/u.test(route.path)))) throw new Error("Invalid private peer policy");
  const agent = new Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 4 });
  const server = createServer({ key: readFileSync(config.keyFile), cert: readFileSync(config.certFile),
    minVersion: "TLSv1.2", maxHeaderSize: 24 * 1024, headersTimeout: 5000, requestTimeout: 10_000,
  }, (req, res) => {
    const peerAddress = req.socket.remoteAddress?.replace(/^::ffff:/u, "");
    const peer = config.peers.find((item) => item.address === peerAddress);
    const seen = new Set();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i].toLowerCase();
      if (seen.has(name)) { res.writeHead(400, { connection: "close" }); res.end(); return; }
      seen.add(name);
    }
    const path = req.url?.split("?", 1)[0];
    if (!path || !/^\/[A-Za-z0-9/_-]+$/u.test(path) || path.includes("//") ||
        !peer?.routes.some((route) => route.method === req.method && new RegExp(`^${route.path.replace(/\{[^}]+\}/gu, "[A-Za-z0-9_-]+")}$`, "u").test(path))) {
      res.writeHead(403, { connection: "close" }); res.end(); return;
    }
    const headers = { "x-forwarded-for": peerAddress };
    for (const name of ["accept", "authorization", "content-type", "x-idempotency-key", "mux-signature", "x-request-id"]) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const muxTarget = req.headers[SCOPED_MUX_HEADER];
    if (req.method === "POST" && req.url === "/v1/webhooks/mux" && typeof muxTarget === "string") {
      headers[SCOPED_MUX_HEADER] = muxTarget;
    }
    // Reframe the body locally; no untrusted hop-by-hop/framing headers survive.
    const call = request(upstream, { agent, method: req.method, path: req.url, headers, timeout: 5000 }, (reply) => {
      const headers = {};
      for (const name of ["content-type", "retry-after", "x-request-id"]) {
        if (typeof reply.headers[name] === "string") headers[name] = reply.headers[name];
      }
      res.writeHead(reply.statusCode ?? 502, headers);
      reply.pipe(res);
      reply.on("error", () => res.destroy());
    });
    let bytes = 0;
    req.on("data", (chunk) => { bytes += chunk.length; if (bytes > 1024 * 1024) { call.destroy(); req.destroy(); res.destroy(); } });
    const timer = setTimeout(() => { call.destroy(); req.destroy(); res.destroy(); }, 10_000);
    res.once("close", () => { clearTimeout(timer); call.destroy(); });
    req.once("aborted", () => call.destroy());
    call.once("timeout", () => call.destroy());
    call.once("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(call);
  });
  server.maxConnections = 64;
  server.on("checkContinue", (_req, res) => { res.writeHead(417, { connection: "close" }); res.end(); });
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("close", () => agent.destroy());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.PRIVATE_TLS_CONFIG_FILE) throw new Error("PRIVATE_TLS_CONFIG_FILE required");
  const config = JSON.parse(readFileSync(process.env.PRIVATE_TLS_CONFIG_FILE, "utf8"));
  const server = createPrivateTlsProxy(config);
  const certificate = new X509Certificate(readFileSync(config.certFile));
  const operations = createOperationsServer({}, { tls_not_after_seconds: Date.parse(certificate.validTo) / 1000 });
  operations.listen(9100, "0.0.0.0");
  server.listen(8443, "0.0.0.0");
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    operations.close();
    server.close(); setTimeout(() => server.closeAllConnections(), 10_000).unref();
  });
}
