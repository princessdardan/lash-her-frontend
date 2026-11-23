import { reconcileCoursePurchasePage } from "@/lib/course-purchases/reconciliation";
import { hasP407CheckoutBinding } from "@/lib/writer-admission/p407-course";
import { readBoundedTextBody } from "@/lib/security/bounded-text-body";
import {
  coursePurchaseInternalDenial,
  coursePurchaseInternalHeaders as headers,
} from "../authorization";

export const runtime = "nodejs";

const orderId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

export async function POST(request: Request) {
  if (hasP407CheckoutBinding())
    return new Response(null, { status: 404, headers });
  const denial = coursePurchaseInternalDenial(request);
  if (denial) return denial;

  const params = new URL(request.url).searchParams;
  const after = params.get("after");
  if (
    params.size !== (after === null ? 0 : 1) ||
    (after !== null && !orderId.test(after))
  )
    return new Response(null, { status: 400, headers });

  try {
    const body = await readBoundedTextBody(request, 1);
    if (!body.ok || body.value)
      return new Response(null, { status: 400, headers });
    const report = await reconcileCoursePurchasePage(after, request.signal);
    return Response.json(report, { headers });
  } catch {
    return new Response(null, { status: 503, headers });
  }
}
