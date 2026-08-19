import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runShippingPolicyWorker } from "@/lib/shipping/policy-worker";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) return new Response(null, { status: 401 });
  try {
    const result = await runShippingPolicyWorker();
    return NextResponse.json(result, {
      status: result.failures > 0 ? 503 : 200,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Shipping policy worker failed",
        incident: createHash("sha256")
          .update(error instanceof Error ? error.message : "unknown")
          .digest("hex")
          .slice(0, 12),
      },
      { status: 503 },
    );
  }
}

function authorized(req: Request): boolean {
  const received = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const accepted = [
    process.env.CHITCHATS_WORKER_CRON_SECRET,
    process.env.CRON_SECRET,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return Boolean(
    received && accepted.some((expected) => equal(received, expected)),
  );
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
