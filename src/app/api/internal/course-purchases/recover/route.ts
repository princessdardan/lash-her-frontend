import { drainCourseJobs } from "@/lib/course-purchases/recovery";
import {
  resolveP407CheckoutScope,
  selectCourseRecoveryOrder,
} from "@/lib/course-purchases/p407-checkout-scope";
import { readCourseOrder } from "@/lib/course-purchases/store";
import { runWriterAdmission } from "@/lib/writer-admission/runtime";
import { readBoundedTextBody } from "@/lib/security/bounded-text-body";
import {
  coursePurchaseInternalDenial,
  coursePurchaseInternalHeaders as headers,
} from "../authorization";

export const runtime = "nodejs";

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
    return await runWriterAdmission("recovery", async () => {
      if (scope) {
        const order = await readCourseOrder(scope.orderId, scope.customerId);
        if (order?.courseId !== scope.courseId)
          return new Response(null, { status: 404, headers });
      }
      return Response.json(await drainCourseJobs(target.orderId, 4), { headers });
    }, scope && { p407CourseOrderId: scope.orderId });
  } catch {
    return new Response(null, { status: 503, headers });
  }
}
