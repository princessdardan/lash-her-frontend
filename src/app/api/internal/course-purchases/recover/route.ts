import { and, eq } from "drizzle-orm";
import { drainCourseJobs, recoverCourseCapture } from "@/lib/course-purchases/recovery";
import {
  resolveP407CheckoutScope,
  selectCourseRecoveryOrder,
} from "@/lib/course-purchases/p407-checkout-scope";
import { renderCourseReceipt } from "@/lib/course-purchases/receipt";
import { resolveCourseReceiptDestination } from "@/lib/course-purchases/receipt-destination";
import { coursePurchaseJobs } from "@/lib/course-purchases/schema";
import { readCourseOrder } from "@/lib/course-purchases/store";
import { getPrivateDb } from "@/lib/private-db/client";
import { runWriterAdmission } from "@/lib/writer-admission/runtime";
import { readBoundedTextBody } from "@/lib/security/bounded-text-body";
import { getResendClient } from "@/lib/transactional-email";
import {
  coursePurchaseInternalDenial,
  coursePurchaseInternalHeaders as headers,
} from "../authorization";

export const runtime = "nodejs";
const retryHeaders = { ...headers, "retry-after": "60" };

/** Read back delivery of the single staging qualification receipt. */
export async function GET(request: Request) {
  if (process.env.P408_COURSE_RECEIPT_TEST !== "enabled")
    return new Response(null, { status: 404, headers });
  const denial = coursePurchaseInternalDenial(request);
  if (denial) return denial;
  try {
    const scope = resolveP407CheckoutScope();
    const target = selectCourseRecoveryOrder(new URL(request.url), scope);
    if (!scope || target?.orderId !== scope.orderId || target.paymentId)
      return new Response(null, { status: 404, headers });
    const recipient = resolveCourseReceiptDestination({
      id: scope.orderId,
      customerId: scope.customerId,
      courseId: scope.courseId,
      email: `p408-sandbox-${scope.customerId}@example.invalid`,
    }, "receipt");
    const order = await readCourseOrder(scope.orderId, scope.customerId);
    if (!order) return Response.json({ status: "awaiting_purchase" }, { headers });
    if (
      order.courseId !== scope.courseId ||
      resolveCourseReceiptDestination(order, "receipt") !== recipient ||
      !order.purchaseTerms || !order.termsAcceptedAt || !order.chargedAt
    ) return new Response(null, { status: 409, headers });
    const [job, duplicate] = await getPrivateDb().transaction((tx) =>
      tx.select({ status: coursePurchaseJobs.status, receipt: coursePurchaseJobs.destinationReceipt })
        .from(coursePurchaseJobs)
        .where(and(eq(coursePurchaseJobs.orderId, scope.orderId), eq(coursePurchaseJobs.kind, "receipt")))
        .limit(2), { accessMode: "read only" });
    if (!recipient || duplicate || job?.status !== "done" || !job.receipt ||
      !/^[a-f0-9-]{36}$/u.test(job.receipt)) return new Response(null, { status: 409, headers });
    const { data, error } = await getResendClient().emails.get(job.receipt);
    if (error || !data) return new Response(null, { status: 503, headers: retryHeaders });
    return Response.json({
      status: data.last_event,
      exactRecipient: data.to.length === 1 && data.to[0] === recipient && !data.cc?.length && !data.bcc?.length,
      receiptMatchesOrder: data.id === job.receipt && data.subject === "Your Lash Her course payment receipt" &&
        data.html === renderCourseReceipt(order),
      termsVersion: order.purchaseTerms.version,
      termsAcceptedAt: order.termsAcceptedAt.toISOString(),
    }, { headers });
  } catch {
    return new Response(null, { status: 503, headers: retryHeaders });
  }
}

/** Manually invoked by the recovery runner. Scheduling is independent. */
export async function POST(request: Request) {
  const denial = coursePurchaseInternalDenial(request);
  if (denial) return denial;
  try {
    const scope = resolveP407CheckoutScope();
    const target = selectCourseRecoveryOrder(new URL(request.url), scope);
    const body = await readBoundedTextBody(request, 1);
    if (!target || !body.ok || body.value)
      return new Response(null, { status: 400, headers });
    const result = await runWriterAdmission("recovery", async () => {
      if (!scope) return { jobs: await drainCourseJobs(undefined, 4) };
      const capture = await recoverCourseCapture(scope, target.paymentId);
      if (capture === "missing" || capture === "conflict" || capture === "pending")
        return { capture };
      return { capture, jobs: await drainCourseJobs(scope.orderId, 4) };
    }, scope && { p407CourseOrderId: scope.orderId });
    if (result.capture === "missing") return new Response(null, { status: 404, headers });
    if (result.capture === "conflict") return new Response(null, { status: 409, headers });
    if (result.capture === "pending") return new Response(null, { status: 503, headers: retryHeaders });
    return Response.json(result.jobs, { headers });
  } catch {
    return new Response(null, { status: 503, headers: retryHeaders });
  }
}
