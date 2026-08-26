import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  isChitChatsShippingEnabled,
  isFlatRateShippingEnabled,
} from "@/lib/shipping/config";
import { refreshFlatRateCache } from "@/lib/shipping/flat-rate-refresh";

export const runtime = "nodejs";
// Pricing every zone × bucket makes one carrier round-trip per cell; give the
// cron room beyond the default function budget.
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) return new Response(null, { status: 401 });
  // Only price the cache when the flat-rate feature is actually enabled (and the
  // carrier is configured). Otherwise this cron would make ~100 carrier calls a
  // week to fill a cache nothing reads. To pre-warm before enabling the read
  // flag, turn on FLAT_RATE_SHIPPING_ENABLED and trigger this endpoint once.
  if (!isChitChatsShippingEnabled() || !isFlatRateShippingEnabled()) {
    return NextResponse.json({ enabled: false, updated: 0 }, { status: 200 });
  }
  try {
    const result = await refreshFlatRateCache();
    // A partial refresh (some cells failed) is not fatal: unwritten cells fall
    // back to the conservative per-zone default at checkout, so a sale is never
    // blocked. Surface 503 so the platform records the degraded run, but never
    // throw the whole cron away over a single carrier hiccup.
    return NextResponse.json(result, {
      status: result.failed > 0 ? 503 : 200,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Flat-rate cache refresh failed",
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
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const accepted = [
    process.env.CHITCHATS_WORKER_CRON_SECRET,
    process.env.CRON_SECRET,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return Boolean(
    token && accepted.some((secret) => constantTimeEqual(token, secret)),
  );
}

function constantTimeEqual(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}
