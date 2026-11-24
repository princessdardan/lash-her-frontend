import "server-only";

import { readP407CourseCheckoutScope } from "@/lib/writer-admission/p407-course";
import { PurchaseDependencyError } from "./course-api";
import { resolveP407CheckoutScope } from "./p407-checkout-scope";
import type { CourseJob, CourseOrder } from "./store";

const testRecipient = "delivered@resend.dev";
const stagingSender = "Lash Her Staging <staging@mail.staging.lashher.com>";

export function readCourseReceiptQualificationKind(env: Record<string, string | undefined> = process.env) {
  switch (env.P408_COURSE_RECEIPT_TEST) {
    case "enabled": return "receipt";
    case "refund": return "refund_receipt";
  }
}

export function resolveCourseReceiptDestination(
  order: Pick<CourseOrder, "id" | "customerId" | "courseId" | "email">,
  kind: CourseJob["kind"],
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): string | null {
  const hasQualification = env.P408_COURSE_RECEIPT_TEST !== undefined;
  const qualificationKind = readCourseReceiptQualificationKind(env);
  const scope = hasQualification
    ? resolveP407CheckoutScope(env, now)
    : readP407CourseCheckoutScope(env, now);

  if (hasQualification && (!qualificationKind || !scope))
    throw new PurchaseDependencyError(403);
  if (!scope) return order.email;
  if (order.id !== scope.orderId || order.customerId !== scope.customerId || order.courseId !== scope.courseId)
    throw new PurchaseDependencyError(403);
  if (kind !== qualificationKind) return null;

  if (order.email !== `p408-sandbox-${scope.customerId}@example.invalid`)
    throw new PurchaseDependencyError(403);
  if (
    env.STAGING_EMAIL_RECIPIENT_ALLOWLIST !== testRecipient ||
    env.ADMIN_EMAIL !== testRecipient ||
    env.FROM_EMAIL !== stagingSender ||
    !env.RESEND_API_KEY?.trim()
  ) throw new PurchaseDependencyError(502);

  return testRecipient;
}
