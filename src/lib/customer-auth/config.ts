import "server-only";

import { createHash } from "node:crypto";
import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";
import { assertStagingEmailRecipients } from "@/lib/env/staging-email-policy.mjs";
import { currentWriterIdentityCustomerId, currentWriterIdentityEnrollment, currentWriterIdentityRotation, markWriterOperationUncertain } from "@/lib/writer-admission/context";
import { createGoogleCallbackAdmission } from "@/lib/writer-admission/google-auth-callback";
import { CUSTOMER_AUTH_BASE_PATH, CUSTOMER_EMAIL_MAX_AGE, CUSTOMER_SESSION_MAX_AGE, customerSessionCookieName, normalizeCustomerEmail, safeCustomerReturn, type CustomerAuthConfiguration } from "./policy";
import { customerEnrollmentScopeId, generateCustomerSessionToken, type CustomerAuthStore } from "./store";

export function createCustomerAuthConfig(configuration: CustomerAuthConfiguration, store: CustomerAuthStore, isGoogleCallback = false): NextAuthConfig {
  const callbackAdmission = createGoogleCallbackAdmission(isGoogleCallback);
  const cookie = (suffix: string, maxAge?: number) => ({
    name: `${configuration.secure ? "__Host-" : ""}lash-customer.${suffix}`,
    options: { httpOnly: true, secure: configuration.secure, sameSite: "lax" as const, path: "/", ...(maxAge === undefined ? {} : { maxAge }) },
  });
  const enrollment = currentWriterIdentityEnrollment();
  // OAuth state from a different window or an ordinary sign-in cannot be used
  // for this first-time account. The actual session cookie keeps its normal name.
  const oauthCookie = (name: string) => cookie(enrollment?.provider === "google" ? `${name}.${customerEnrollmentScopeId(enrollment)}` : name, CUSTOMER_EMAIL_MAX_AGE);
  return {
    adapter: store.adapter,
    basePath: CUSTOMER_AUTH_BASE_PATH,
    secret: configuration.secret,
    // Never inherit an administrator AUTH_REDIRECT_PROXY_URL.
    redirectProxyUrl: "",
    // The public route separately validates its URL and mutation Origin against
    // the configured origin before NextAuth may use request headers.
    trustHost: true,
    session: { strategy: "database", maxAge: CUSTOMER_SESSION_MAX_AGE, updateAge: CUSTOMER_SESSION_MAX_AGE + 1, generateSessionToken: generateCustomerSessionToken },
    cookies: {
      sessionToken: { ...cookie("session-token"), name: customerSessionCookieName(configuration.secure) },
      callbackUrl: cookie("callback-url"), csrfToken: cookie("csrf-token"),
      pkceCodeVerifier: oauthCookie("pkce"), state: oauthCookie("state"), nonce: oauthCookie("nonce"),
    },
    pages: { signIn: "/sign-in", error: "/sign-in", verifyRequest: "/sign-in?check-email=1" },
    providers: [
      Google({
        clientId: configuration.googleId, clientSecret: configuration.googleSecret,
        authorization: { params: { scope: "openid email profile" } },
        checks: ["pkce", "state", "nonce"],
        allowDangerousEmailAccountLinking: false,
        account: () => ({}),
        ...callbackAdmission?.providerOptions,
      }),
      Resend({
        apiKey: configuration.resendKey, from: configuration.emailFrom,
        maxAge: CUSTOMER_EMAIL_MAX_AGE, normalizeIdentifier: normalizeCustomerEmail,
        async sendVerificationRequest({ identifier, token, expires, url }) {
          assertStagingEmailRecipients(identifier);
          await store.adapter.createVerificationToken!({ identifier, expires, token: createHash("sha256").update(`${token}${configuration.secret}`).digest("hex") });
          // The token is durable before an email can leave the process. Never
          // detach delivery or include provider response bodies in diagnostics.
          try {
            const response = await fetch("https://api.resend.com/emails", {
              method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
              headers: { authorization: `Bearer ${configuration.resendKey}`, "content-type": "application/json" },
              body: JSON.stringify({ from: configuration.emailFrom, to: identifier, subject: "Sign in to LASH HER", text: `Use this link to sign in to LASH HER. It expires in 15 minutes and can be used once.\n\n${url}\n\nIf you did not request it, ignore this email.` }),
            });
            if (!response.ok) throw new Error();
            const receipt: unknown = await response.json();
            if (!receipt || typeof receipt !== "object" || !("id" in receipt) || typeof receipt.id !== "string" || !receipt.id) throw new Error();
          } catch {
            markWriterOperationUncertain();
            throw new Error("CUSTOMER_AUTH_EMAIL_UNAVAILABLE");
          }
        },
      }),
    ],
    callbacks: {
      async signIn({ user, account, profile, email }) {
        if (currentWriterIdentityRotation()?.actorKind === "customer" && account?.provider !== "google") return false;
        const enrollment = currentWriterIdentityEnrollment();
        if (enrollment) {
          if (account?.provider !== enrollment.provider || !user.email) return false;
          if (account.provider === "resend") {
            if (account.type !== "email" || account.providerAccountId !== user.email) return false;
            return email?.verificationRequest ? store.isEnrollmentAvailable(user.email) : store.authorizeEnrollment({ provider: "resend", email: user.email });
          }
          if (account.type !== "oidc" || profile?.email_verified !== true || typeof profile.sub !== "string" || profile.sub !== account.providerAccountId) return false;
          let verifiedEmail: string;
          try {
            verifiedEmail = normalizeCustomerEmail(profile.email);
            if (verifiedEmail !== normalizeCustomerEmail(user.email)) return false;
          } catch { return false; }
          return store.authorizeEnrollment({ provider: "google", email: verifiedEmail, subject: profile.sub });
        }
        // Neither existence nor lifecycle state changes the request response.
        const selectedId = currentWriterIdentityCustomerId();
        if (email?.verificationRequest && selectedId === undefined) return true;
        if (selectedId !== undefined && user.id !== selectedId) return false;
        if (!user.email || !await store.isActive(user.email)) return false;
        if (account?.provider === "resend") return account.type === "email";
        if (account?.provider !== "google" || account.type !== "oidc" || profile?.email_verified !== true ||
          typeof profile.sub !== "string" || profile.sub !== account.providerAccountId) return false;
        return selectedId === undefined || (await store.adapter.getUserByAccount!({
          provider: "google", providerAccountId: profile.sub,
        }))?.id === selectedId;
      },
      async redirect({ url }) {
        const path = currentWriterIdentityRotation()?.actorKind === "customer" ? "/courses" : safeCustomerReturn(url, configuration.origin);
        return new URL(path, configuration.origin).href;
      },
      async session({ session, user }) {
        // Never expose session bearer tokens, provider identifiers or admin fields.
        return { expires: session.expires, user: { id: user.id, name: user.name ?? null, email: user.email, image: null } } as typeof session;
      },
    },
    logger: {
      // Auth.js errors can include tokens and provider profiles.
      error(error) { callbackAdmission?.recordError(error); }, warn() {}, debug() {},
    },
    debug: false,
  };
}
