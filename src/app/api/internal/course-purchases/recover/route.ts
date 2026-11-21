import { drainCourseJobs } from "@/lib/course-purchases/recovery";
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
    const body = await readBoundedTextBody(request, 1);
    if (new URL(request.url).search || !body.ok || body.value)
      return new Response(null, { status: 400, headers });
    const result = await runWriterAdmission("recovery", () =>
      drainCourseJobs(undefined, 4),
    );
    return Response.json(result, { headers });
  } catch {
    return new Response(null, { status: 503, headers });
  }
}
