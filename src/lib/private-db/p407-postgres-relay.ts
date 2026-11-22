import "server-only";

import { Duplex } from "node:stream";
import { getVercelOidcToken } from "@vercel/oidc";
import WebSocket, { createWebSocketStream } from "ws";
import { resolveApplicationEnvironment } from "@/lib/env/application-environment.mjs";

const RELAY_URL = "wss://api-p407.lashher.com/internal/p4-07/postgres";
const POSTGRES_HOST = "p4-07-db.lashher.com";
const POSTGRES_PORT = 5432;
const MAX_RELAY_FRAME_BYTES = 256 * 1024;
export const P407_POSTGRES_DATABASE = "lash_her_p407_frontend";
export const P407_POSTGRES_ROLE = "lash_her_p407_frontend_runtime";

function relayFailure(cause?: NodeJS.ErrnoException) {
  const error = new Error("P4-07 PostgreSQL relay unavailable") as NodeJS.ErrnoException;
  // pg distinguishes a reset during deliberate shutdown from a live failure.
  if (cause?.code === "ECONNRESET" || cause?.code === "EPIPE") error.code = cause.code;
  return error;
}

export function readP407PostgresRelay(
  connectionString: string,
  env: Record<string, string | undefined> = process.env,
) {
  const endpoint = env.P407_POSTGRES_RELAY_URL;
  const proof = env.P407_POSTGRES_RELAY_DEPLOYMENT_PROOF;
  if (endpoint === undefined && proof === undefined) {
    if (URL.canParse(connectionString) && new URL(connectionString).hostname === POSTGRES_HOST) {
      throw new Error("P4-07 PostgreSQL relay configuration refused");
    }
    return undefined;
  }

  try {
    if (endpoint !== RELAY_URL || !proof || !/^[0-9a-f]{64}$/u.test(proof) || /^0+$/u.test(proof) ||
      env.VERCEL !== "1" || env.VERCEL_ENV !== "production" ||
      resolveApplicationEnvironment(env) !== "staging") throw new Error();
    const url = new URL(connectionString);
    const options = [...url.searchParams.keys()];
    const channelBinding = url.searchParams.getAll("channel_binding");
    if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== POSTGRES_HOST || Number(url.port || 5432) !== POSTGRES_PORT ||
      decodeURIComponent(url.pathname) !== `/${P407_POSTGRES_DATABASE}` ||
      decodeURIComponent(url.username) !== P407_POSTGRES_ROLE || !url.password || url.hash ||
      url.searchParams.getAll("sslmode").length !== 1 || url.searchParams.get("sslmode") !== "verify-full" ||
      options.some((key) => key !== "sslmode" && key !== "channel_binding") ||
      channelBinding.length > 1 || channelBinding.length === 1 && channelBinding[0] !== "require") throw new Error();
    return { stream: () => createP407PostgresStream({
      endpoint, proof, host: POSTGRES_HOST, port: POSTGRES_PORT,
    }) };
  } catch {
    throw new Error("P4-07 PostgreSQL relay configuration refused");
  }
}

// pg calls the stream factory for each physical connection and negotiates its
// PostgreSQL TLS session over this duplex. The WebSocket carries only wire bytes.
export function createP407PostgresStream(
  config: { endpoint: string; proof: string; host: string; port: number },
  getWorkloadToken: () => Promise<string> = getVercelOidcToken,
) {
  let webSocket: WebSocket | undefined;
  let wire: Duplex | undefined;
  let started = false;
  const socket = new Duplex({
    allowHalfOpen: false,
    read() { wire?.resume(); },
    write(chunk: Buffer, _encoding, callback) {
      const connection = wire;
      if (!connection) return callback(relayFailure());
      const send = (offset: number) => {
        const end = offset + MAX_RELAY_FRAME_BYTES;
        connection.write(chunk.subarray(offset, end), (error) => {
          if (error) callback(relayFailure(error));
          else if (end >= chunk.length) callback();
          else send(end);
        });
      };
      send(0);
    },
    final(callback) {
      if (wire) wire.end(callback);
      else callback();
    },
    destroy(error, callback) {
      wire?.destroy();
      webSocket?.terminate();
      callback(error);
    },
  });

  async function connect() {
    const token = await getWorkloadToken();
    if (socket.destroyed) return;
    if (!token || token.length > 16_384 || !/^[A-Za-z0-9._-]+$/u.test(token)) throw relayFailure();
    webSocket = new WebSocket(config.endpoint, {
      followRedirects: false,
      handshakeTimeout: 5_000,
      maxPayload: MAX_RELAY_FRAME_BYTES,
      perMessageDeflate: false,
      rejectUnauthorized: true,
      headers: {
        "x-lash-workload-token": token,
        "x-lash-p407-db-proof": config.proof,
      },
    });
    webSocket.on("message", (_data, binary) => {
      if (!binary) socket.destroy(relayFailure());
    });
    wire = createWebSocketStream(webSocket);
    webSocket.once("open", () => socket.emit("connect"));
    webSocket.once("unexpected-response", (_request, response) => {
      response.resume();
      socket.destroy(relayFailure());
    });
    wire.on("data", (data: Buffer) => {
      if (!socket.destroyed && !socket.push(data)) wire?.pause();
    });
    wire.on("end", () => socket.push(null));
    wire.on("error", (error) => socket.destroy(relayFailure(error)));
    wire.on("close", () => socket.destroy());
  }

  return Object.assign(socket, {
    connect(port: number, host: string) {
      if (started || port !== config.port || host !== config.host) {
        queueMicrotask(() => socket.destroy(relayFailure()));
      } else {
        started = true;
        void connect().catch(() => socket.destroy(relayFailure()));
      }
      return socket;
    },
    // WebSockets manage their own TCP connection and the relay bounds its lifetime.
    setNoDelay() { return socket; },
    setKeepAlive() { return socket; },
    ref() { return socket; },
    unref() { return socket; },
  });
}
