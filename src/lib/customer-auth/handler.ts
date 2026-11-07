import "server-only";
import { hasConfiguredRequestOrigin } from "@/lib/api-integration/request-origin";

import NextAuth from "next-auth";
import { NextRequest } from "next/server";
import { getTrustedClientIp } from "@/lib/security/trusted-client-ip";
import { currentWriterIdentityCustomerId } from "@/lib/writer-admission/context";
import { withWriterAdmission } from "@/lib/writer-admission/route";
import { runWriterAdmission, type WriterAdmissionRunner } from "@/lib/writer-admission/runtime";
import { createCustomerAuthConfig } from "./config";
import { withCustomerWriterContext } from "./context";
import { CUSTOMER_AUTH_BASE_PATH, customerThrottleKey, normalizeCustomerEmail, resolveCustomerAuthConfiguration, type CustomerAuthConfiguration } from "./policy";
import { createCustomerAuthStore, type CustomerAuthStore } from "./store";

const noStore = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("pragma", "no-cache");
  headers.set("referrer-policy", "no-referrer");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
const unavailable = () => noStore(Response.json({ error: "Sign-in is temporarily unavailable." }, { status: 503, headers: { "retry-after": "30" } }));
const genericEmailResponse = (origin: string) => new Response(null, { status: 303, headers: { location: `${origin}/sign-in?check-email=1` } });

export function createCustomerAuthHandler(dependencies: {
  configuration?: () => CustomerAuthConfiguration | null;
  store?: () => CustomerAuthStore;
  run?: WriterAdmissionRunner;
  handle?: (request: NextRequest, configuration: CustomerAuthConfiguration, store: CustomerAuthStore) => Promise<Response>;
} = {}) {
  const getConfiguration = dependencies.configuration ?? resolveCustomerAuthConfiguration;
  const getStore = dependencies.store ?? createCustomerAuthStore;
  const handle = dependencies.handle ?? ((request, configuration, store) => {
    const handlers = NextAuth(createCustomerAuthConfig(configuration, store)).handlers;
    return handlers[request.method === "POST" ? "POST" : "GET"](request);
  });
  const admitted = withWriterAdmission("new-work", async (original: NextRequest, configuration: CustomerAuthConfiguration) => withCustomerWriterContext(async () => {
    let request = original;
    let emailRequest = false;
    const action = new URL(request.url).pathname.slice(CUSTOMER_AUTH_BASE_PATH.length);
    const store = getStore();
    if (request.method === "GET" && action.startsWith("/callback/")) {
      const clientIp = getTrustedClientIp(request.headers);
      const allowed = await store.consumeThrottle(customerThrottleKey(configuration.secret, "callback", clientIp ?? "unavailable"), 60, 900);
      if (!allowed || !clientIp && process.env.VERCEL === "1") return Response.json({ error: "Please wait before trying again." }, { status: 429, headers: { "retry-after": "900" } });
    }
    if (request.method === "POST") {
      const contentType = request.headers.get("content-type")?.split(";", 1)[0];
      if (contentType !== "application/x-www-form-urlencoded" && contentType !== "application/json") return Response.json({ error: "Invalid request." }, { status: 415 });
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16_384) { await reader.cancel(); return Response.json({ error: "Invalid request." }, { status: 413 }); }
          chunks.push(value);
        }
      }
      const body = Buffer.concat(chunks).toString("utf8");
      request = new NextRequest(original.url, { method: "POST", headers: original.headers, body });
      emailRequest = action === "/signin/resend";
      const clientIp = getTrustedClientIp(request.headers);
      // Hosted authentication refuses an absent trusted platform address. Local
      // fixtures share one bucket; arbitrary untrusted headers do not bypass it.
      const client = clientIp ?? "unavailable";
      const allowed = await store.consumeThrottle(customerThrottleKey(configuration.secret, "client", client), 30, 900);
      if (emailRequest) {
        // Stop here before even normalizing an attacker-selected address. A
        // denied/untrusted client must not create arbitrarily many email rows.
        if (!allowed || !clientIp && process.env.VERCEL === "1") return genericEmailResponse(configuration.origin);
        let email: string;
        try {
          const input = contentType === "application/json" ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
          email = normalizeCustomerEmail(input.email);
        } catch { return genericEmailResponse(configuration.origin); }
        if (currentWriterIdentityCustomerId() !== undefined && !await store.isActive(email)) return genericEmailResponse(configuration.origin);
        const emailAllowed = await store.consumeThrottle(customerThrottleKey(configuration.secret, "email", email), 5, 900);
        if (!emailAllowed) return genericEmailResponse(configuration.origin);
      } else if (!allowed || !clientIp && process.env.VERCEL === "1") {
        return Response.json({ error: "Please wait before trying again." }, { status: 429, headers: { "retry-after": "900" } });
      }
    }
    const response = await handle(request, configuration, store);
    if (emailRequest && response.status < 500) {
      // Preserve Auth.js CSRF/callback cookies while making existing/new/blocked
      // identities and throttled requests indistinguishable to the requester.
      const headers = new Headers(response.headers);
      headers.set("location", `${configuration.origin}/sign-in?check-email=1`);
      return new Response(null, { status: 303, headers });
    }
    return response;
  }), dependencies.run ?? runWriterAdmission, unavailable);

  return async (request: NextRequest): Promise<Response> => {
    try {
      const configuration = getConfiguration();
      if (!configuration) return noStore(Response.json({ error: "Customer sign-in is unavailable." }, { status: 404 }));
      const url = new URL(request.url);
      const action = url.pathname.slice(CUSTOMER_AUTH_BASE_PATH.length);
      const allowed = request.method === "GET" ? ["/csrf", "/providers", "/session", "/callback/google", "/callback/resend"] : ["/signin/google", "/signin/resend", "/signout"];
      if (!hasConfiguredRequestOrigin(request, configuration.origin) || !url.pathname.startsWith(`${CUSTOMER_AUTH_BASE_PATH}/`) || !allowed.includes(action)) return noStore(Response.json({ error: "Invalid request." }, { status: 404 }));
      if (request.method === "POST" && request.headers.get("origin") !== configuration.origin) return noStore(Response.json({ error: "Invalid request." }, { status: 403 }));
      return noStore(await admitted(request, configuration));
    } catch { return unavailable(); }
  };
}
