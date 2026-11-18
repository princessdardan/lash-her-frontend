import { createHash, timingSafeEqual } from "node:crypto";
import { courseRecoveryEnabled } from "@/lib/course-purchases/policy";

export const coursePurchaseInternalHeaders = {
  "cache-control": "private, no-store",
};
const digest = (text: string) => createHash("sha256").update(text).digest();

export function coursePurchaseInternalDenial(
  request: Request,
): Response | null {
  const headers = coursePurchaseInternalHeaders;
  const secret = process.env.COURSE_PURCHASE_RECOVERY_SECRET;
  if (!courseRecoveryEnabled())
    return new Response(null, { status: 404, headers });
  if (!secret || secret.length < 32)
    return new Response(null, { status: 503, headers });
  if (
    !timingSafeEqual(
      digest(request.headers.get("authorization") ?? ""),
      digest(`Bearer ${secret}`),
    )
  )
    return new Response(null, { status: 401, headers });
  return null;
}
