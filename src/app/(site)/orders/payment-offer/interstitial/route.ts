import { type NextRequest, NextResponse } from "next/server";

import {
  secureSupplementalPaymentOfferResponse,
  SUPPLEMENTAL_PAYMENT_OFFER_BEARER_COOKIE,
} from "@/lib/commerce/supplemental-payment-offer-link-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest): Response {
  const bearer = request.cookies.get(
    SUPPLEMENTAL_PAYMENT_OFFER_BEARER_COOKIE,
  )?.value;
  const status = bearer ? 200 : 404;
  const body = bearer
    ? '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open payment offer | Lash Her</title></head><body><main><h1>Open your payment offer</h1><p>Continue to review the exact supplemental amount, disclosure, and expiry. Opening this page did not accept or consume the offer.</p><form method="post" action="/orders/payment-offer/exchange"><button type="submit">Continue securely</button></form></main></body></html>'
    : '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment offer unavailable | Lash Her</title></head><body><main><h1>This payment offer is unavailable</h1><p>It may be invalid, expired, superseded, paid, or already closed.</p></main></body></html>';
  return secureSupplementalPaymentOfferResponse(
    new NextResponse(body, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
  );
}
