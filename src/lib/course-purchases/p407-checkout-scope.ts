import { readP407CourseCheckoutScope } from "@/lib/writer-admission/p407-course";

type Environment = Record<string, string | undefined>;
const generatedHost = /^lash-her-frontend-staging-[a-z0-9]{9}-dardan-demiris-projects\.vercel\.app$/u;

interface P407CheckoutScope {
  origin: string;
  customerId: string;
  courseId: string;
  orderId: string;
}

/** Operator-only scope. Deployment Protection and the admission ledger are
 * checked independently. No request header can nominate the origin or order. */
export function resolveP407CheckoutScope(
  env: Environment = process.env,
  now = Date.now(),
): P407CheckoutScope | undefined {
  const scope = readP407CourseCheckoutScope(env, now);
  if (!scope) return undefined;
  const host = env.VERCEL_URL;
  if (!host || !generatedHost.test(host)) throw new Error("P4-07 checkout origin refused");
  const { customerId, courseId, orderId } = scope;
  return { origin: `https://${host}`, customerId, courseId, orderId };
}

export function selectCourseRecoveryOrder(
  requestUrl: URL,
  scope: P407CheckoutScope | undefined,
): { orderId?: string } | null {
  if (!scope) return requestUrl.search ? null : {};
  return requestUrl.origin === scope.origin && requestUrl.search === `?orderId=${scope.orderId}`
    ? { orderId: scope.orderId }
    : null;
}
