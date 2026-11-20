import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getApplicationEnvironment } from "@/lib/env/application-environment.server";

export const reviewCookie = "__Secure-lash-staging-review";
export const reviewPath = "/staging-review";
export const reviewUser = "staging-review@lashher.invalid";
export const reviewCourse = "e9fc3a24-e440-5a63-badc-098caab9de56";
const sessionSeconds = 8 * 60 * 60;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hex = /^[0-9a-f]{64}$/u;

export function reviewSettings() {
  const { STAGING_REVIEW_SUBJECT: subject, STAGING_REVIEW_COOKIE_KEY: key,
    STAGING_REVIEW_PASSWORD_HASH: passwordHash, STAGING_REVIEW_END: expires } = process.env;
  if (process.env.APP_ENV !== "staging" || process.env.VERCEL_ENV !== "production" ||
      getApplicationEnvironment() !== "staging" ||
      !subject || !uuid.test(subject) || !key || !hex.test(key) ||
      !passwordHash || !hex.test(passwordHash) || !expires || !/^\d{10}$/u.test(expires) ||
      Number(expires) <= Math.floor(Date.now() / 1000)) return null;
  return { subject, key, passwordHash, end: Number(expires) };
}

function equalHex(actual: string, expected: string) {
  return hex.test(actual) && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function signature(key: string, subject: string, expiry: string) {
  return createHmac("sha256", Buffer.from(key, "hex")).update(`staging-review-v1:${subject}:${expiry}`).digest("hex");
}

export function startReview(username: string, password: string) {
  const config = reviewSettings();
  if (!config || username !== reviewUser || !/^[A-Za-z0-9_-]{32}$/u.test(password) ||
      !equalHex(createHash("sha256").update(password).digest("hex"), config.passwordHash)) return null;
  const now = Math.floor(Date.now() / 1000);
  const expiry = String(Math.min(config.end, now + sessionSeconds));
  return { value: `${expiry}.${signature(config.key, config.subject, expiry)}`, maxAge: Number(expiry) - now };
}

export async function getReviewSubject() {
  const config = reviewSettings();
  if (!config) return null;
  const raw = (await cookies()).get(reviewCookie)?.value;
  if (!raw || raw.length !== 75) return null;
  const [expiry, proof] = raw.split(".", 2);
  if (!/^\d{10}$/u.test(expiry) || Number(expiry) > config.end || Number(expiry) <= Date.now() / 1000 ||
      !equalHex(proof, signature(config.key, config.subject, expiry))) return null;
  return config.subject;
}

export function reviewSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || new URL(request.url).origin !== origin) return false;
  return origin === "https://staging.lashher.com" || (!!process.env.VERCEL_URL && origin === `https://${process.env.VERCEL_URL}`);
}

export const reviewCookieOptions = { httpOnly: true, secure: true, sameSite: "strict", path: reviewPath } as const;
