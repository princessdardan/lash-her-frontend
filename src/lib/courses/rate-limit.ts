import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { checkSlidingWindowRateLimitWithStore } from "@/lib/security/kv-rate-limiter";
import { getTrustedClientIp } from "@/lib/security/trusted-client-ip";
import { getCourseAccessSecret } from "./access";

export async function checkCourseSignupRateLimit(
  email: string,
  headers: Headers,
): Promise<boolean> {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token)
    throw new Error("Course signup rate limiting is not configured");
  const clientIp = getTrustedClientIp(headers);
  if (!clientIp && (process.env.VERCEL === "1" || process.env.VERCEL_ENV))
    return false;
  const redis = new Redis({ url, token });
  const store = {
    eval: <T>(script: string, keys: string[], args: string[]) =>
      redis.eval<string[], T>(script, keys, args),
  };
  for (const [scope, subject, limit] of [
    ["ip", clientIp ?? "local", 20],
    ["email", email, 5],
  ] as const) {
    const digest = createHmac("sha256", getCourseAccessSecret())
      .update(`${scope}:${subject}`)
      .digest("hex");
    const result = await checkSlidingWindowRateLimitWithStore(store, {
      key: `course:signup:${scope}:${digest}`,
      limit,
      windowMs: 60 * 60 * 1000,
      nowMs: Date.now(),
      requestId: randomUUID(),
    });
    if (!result.allowed) return false;
  }
  return true;
}
