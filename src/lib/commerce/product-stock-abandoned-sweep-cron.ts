import "server-only";

import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { runAbandonedProductStockSweep } from "./product-stock-abandoned-sweep";
import { WriterAdmissionError } from "@/lib/writer-admission/config";

export function createAbandonedProductStockCronHandler(
  sweep: typeof runAbandonedProductStockSweep = runAbandonedProductStockSweep,
  runRecovery: (
    task: () => ReturnType<typeof runAbandonedProductStockSweep>,
  ) => ReturnType<typeof runAbandonedProductStockSweep> = (task) => task(),
): (request: Request) => Promise<Response> {
  return async function abandonedProductStockCronHandler(
    request: Request,
  ): Promise<Response> {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret) return new Response("Not found", { status: 404 });
    const authorization = request.headers.get("authorization") ?? "";
    if (!safeEqual(authorization, `Bearer ${secret}`)) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      const result = await runRecovery(() => sweep());
      return NextResponse.json(result, { status: 200 });
    } catch (error) {
      if (!(error instanceof WriterAdmissionError)) throw error;
      return NextResponse.json(
        {
          error:
            "This operation is temporarily unavailable. Please retry shortly.",
        },
        {
          status: 503,
          headers: { "cache-control": "no-store", "retry-after": "30" },
        },
      );
    }
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
