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
): { orderId?: string; paymentId?: string } | null {
  if (!scope) return requestUrl.search ? null : {};
  if (requestUrl.origin !== scope.origin) return null;
  const order = `?orderId=${scope.orderId}`;
  if (requestUrl.search === order) return { orderId: scope.orderId };
  const prefix = `${order}&paymentId=`;
  if (!requestUrl.search.startsWith(prefix)) return null;
  const paymentId = requestUrl.search.slice(prefix.length);
  return /^[A-Za-z0-9_-]{1,192}$/u.test(paymentId) ? { orderId: scope.orderId, paymentId } : null;
}

export function selectSandboxCourseRefund(
  requestUrl: URL,
  scope: P407CheckoutScope | undefined,
  qualification: string | undefined,
): string | undefined {
  if (qualification !== "refund" || !scope || requestUrl.origin !== scope.origin)
    return undefined;
  const prefix = `?orderId=${scope.orderId}&refundId=`;
  if (!requestUrl.search.startsWith(prefix)) return undefined;
  const id = requestUrl.search.slice(prefix.length);
  return /^[A-Za-z0-9_-]{1,192}$/u.test(id) ? id : undefined;
}
