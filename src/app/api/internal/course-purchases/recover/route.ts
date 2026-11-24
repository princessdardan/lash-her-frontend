import { drainCourseJobs, recoverCourseCapture, recoverSandboxCourseRefund } from "@/lib/course-purchases/recovery";
import {
  resolveP407CheckoutScope,
  selectCourseRecoveryOrder,
  selectSandboxCourseRefund,
} from "@/lib/course-purchases/p407-checkout-scope";
import { readCourseReceiptQualificationKind } from "@/lib/course-purchases/receipt-destination";
import { readCourseReceiptQualification } from "@/lib/course-purchases/receipt-qualification";
import { runWriterAdmission } from "@/lib/writer-admission/runtime";
import { readBoundedTextBody } from "@/lib/security/bounded-text-body";
import {
  coursePurchaseInternalDenial,
  coursePurchaseInternalHeaders as headers,
} from "../authorization";

export const runtime = "nodejs";
const retryHeaders = { ...headers, "retry-after": "60" };

/** Read delivery evidence for the protected qualification's one test message. */
export async function GET(request: Request) {
  const kind = readCourseReceiptQualificationKind();
  if (!kind) return new Response(null, { status: 404, headers });
  const denial = coursePurchaseInternalDenial(request);
  if (denial) return denial;
  try {
    const scope = resolveP407CheckoutScope();
    const target = selectCourseRecoveryOrder(new URL(request.url), scope);
    if (!scope || target?.orderId !== scope.orderId || target.paymentId)
      return new Response(null, { status: 404, headers });
    const result = await readCourseReceiptQualification(scope, kind);
    return result.httpStatus === 200
      ? Response.json(result.evidence, { headers })
      : new Response(null, { status: result.httpStatus, headers: result.httpStatus === 503 ? retryHeaders : headers });
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
    const url = new URL(request.url);
    const target = selectCourseRecoveryOrder(url, scope);
    const refundId = selectSandboxCourseRefund(url, scope, process.env.P408_COURSE_RECEIPT_TEST);
    const body = await readBoundedTextBody(request, 1);
    if ((!target && !refundId) || !body.ok || body.value)
      return new Response(null, { status: 400, headers });
    const result = await runWriterAdmission("recovery", async () => {
      if (!scope) return { jobs: await drainCourseJobs(undefined, 4) };
      const capture = refundId
        ? await recoverSandboxCourseRefund(scope, refundId)
        : await recoverCourseCapture(scope, target?.paymentId);
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
