import "server-only";

import { Duplex } from "node:stream";
import { getVercelOidcToken } from "@vercel/oidc";
import WebSocket, { createWebSocketStream } from "ws";

const MAX_RELAY_FRAME_BYTES = 256 * 1024;
const UPGRADE_RETRY_DELAYS_MS = [50, 150, 300];

const proofHeaders = {
  "P4-07": "x-lash-p407-db-proof",
  "P5-06": "x-lash-p506-db-proof",
  "P6-00": "x-lash-p600-db-proof",
} as const;
type RelayQualification = keyof typeof proofHeaders;

export type PostgresRelaySocketConfig = {
  endpoint: string;
  proof: string;
  host: string;
  port: number;
};

function relayFailure(
  qualification: RelayQualification,
  cause?: NodeJS.ErrnoException,
) {
  const error = new Error(
    `${qualification} PostgreSQL relay unavailable`,
  ) as NodeJS.ErrnoException;
  // pg distinguishes a reset during deliberate shutdown from a live failure.
  if (cause?.code === "ECONNRESET" || cause?.code === "EPIPE")
    error.code = cause.code;
  return error;
}

// pg calls the stream factory for each physical connection and negotiates its
// PostgreSQL TLS session over this duplex. The WebSocket carries only wire bytes.
export function createPostgresRelayStream(
  config: PostgresRelaySocketConfig,
  qualification: RelayQualification,
  getWorkloadToken: () => Promise<string> = getVercelOidcToken,
) {
  let webSocket: WebSocket | undefined;
  let wire: Duplex | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  const socket = new Duplex({
    allowHalfOpen: false,
    read() {
      wire?.resume();
    },
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
      clearTimeout(retryTimer);
      wire?.destroy();
      webSocket?.terminate();
      callback(error);
    },
  });

  function openWebSocket(token: string, retryCount = 0) {
    if (socket.destroyed) return;
    const attempt = new WebSocket(config.endpoint, {
      followRedirects: false,
      handshakeTimeout: 5_000,
      maxPayload: MAX_RELAY_FRAME_BYTES,
      perMessageDeflate: false,
      rejectUnauthorized: true,
      headers: {
        "x-lash-workload-token": token,
        [proofHeaders[qualification]]: config.proof,
      },
    });
    webSocket = attempt;
    attempt.on("message", (_data, binary) => {
      if (!binary) socket.destroy(relayFailure(qualification));
    });
    attempt.once("open", () => {
      const connected = createWebSocketStream(attempt);
      wire = connected;
      connected.on("data", (data: Buffer) => {
        if (!socket.destroyed && !socket.push(data)) connected.pause();
      });
      connected.on("end", () => socket.push(null));
      connected.on("error", (error) =>
        socket.destroy(relayFailure(qualification, error)),
      );
      connected.on("close", () => socket.destroy());
      socket.emit("connect");
    });
    attempt.once("error", (error: NodeJS.ErrnoException) => {
      if (webSocket === attempt && !wire)
        socket.destroy(relayFailure(qualification, error));
    });
    attempt.once("unexpected-response", (_request, response) => {
      response.resume();
      if (qualification !== "P4-07" && response.statusCode === 503) {
        // The upgrade failed before PostgreSQL connected or received bytes.
        const waitMs = UPGRADE_RETRY_DELAYS_MS[retryCount];
        if (waitMs !== undefined) {
          webSocket = undefined;
          attempt.terminate();
          retryTimer = setTimeout(() => {
            try {
              openWebSocket(token, retryCount + 1);
            } catch {
              socket.destroy(relayFailure(qualification));
            }
          }, waitMs);
          return;
        }
        console.warn(
          `${qualification} PostgreSQL relay rejected upgrade with HTTP 503`,
        );
      }
      socket.destroy(relayFailure(qualification));
    });
  }

  async function connect() {
    const token = await getWorkloadToken();
    if (socket.destroyed) return;
    if (!token || token.length > 16_384 || !/^[A-Za-z0-9._-]+$/u.test(token))
      throw relayFailure(qualification);
    openWebSocket(token);
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
    setNoDelay() {
      return socket;
    },
    setKeepAlive() {
      return socket;
    },
    ref() {
      return socket;
    },
    unref() {
      return socket;
    },
  });
}
