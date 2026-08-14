import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeCustomerDecisionToken,
  getCustomerDecision,
  selectCustomerDecision,
  validateCustomerDecisionBearer,
} from "@/lib/shipping/customer-decisions";
import { buildBookingAbuseKey } from "@/lib/security/trusted-client-ip";
import {
  checkSignedShippingLinkRateLimit,
  isShippingLinkExchangeBlocked,
  recordShippingLinkFailure,
} from "@/lib/security/shipping-abuse-control";

export const runtime = "nodejs";
const COOKIE = "lh_shipping_decision";

export async function GET(req: NextRequest): Promise<Response> {
  const token = req.nextUrl.searchParams.get("token");
  if (token) {
    if (
      !(await allowed(req, token)) ||
      !(await validateCustomerDecisionBearer(token))
    ) {
      return genericInvalid();
    }
    return html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open shipping decision | Lash Her</title></head><body><main><h1>Open your shipping decision</h1><p>Continue to view the decision for your order.</p><form method="post" action="/orders/shipping-decision"><input type="hidden" name="action" value="exchange"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Continue securely</button></form></main></body></html>`,
    );
  }
  const sessionToken = req.cookies.get(COOKIE)?.value ?? "";
  const decision = sessionToken
    ? await getCustomerDecision(sessionToken)
    : null;
  if (!decision) return genericInvalid();
  return html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shipping decision | Lash Her</title></head><body><main><h1>Choose how to proceed</h1><p>Select one option for this shipment. Your choice is final once submitted.</p><form method="post" action="/orders/shipping-decision">${decision.allowedOutcomes.map(option).join("")}<button type="submit">Confirm choice</button></form><p>This link expires ${escapeHtml(decision.expiresAt.toLocaleString("en-CA", { timeZone: "America/Toronto" }))}.</p></main></body></html>`,
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  if (req.headers.get("origin") !== req.nextUrl.origin) return genericInvalid();
  const form = await req.formData().catch(() => null);
  if (form?.get("action") === "exchange") {
    const bearer = form.get("token");
    if (
      typeof bearer !== "string" ||
      (await isShippingLinkExchangeBlocked()) ||
      !(await allowed(req, bearer))
    ) {
      await recordShippingLinkFailure().catch(() => undefined);
      return genericInvalid();
    }
    const sessionToken = await exchangeCustomerDecisionToken(bearer);
    if (!sessionToken) {
      await recordShippingLinkFailure().catch(() => undefined);
      return genericInvalid();
    }
    const response = NextResponse.redirect(
      new URL("/orders/shipping-decision", req.nextUrl.origin),
      303,
    );
    response.cookies.set(COOKIE, sessionToken, cookieOptions());
    return secure(response);
  }
  const sessionToken = req.cookies.get(COOKIE)?.value ?? "";
  const outcome = form?.get("outcome");
  if (
    !sessionToken ||
    typeof outcome !== "string" ||
    !(await allowed(req, sessionToken)) ||
    !(await selectCustomerDecision(sessionToken, outcome))
  ) {
    await recordShippingLinkFailure().catch(() => undefined);
    return genericInvalid();
  }
  const response = html(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Choice received | Lash Her</title></head><body><main><h1>Your choice was received</h1><p>Lash Her will process it under the shipping policy.</p></main></body></html>',
  );
  response.cookies.delete(COOKIE);
  return response;
}

function option(value: string): string {
  const labels: Record<string, string> = {
    refund: "Receive a refund",
    replacement: "Receive a replacement",
    wait: "Continue waiting",
    accept_substitute: "Accept the substitute shipping service",
    accept_signature: "Accept signature delivery",
  };
  return `<label><input required type="radio" name="outcome" value="${escapeHtml(value)}"> ${escapeHtml(labels[value] ?? value)}</label><br>`;
}

async function allowed(req: NextRequest, subject: string): Promise<boolean> {
  const subjectKey = buildBookingAbuseKey({
    headers: req.headers,
    scope: "shipping-decisions",
    subject,
  });
  const ipKey = buildBookingAbuseKey({
    headers: req.headers,
    scope: "shipping-decisions",
    subject: "all-links",
  });
  if (!subjectKey || !ipKey) return false;
  try {
    const now = new Date();
    const [subjectDecision, ipDecision] = await Promise.all([
      checkSignedShippingLinkRateLimit({ key: subjectKey, now }),
      checkSignedShippingLinkRateLimit({ key: ipKey, now }),
    ]);
    return subjectDecision.allowed && ipDecision.allowed;
  } catch {
    return false;
  }
}

function genericInvalid(): NextResponse {
  return html(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link unavailable | Lash Her</title></head><body><main><h1>This link is unavailable</h1><p>It may be invalid, expired, or already used.</p></main></body></html>',
    404,
  );
}

function html(body: string, status = 200): NextResponse {
  return secure(
    new NextResponse(body, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
  );
}

function secure<T extends NextResponse>(response: T): T {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  return response;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "strict" as const,
    path: "/orders/shipping-decision",
    maxAge: 2 * 24 * 60 * 60,
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character]!,
  );
}
