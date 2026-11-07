import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { isAdminDeveloperModeEnabled } from "@/lib/admin/developer-mode-config";
import { resolveApplicationEnvironment } from "@/lib/env/application-environment.mjs";

export const INTERACTIVE_ORIGIN = "https://staging.lashher.com";
export const INTERACTIVE_COOKIE = "__Host-lash-p2q-window";
export const INTERACTIVE_HEADER = "x-lash-internal-interactive-admission";
export const INTERACTIVE_GATEWAY_PROOF_HEADER = "x-lash-certification-interactive";

const stages = ["identity", "authoring", "media", "learning", "paid-grant", "lifecycle"] as const;
type Stage = (typeof stages)[number];
type Binding = { key: string; deploymentHost: string; source: string; target: string };
const gatewayOrigin = "https://api-staging.lashher.com";
const gatewayStages = new Set<Stage>(["authoring", "media", "learning", "paid-grant"]);
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const at = (pattern: string) => new RegExp(`^(?:${pattern})$`, "u");
const gatewayRequestId = at(uuid);
const signedDigest = /^[a-f0-9]{64}$/u;
const epochPattern = /^[1-9][0-9]{0,17}$/u;
const maxLeaseSeconds = 600;
const maxRequestSeconds = 30;
const adminGoogleAction = new AsyncLocalStorage<true>();

export function withinInteractiveAdminGoogleAction<T>(task: () => Promise<T>): Promise<T> {
  return adminGoogleAction.run(true, task);
}

const customerAuth = {
  GET: at("/sign-in|/account/sign-in-methods|/api/customer-auth/(?:csrf|providers|session|callback/(?:google|resend))"),
  POST: at("/api/customer-auth/(?:signin/(?:google|resend)|signout)"),
};
const staffAuth = {
  GET: at("/admin/(?:sign-in|not-authorized)|/api/auth/(?:csrf|providers|session|callback/google)"),
  POST: at("/admin/sign-in|/api/auth/(?:signin/google|signout)"),
};
const authoring = {
  GET: at(`/admin/courses(?:/${uuid})?|/api/admin/courses(?:/${uuid}(?:/publication-readiness)?)?|/api/admin/lessons/${uuid}/quiz`),
  POST: at(`/api/admin/courses(?:/${uuid}/modules(?:/reorder)?)?|/api/admin/modules/${uuid}/lessons(?:/reorder)?`),
  PATCH: at(`/api/admin/(?:courses|modules|lessons)/${uuid}`),
  PUT: at(`/api/admin/lessons/${uuid}/quiz`),
};
const media = {
  GET: at(`/api/admin/lessons/${uuid}/video`),
  POST: at(`/api/admin/lessons/${uuid}/(?:video-upload|video/${uuid}/(?:refresh|captions))`),
  DELETE: at(`/api/admin/lessons/${uuid}/video/${uuid}/captions/[A-Za-z0-9_-]{1,255}`),
};
const learning = {
  GET: at(`/academy(?:/courses/${uuid}(?:/lessons/${uuid})?)?|/courses(?:/[a-z0-9]+(?:-[a-z0-9]+)*)?|/api/academy/(?:catalog(?:/[a-z0-9]+(?:-[a-z0-9]+)*)?|courses(?:/${uuid}(?:/lessons)?)?|lessons/${uuid}(?:/playback|/quiz(?:/attempts)?)?|progress)`),
  POST: at(`/api/academy/(?:courses/${uuid}/enrollments|lessons/${uuid}/(?:progress|quiz/attempts))`),
};
const paidGrant = {
  GET: at(`/(?:api/)?admin/courses(?:/${uuid}(?:/manual-grants)?)?`),
  POST: at(`/api/admin/courses/${uuid}/manual-grants`),
};
const lifecycle = {
  GET: at(`/account|/admin/customer-accounts|/api/account(?:/exports/${uuid})?|/api/admin/customer-accounts/${uuid}/exports/${uuid}`),
  POST: at(`/api/account/(?:preferences|commands)|/api/admin/customer-accounts/${uuid}/commands`),
};

