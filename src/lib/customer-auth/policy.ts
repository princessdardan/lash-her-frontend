import { createHash, createHmac } from "node:crypto";

export const CUSTOMER_AUTH_BASE_PATH = "/api/customer-auth";
export const CUSTOMER_SESSION_MAX_AGE = 30 * 24 * 60 * 60;
export const CUSTOMER_EMAIL_MAX_AGE = 15 * 60;

export function normalizeCustomerEmail(value: unknown): string {
  if (typeof value !== "string") throw new Error("INVALID_CUSTOMER_EMAIL");
  const email = value.normalize("NFKC").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@,;<>"\\]+@[^\s@,;<>"\\]+\.[^\s@,;<>"\\]+$/u.test(email)) {
    throw new Error("INVALID_CUSTOMER_EMAIL");
  }
  return email;
}

export function safeCustomerReturn(value: string, origin: string): string {
  try {
    const destination = new URL(value, origin);
    if (destination.origin !== origin || /[\\\u0000-\u0020]/u.test(value) || !value.startsWith("/") && !value.startsWith(`${origin}/`)) return "/academy";
    const decoded = decodeURIComponent(destination.pathname);
    if (decoded.startsWith("//") || /[\\\u0000-\u0020]/u.test(decoded) || /^\/(?:admin|api|studio)(?:\/|$)/u.test(decoded)) return "/academy";
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch { return "/academy"; }
}

export function customerSessionCookieName(secure: boolean): string {
  return `${secure ? "__Host-" : ""}lash-customer.session-token`;
}

export function hashCustomerSession(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function customerThrottleKey(secret: string, scope: string, subject: string): string {
  return createHmac("sha256", secret).update(`${scope}:${subject}`).digest("hex");
}

export interface CustomerAuthConfiguration {
  origin: string;
  secret: string;
  googleId: string;
  googleSecret: string;
  resendKey: string;
  emailFrom: string;
  secure: boolean;
}

export function resolveCustomerAuthConfiguration(env: Record<string, string | undefined> = process.env): CustomerAuthConfiguration | null {
  if (env.CUSTOMER_AUTH_ENABLED !== "true" || env.INTEGRATION_CUSTOMER_ACCESS_ENABLED !== "true") return null;
  const { CUSTOMER_AUTH_URL: url, CUSTOMER_AUTH_SECRET: secret, CUSTOMER_AUTH_GOOGLE_ID: googleId,
    CUSTOMER_AUTH_GOOGLE_SECRET: googleSecret, CUSTOMER_AUTH_RESEND_KEY: resendKey, CUSTOMER_AUTH_EMAIL_FROM: emailFrom } = env;
  if (!url || !secret || Buffer.byteLength(secret) < 32 || !googleId || !googleSecret || !resendKey || !emailFrom || /[\r\n]/u.test(emailFrom)) throw new Error("CUSTOMER_AUTH_CONFIGURATION");
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash ||
    parsed.protocol !== "https:" && !(env.NODE_ENV !== "production" && parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) throw new Error("CUSTOMER_AUTH_CONFIGURATION");
  // next-auth's Next.js wrapper honors these global URLs. Refuse a conflicting
  // origin rather than accidentally borrowing the administrator's redirect host.
  for (const globalUrl of [env.AUTH_URL, env.NEXTAUTH_URL]) {
    if (globalUrl && new URL(globalUrl).origin !== parsed.origin) throw new Error("CUSTOMER_AUTH_CONFIGURATION");
  }
  if ([env.AUTH_SECRET, env.NEXTAUTH_SECRET, env.AUTH_GOOGLE_SECRET].some(other => other && other === secret) ||
    googleSecret === env.AUTH_GOOGLE_SECRET || googleId === env.AUTH_GOOGLE_ID || resendKey === secret || googleSecret === secret) throw new Error("CUSTOMER_AUTH_CONFIGURATION");
  return { origin: parsed.origin, secret, googleId, googleSecret, resendKey, emailFrom, secure: parsed.protocol === "https:" };
}
