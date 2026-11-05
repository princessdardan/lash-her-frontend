import "server-only";

import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { processCustomerEmailOutbox } from "./customer-email-outbox-worker";
import { WriterAdmissionError } from "@/lib/writer-admission/config";

export function createCustomerEmailOutboxCronHandler(
  processOutbox: typeof processCustomerEmailOutbox = processCustomerEmailOutbox,
  runRecovery: (
    task: () => ReturnType<typeof processCustomerEmailOutbox>,
  ) => ReturnType<typeof processCustomerEmailOutbox> = (task) => task(),
): (request: Request) => Promise<Response> {
  return async function customerEmailOutboxCronHandler(
    request: Request,
  ): Promise<Response> {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret) return new Response("Not found", { status: 404 });
    const authorization = request.headers.get("authorization") ?? "";
    if (!safeEqual(authorization, `Bearer ${secret}`)) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      const result = await runRecovery(() => processOutbox());
      return NextResponse.json(result, {
        status: result.failed > 0 ? 503 : 200,
      });
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
