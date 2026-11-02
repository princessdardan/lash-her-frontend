import "server-only";

import { randomUUID } from "node:crypto";
import { getVercelOidcToken } from "@vercel/oidc";
import routes from "../../../ops/gateway/routes.json";
import { getApplicationEnvironment } from "@/lib/env/application-environment.server";

type GatewayRequest = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  applicationToken?: string;
  idempotencyKey?: string;
  body?: string;
  signal?: AbortSignal;
};

export class GatewayTransportError extends Error {
  constructor(readonly code: "configuration" | "route" | "authorization" | "unavailable" | "response") {
    super(`Gateway transport ${code}`);
    this.name = "GatewayTransportError";
  }
}

export function createGatewayTransport(config: {
  origin: string;
  getWorkloadToken?: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}) {
  let origin: URL;
  try { origin = new URL(config.origin); }
  catch { throw new GatewayTransportError("configuration"); }
  if (origin.protocol !== "https:" || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) throw new GatewayTransportError("configuration");
  const getToken = config.getWorkloadToken ?? getVercelOidcToken;
  const fetch = config.fetch ?? globalThis.fetch;

  return async (input: GatewayRequest): Promise<Response> => {
    if (!/^\/v1\/[A-Za-z0-9/_-]+(?:\?[^#\s\\]*)?$/u.test(input.path) ||
        input.path.length > 4089 || input.path.split("?", 1)[0].includes("//")) throw new GatewayTransportError("route");
    const pathname = input.path.split("?", 1)[0];
    const route = routes.find((route) => route.auth !== "webhook" && route.method === input.method &&
      new RegExp(`^${route.path.replace(/\{[^}]+\}/gu, "[A-Za-z0-9_-]+")}$`, "u").test(pathname));
    if (!route) throw new GatewayTransportError("route");
    if (route.auth === "application" && !input.applicationToken) throw new GatewayTransportError("authorization");
    if (input.applicationToken && !/^[A-Za-z0-9._~-]+$/u.test(input.applicationToken)) throw new GatewayTransportError("authorization");
    if (input.idempotencyKey && !/^[A-Za-z0-9_-]{1,128}$/u.test(input.idempotencyKey)) throw new GatewayTransportError("authorization");
    if (input.body !== undefined && (input.method === "GET" || Buffer.byteLength(input.body) > 1024 * 1024)) throw new GatewayTransportError("route");
    const deadline = AbortSignal.timeout(10_000);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    try {
      signal.throwIfAborted();
      // Called in the current function context for every outbound request.
      const token = await abortableToken(getToken, signal);
      signal.throwIfAborted();
      if (!token || token.length > 16_384 || !/^[A-Za-z0-9._-]+$/u.test(token)) throw new Error("Missing workload proof");
      const headers: Record<string, string> = {
        accept: "application/json", "x-lash-workload-token": token, "x-request-id": randomUUID(),
      };
      if (input.applicationToken) headers.authorization = `Bearer ${input.applicationToken}`;
      if (input.idempotencyKey) headers["x-idempotency-key"] = input.idempotencyKey;
      if (input.body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(new URL(`/course${input.path}`, origin), {
        method: input.method, headers, body: input.body, signal,
        redirect: "manual", cache: "no-store",
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new GatewayTransportError("response");
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        if (reader) while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 8 * 1024 * 1024) {
            await reader.cancel();
            throw new GatewayTransportError("response");
          }
          chunks.push(chunk.value);
        }
      } finally { reader?.releaseLock(); }
      const resultHeaders = new Headers({ "cache-control": "no-store" });
      for (const name of ["content-type", "retry-after", "x-request-id"]) {
        const value = response.headers.get(name);
        if (value !== null) resultHeaders.set(name, value);
      }
      return new Response(response.status === 204 ? null : Buffer.concat(chunks), {
        status: response.status, headers: resultHeaders,
      });
    } catch (error) {
      if (error instanceof GatewayTransportError) throw error;
      // SDK and network errors can include credentials/URLs; never propagate them.
      throw new GatewayTransportError("unavailable");
    }
  };
}

async function abortableToken(getToken: () => Promise<string>, signal: AbortSignal) {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      getToken(),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new GatewayTransportError("unavailable"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function getGatewayTransport() {
  const environment = getApplicationEnvironment();
  const origin = process.env[environment === "production" ? "API_GATEWAY_PRODUCTION_ORIGIN" : "API_GATEWAY_STAGING_ORIGIN"];
  if (!origin || environment === "local") throw new GatewayTransportError("configuration");
  return createGatewayTransport({ origin });
}
