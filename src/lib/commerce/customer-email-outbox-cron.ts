import "server-only";

import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { processCustomerEmailOutbox } from "./customer-email-outbox-worker";

export function createCustomerEmailOutboxCronHandler(
  processOutbox: typeof processCustomerEmailOutbox = processCustomerEmailOutbox,
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
    const result = await processOutbox();
    return NextResponse.json(result, {
      status: result.failed > 0 ? 503 : 200,
    });
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
