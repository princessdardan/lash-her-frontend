import "server-only";

import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { releaseAbandonedProductStockReservations } from "./product-stock-abandoned-sweep";

export function createAbandonedProductStockCronHandler(
  sweep: typeof releaseAbandonedProductStockReservations = releaseAbandonedProductStockReservations,
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
    const result = await sweep();
    return NextResponse.json(result, { status: 200 });
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
