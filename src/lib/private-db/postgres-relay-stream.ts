import "server-only";

import { Duplex } from "node:stream";
import { getVercelOidcToken } from "@vercel/oidc";
import WebSocket, { createWebSocketStream } from "ws";

const MAX_RELAY_FRAME_BYTES = 256 * 1024;

export type PostgresRelaySocketConfig = { endpoint: string; proof: string; host: string; port: number };

function relayFailure(qualification: "P4-07" | "P5-06", cause?: NodeJS.ErrnoException) {
  const error = new Error(`${qualification} PostgreSQL relay unavailable`) as NodeJS.ErrnoException;
  // pg distinguishes a reset during deliberate shutdown from a live failure.
  if (cause?.code === "ECONNRESET" || cause?.code === "EPIPE") error.code = cause.code;
  return error;
}

// pg calls the stream factory for each physical connection and negotiates its
// PostgreSQL TLS session over this duplex. The WebSocket carries only wire bytes.
export function createPostgresRelayStream(
  config: PostgresRelaySocketConfig,
  qualification: "P4-07" | "P5-06",
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
      if (!connection) return callback(relayFailure(qualification));
      const send = (offset: number) => {
        const end = offset + MAX_RELAY_FRAME_BYTES;
        connection.write(chunk.subarray(offset, end), (error) => {
          if (error) callback(relayFailure(qualification, error));
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
    if (!token || token.length > 16_384 || !/^[A-Za-z0-9._-]+$/u.test(token)) throw relayFailure(qualification);
    webSocket = new WebSocket(config.endpoint, {
      followRedirects: false,
      handshakeTimeout: 5_000,
      maxPayload: MAX_RELAY_FRAME_BYTES,
      perMessageDeflate: false,
      rejectUnauthorized: true,
      headers: {
        "x-lash-workload-token": token,
        [qualification === "P5-06" ? "x-lash-p506-db-proof" : "x-lash-p407-db-proof"]: config.proof,
      },
    });
    webSocket.on("message", (_data, binary) => {
      if (!binary) socket.destroy(relayFailure(qualification));
    });
    wire = createWebSocketStream(webSocket);
    webSocket.once("open", () => socket.emit("connect"));
    webSocket.once("unexpected-response", (_request, response) => {
      response.resume();
      socket.destroy(relayFailure(qualification));
    });
    wire.on("data", (data: Buffer) => {
      if (!socket.destroyed && !socket.push(data)) wire?.pause();
    });
    wire.on("end", () => socket.push(null));
    wire.on("error", (error) => socket.destroy(relayFailure(qualification, error)));
    wire.on("close", () => socket.destroy());
  }

  return Object.assign(socket, {
    connect(port: number, host: string) {
      if (started || port !== config.port || host !== config.host) {
        queueMicrotask(() => socket.destroy(relayFailure(qualification)));
      } else {
        started = true;
        void connect().catch(() => socket.destroy(relayFailure(qualification)));
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
