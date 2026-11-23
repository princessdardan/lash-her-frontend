import { resolveApplicationEnvironment } from "@/lib/env/application-environment.mjs";

export type P407CourseCheckoutScope = {
  sourceCommit: string;
  expiresAt: string;
  orderId: string;
  customerId: string;
  courseId: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function hasP407CheckoutBinding(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.P407_CHECKOUT_SCOPE_JSON !== undefined || env.P407_POSTGRES_RELAY_URL !== undefined ||
    env.P407_POSTGRES_RELAY_DEPLOYMENT_PROOF !== undefined;
}

export function readP407CourseCheckoutScope(
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): P407CourseCheckoutScope | null {
  const raw = env.P407_CHECKOUT_SCOPE_JSON;
  if (!hasP407CheckoutBinding(env)) return null;
  const relayProof = env.P407_POSTGRES_RELAY_DEPLOYMENT_PROOF ?? "";
  try {
    if (env.FRONTEND_WRITER_ADMISSION_MODE !== "enforce" ||
        env.VERCEL !== "1" || env.VERCEL_ENV !== "production" ||
        env.VERCEL_TARGET_ENV !== "production" || resolveApplicationEnvironment(env) !== "staging" ||
        env.P407_POSTGRES_RELAY_URL !== "wss://api-p407.lashher.com/internal/p4-07/postgres" ||
        !/^[a-f0-9]{64}$/u.test(relayProof) || /^0+$/u.test(relayProof) ||
        env.SQUARE_ENVIRONMENT !== "sandbox" || env.SQUARE_LOCATION_ID !== "LCW972G6NQNSE" ||
        !raw || raw.length > 320) throw new Error();
    const scope: unknown = JSON.parse(raw);
    if (!scope || typeof scope !== "object" || Array.isArray(scope) ||
        Object.keys(scope).sort().join(",") !== "courseId,customerId,expiresAt,orderId,sourceCommit") throw new Error();
    const { courseId, customerId, orderId, sourceCommit, expiresAt } = scope as Record<string, unknown>;
    if (typeof sourceCommit !== "string" || !/^[a-f0-9]{40}$/u.test(sourceCommit) ||
        /^0+$/u.test(sourceCommit) || sourceCommit !== env.VERCEL_GIT_COMMIT_SHA ||
        typeof expiresAt !== "string" || new Date(expiresAt).toISOString() !== expiresAt ||
        Date.parse(expiresAt) <= now || Date.parse(expiresAt) - now > 2 * 60 * 60_000 ||
        typeof courseId !== "string" || !uuid.test(courseId) ||
        typeof customerId !== "string" || !uuid.test(customerId) ||
        typeof orderId !== "string" || !uuid.test(orderId)) throw new Error();
    return { orderId, customerId, courseId, sourceCommit, expiresAt };
  } catch {
    throw new Error("P4-07 Course checkout scope refused");
  }
}
