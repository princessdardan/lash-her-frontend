import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";
import { pathToFileURL } from "node:url";
import { decodeJwt } from "jose";
import { WebSocketServer } from "ws";
import { createWorkloadVerifier } from "./oidc.mjs";

const path = "/internal/p6-00/postgres";
const host = "api-p600.lashher.com";
const database = { host: "p600-frontend-db.lashher.com", port: 5432 };
const workload = {
  issuer: "https://oidc.vercel.com/dardan-demiris-projects",
  audience: "https://vercel.com/dardan-demiris-projects",
  subject: "owner:dardan-demiris-projects:project:lash-her-frontend-staging:environment:production",
  ownerId: "team_2Hrn5eMZyZxfAWdmYvyKi9t3",
  projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM",
  environment: "production",
};
const sslRequest = Buffer.from("0000000804d2162f", "hex");
const maxMessageBytes = 256 * 1024;
const maxConnections = 8;
const connectTimeoutMs = 3_000;
const idleTimeoutMs = 30_000;
const maxLifetimeMs = 300_000;

function reject(socket, status) {
  if (socket.destroyed) return;
  const reason = { 401: "Unauthorized", 404: "Not Found", 503: "Service Unavailable" }[status];
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`);
}

function singleHeader(request, name) {
  const values = request.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}

function startTunnel(client, lifetimeMs, connectDatabase) {
  let upstream;
  let stopped = false;
  const lifetime = setTimeout(stop, lifetimeMs);
  let handshake = setTimeout(stop, connectTimeoutMs);

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(lifetime);
    clearTimeout(handshake);
    upstream?.destroy();
    client.terminate();
  }

  client.once("error", stop);
  client.once("close", stop);
  client.on("message", (bytes, binary) => {
    if (!binary || !Buffer.isBuffer(bytes)) return stop();
    if (!upstream) {
      if (!bytes.equals(sslRequest)) return stop();
      clearTimeout(handshake);
      handshake = setTimeout(stop, connectTimeoutMs);
      try {
        upstream = connectDatabase(database);
      } catch {
        return stop();
      }
      upstream.once("connect", () => {
        clearTimeout(handshake);
        upstream.setTimeout(idleTimeoutMs, stop);
      });
      upstream.once("error", stop);
      upstream.once("close", stop);
      upstream.on("drain", () => client.resume());
      upstream.on("data", (chunk) => {
        upstream.pause();
        client.send(chunk, { binary: true }, (error) => {
          if (error) return stop();
          upstream.resume();
        });
      });
    }
    if (upstream.writableLength + bytes.length > 2 * maxMessageBytes) return stop();
    if (!upstream.write(bytes)) client.pause();
  });
}

export function createPostgresRelay({ proofHash, proofExpiresAt, fetchJwks, connectDatabase = connect }) {
  const expires = Date.parse(proofExpiresAt);
  if (!/^[a-f0-9]{64}$/.test(proofHash ?? "") || !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 86_400_000) {
    throw new Error("Invalid or expired P6-00 relay proof configuration");
  }
  const expectedHash = Buffer.from(proofHash, "hex");
  const verifyWorkload = createWorkloadVerifier(workload, { fetch: fetchJwks });
  const sockets = new Set();
  const relay = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: maxMessageBytes });
  const server = createServer({
    maxHeaderSize: 24_576, headersTimeout: 5_000, requestTimeout: 5_000, connectionsCheckingInterval: 1_000,
  }, (_request, response) => {
    response.writeHead(404, { "cache-control": "no-store" }).end();
  });
  server.maxConnections = 32;

  async function upgrade(request, socket, head) {
    socket.once("error", () => socket.destroy());
    if (request.method !== "GET" || request.url !== path || singleHeader(request, "host") !== host) {
      return reject(socket, 404);
    }
    const proof = singleHeader(request, "x-lash-p600-db-proof");
    const token = singleHeader(request, "x-lash-workload-token");
    if (request.headers.origin !== undefined || request.headers["sec-websocket-protocol"] !== undefined ||
        request.headers["sec-websocket-extensions"] !== undefined || !token ||
        !/^[a-f0-9]{64}$/.test(proof ?? "") || Date.now() >= expires ||
        !timingSafeEqual(expectedHash, createHash("sha256").update(proof, "ascii").digest())) {
      return reject(socket, 401);
    }
    if (sockets.size >= maxConnections) return reject(socket, 503);

    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(connectTimeoutMs, () => socket.destroy());
    socket.pause();
    try {
      await verifyWorkload(token);
      const lifetimeMs = Math.min(expires, decodeJwt(token).exp * 1_000, Date.now() + maxLifetimeMs) - Date.now();
      if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) return reject(socket, 401);
      if (socket.destroyed) return;
      socket.setTimeout(0);
      relay.handleUpgrade(request, socket, head, (client) => {
        startTunnel(client, lifetimeMs, connectDatabase);
        socket.resume();
      });
    } catch {
      reject(socket, 401);
    }
  }

  server.on("upgrade", upgrade);
  function close(callback) {
    server.close(callback);
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    relay.close();
  }
  return { server, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = createPostgresRelay({
    proofHash: process.env.P600_POSTGRES_RELAY_PROOF_SHA256,
    proofExpiresAt: process.env.P600_POSTGRES_RELAY_PROOF_EXPIRES_AT,
  });
  relay.server.listen(8080, "0.0.0.0");
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => relay.close());
}