function matches(routes: Readonly<Partial<Record<string, RegExp>>>, method: string, path: string) {
  return Object.hasOwn(routes, method) && routes[method]?.test(path) === true;
}

function permits(stage: Stage, method: string, path: string): boolean {
  switch (stage) {
    case "identity": return matches(customerAuth, method, path) || matches(staffAuth, method, path);
    case "authoring": return matches(authoring, method, path);
    case "media": return matches(media, method, path) || (method === "GET" && matches(authoring, method, path));
    case "learning": return matches(learning, method, path) || (method === "GET" && path === "/api/customer-auth/session");
    case "paid-grant": return matches(paidGrant, method, path);
    case "lifecycle": return matches(lifecycle, method, path) || (method === "GET" && path === "/api/customer-auth/session");
  }
}

function binding(env: Record<string, string | undefined>): Binding | null {
  if (env.FRONTEND_WRITER_ADMISSION_MODE !== "enforce" || env.APP_ENV !== "staging" ||
    env.VERCEL_ENV !== "production" || env.VERCEL_TARGET_ENV !== "production" || isAdminDeveloperModeEnabled(env)) return null;
  const key = env.CRON_SECRET, deploymentHost = env.VERCEL_URL, source = env.VERCEL_GIT_COMMIT_SHA;
  if (!key || !/^[!-~]{32,8192}$/u.test(key) || !deploymentHost ||
    !/^[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(deploymentHost) || !source || !/^[a-f0-9]{40}$/u.test(source)) return null;
  try {
    if (resolveApplicationEnvironment(env) !== "staging") return null;
    const target: unknown = JSON.parse(env.FRONTEND_WRITER_ADMISSION_TARGET_JSON ?? "").targetSha256;
    if (typeof target === "string" && signedDigest.test(target)) return { key, deploymentHost, source, target };
  } catch { return null; }
  return null;
}

function signature(authority: Binding, domain: "browser" | "request", value: string): string {
  return createHmac("sha256", authority.key)
    .update(`lash-her:p2q:interactive:${domain}:v1\n${authority.deploymentHost}\n${authority.source}\n${authority.target}\n${value}`)
    .digest("hex");
}

function authentic(actual: string | undefined, expected: string): boolean {
  return !!actual && signedDigest.test(actual) && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function browserProof(authority: Binding, cookie: string, now: number) {
  if (cookie.length > 256) return null;
  const [version, epoch, stage, started, expires, nonce, mac, extra] = cookie.split(".");
  if (extra !== undefined || version !== "v1" || !epochPattern.test(epoch ?? "") || !stages.includes(stage as Stage) ||
    !/^\d{10}$/u.test(started ?? "") || !/^\d{10}$/u.test(expires ?? "") || !/^[a-f0-9]{32}$/u.test(nonce ?? "") ||
    Number(started) > now || Number(expires) <= now || Number(expires) - Number(started) > maxLeaseSeconds ||
    !authentic(mac, signature(authority, "browser", [version, epoch, stage, started, expires, nonce].join(".")))) return null;
  return { epoch, stage: stage as Stage, nonce };
}

// A browser cookie is accepted only on selected paths. Proxy issues a short
// internal proof of the route it actually selected and never forwards it as a
// response header.
export function attestInteractiveRequest(request: { origin: string; method: string; path: string; cookie: string },
  env: Record<string, string | undefined> = process.env, now = Math.floor(Date.now() / 1000)): string | null {
  if (request.origin !== INTERACTIVE_ORIGIN || request.path.length > 512) return null;
  const authority = binding(env);
  const browser = authority && browserProof(authority, request.cookie, now);
  if (!authority || !browser || !permits(browser.stage, request.method, request.path)) return null;
  const route = Buffer.from(`${request.method} ${request.path}`).toString("base64url");
  const value = `${now}.${route}`;
  return `${value}.${signature(authority, "request", `${request.cookie}\n${value}`)}`;
}

export function interactiveRequestHeaders(request: NextRequest): Headers | undefined {
  const cookies = request.cookies.getAll(INTERACTIVE_COOKIE);
  if (cookies.length === 0 && !request.headers.has(INTERACTIVE_HEADER)) return undefined;
  const headers = new Headers(request.headers);
  headers.delete(INTERACTIVE_HEADER);
  const proof = cookies.length === 1 ? attestInteractiveRequest({
    origin: request.nextUrl.origin, method: request.method, path: request.nextUrl.pathname, cookie: cookies[0].value,
  }) : null;
  if (proof) headers.set(INTERACTIVE_HEADER, proof);
  return headers;
}

function verifiedInteractiveRequest(authority: Binding, proof: string, cookie: string, now: number) {
  if (proof.length > 780) return null;
  const browser = browserProof(authority, cookie, now);
  if (!browser) return null;
  const [issued, route, mac, extra] = proof.split(".");
  if (extra !== undefined || !/^\d{10}$/u.test(issued ?? "") || !/^[A-Za-z0-9_-]+$/u.test(route ?? "") ||
    Number(issued) > now || now - Number(issued) >= maxRequestSeconds ||
    !authentic(mac, signature(authority, "request", `${cookie}\n${issued}.${route}`))) return null;
  const [method, path, trailing] = Buffer.from(route, "base64url").toString().split(" ");
  if (trailing !== undefined || !method || !path || !permits(browser.stage, method, path)) return null;
  if (method === "POST" && path === "/admin/sign-in" && !adminGoogleAction.getStore()) return null;
  return browser;
}

export function readInteractiveRequest(proof: string, cookie: string, env: Record<string, string | undefined> = process.env,
  now = Math.floor(Date.now() / 1000)): { epoch: string; producerSha256: string; source: string; target: string } | null {
  const authority = binding(env);
  const browser = authority && verifiedInteractiveRequest(authority, proof, cookie, now);
  if (!authority || !browser) return null;
  const { source, target } = authority;
  const producerSha256 = createHash("sha256").update(`lash-her:p2q:interactive-producer:v1\n${source}\n${target}`).digest("hex");
  return { epoch: browser.epoch, producerSha256, source, target };
}

export async function interactiveCourseGatewayProof(request: {
  url: URL; method: string; requestId: string; body?: string; applicationToken?: string; idempotencyKey?: string;
}): Promise<string | null> {
  const { url, method, requestId } = request;
  const target = url.pathname + url.search;
  const configuredOrigin = process.env.API_GATEWAY_STAGING_ORIGIN;
  if ((configuredOrigin !== gatewayOrigin && configuredOrigin !== gatewayOrigin + "/") ||
    url.origin !== gatewayOrigin || url.href !== gatewayOrigin + target || !url.pathname.startsWith("/course/v1/") ||
    !gatewayRequestId.test(requestId)) return null;
  const authority = binding(process.env);
  if (!authority) return null;

  try {
    const { cookies, headers } = await import("next/headers");
    const proof = (await headers()).get(INTERACTIVE_HEADER);
    if (!proof) return null;
    const permits = (await cookies()).getAll(INTERACTIVE_COOKIE);
    const issued = Math.floor(Date.now() / 1000);
    const browser = permits.length === 1 && verifiedInteractiveRequest(authority, proof, permits[0].value, issued);
    if (!browser || !gatewayStages.has(browser.stage)) return null;
    const { deploymentHost, source, target: frontendTarget } = authority;
    const { epoch, stage, nonce } = browser;
    // This window key stays local. Only the MAC over this exact outbound
    // request is sent to the gateway.
    const key = createHmac("sha256", authority.key)
      .update(`lash-her:p2q:interactive:gateway-key:v1\n${deploymentHost}\n${source}\n${frontendTarget}\n${epoch}\n${stage}\n${nonce}`)
      .digest();
    const hashes = [request.body, request.applicationToken, request.idempotencyKey]
      .map(value => createHash("sha256").update(value ?? "").digest("hex"));
    const mac = createHmac("sha256", key).update([
      "lash-her:p2q:interactive:gateway-request:v1", issued, requestId, method, target, ...hashes,
    ].join("\n")).digest("hex");
    return `v1.${issued}.${requestId}.${mac}`;
  } catch {
    // Commands outside browser request context still use the ordinary
    // transport and cannot supply an interactive proof.
    return null;
  }
}
