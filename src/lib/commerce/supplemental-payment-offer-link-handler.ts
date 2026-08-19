import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { buildBookingAbuseKey } from "@/lib/security/trusted-client-ip";
import {
  checkSignedShippingLinkRateLimit,
  isShippingLinkExchangeBlocked,
  recordShippingLinkFailure,
} from "@/lib/security/shipping-abuse-control";
import { assertShippingPolicyMutationAllowed } from "@/lib/shipping/policy";

import {
  exchangeSupplementalPaymentOffer,
  SUPPLEMENTAL_PAYMENT_OFFER_COOKIE,
  validateSupplementalPaymentOfferBearer,
} from "./supplemental-payment-offers";

export const SUPPLEMENTAL_PAYMENT_OFFER_BEARER_COOKIE =
  "lh_supplemental_payment_offer_bearer";

interface SupplementalPaymentOfferLinkDependencies {
  assertMutationAllowed: typeof assertShippingPolicyMutationAllowed;
  checkBlocked: typeof isShippingLinkExchangeBlocked;
  checkRateLimit: typeof checkSignedShippingLinkRateLimit;
  exchange: typeof exchangeSupplementalPaymentOffer;
  recordFailure: typeof recordShippingLinkFailure;
  validateBearer: typeof validateSupplementalPaymentOfferBearer;
}

const defaultDependencies: SupplementalPaymentOfferLinkDependencies = {
  assertMutationAllowed: assertShippingPolicyMutationAllowed,
  checkBlocked: isShippingLinkExchangeBlocked,
  checkRateLimit: checkSignedShippingLinkRateLimit,
  exchange: exchangeSupplementalPaymentOffer,
  recordFailure: recordShippingLinkFailure,
  validateBearer: validateSupplementalPaymentOfferBearer,
};

export function createSupplementalPaymentOfferLinkHandlers(
  dependencies: SupplementalPaymentOfferLinkDependencies = defaultDependencies,
): {
  GET: (request: NextRequest) => Promise<Response>;
  POST: (request: NextRequest) => Promise<Response>;
} {
  const fail = async (): Promise<NextResponse> => {
    await dependencies.recordFailure().catch(() => undefined);
    return unavailable();
  };

  return {
    GET: async (request) => {
      if (await dependencies.checkBlocked().catch(() => true)) {
        return unavailable();
      }
      const token = request.nextUrl.searchParams.get("token") ?? "";
      if (
        !token ||
        !(await allowed(request, token, dependencies)) ||
        !(await dependencies.validateBearer(token).catch(() => false))
      ) {
        return fail();
      }
      const response = NextResponse.redirect(
        new URL("/orders/payment-offer/interstitial", request.nextUrl.origin),
        303,
      );
      response.cookies.set(
        SUPPLEMENTAL_PAYMENT_OFFER_BEARER_COOKIE,
        token,
        bearerCookieOptions(),
      );
      return secure(response);
    },
    POST: async (request) => {
      if (request.headers.get("origin") !== request.nextUrl.origin) {
        return fail();
      }
      try {
        dependencies.assertMutationAllowed();
      } catch {
        return fail();
      }
      if (await dependencies.checkBlocked().catch(() => true)) {
        return unavailable();
      }
      const bearer =
        request.cookies.get(SUPPLEMENTAL_PAYMENT_OFFER_BEARER_COOKIE)?.value ??
        "";
      if (!bearer || !(await allowed(request, bearer, dependencies))) {
        return fail();
      }
      const sessionToken = await dependencies
        .exchange(bearer)
        .catch(() => null);
      if (!sessionToken) return fail();
      const response = NextResponse.redirect(
        new URL("/orders/payment-offer", request.nextUrl.origin),
        303,
      );
      response.cookies.set(SUPPLEMENTAL_PAYMENT_OFFER_COOKIE, sessionToken, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/orders/payment-offer",
        maxAge: 24 * 60 * 60,
      });
      response.cookies.set(SUPPLEMENTAL_PAYMENT_OFFER_BEARER_COOKIE, "", {
        ...bearerCookieOptions(),
        maxAge: 0,
      });
      return secure(response);
    },
  };
}

async function allowed(
  request: NextRequest,
  subject: string,
  dependencies: SupplementalPaymentOfferLinkDependencies,
): Promise<boolean> {
  const subjectKey = buildBookingAbuseKey({
    headers: request.headers,
    scope: "supplemental-payment-offer",
    subject,
  });
  const ipKey = buildBookingAbuseKey({
    headers: request.headers,
    scope: "supplemental-payment-offer",
    subject: "all-links",
  });
  if (!subjectKey || !ipKey) return false;
  try {
    const now = new Date();
    const [subjectDecision, ipDecision] = await Promise.all([
      dependencies.checkRateLimit({ key: subjectKey, now }),
      dependencies.checkRateLimit({ key: ipKey, now }),
    ]);
    return subjectDecision.allowed && ipDecision.allowed;
  } catch {
    return false;
  }
}

export function secureSupplementalPaymentOfferResponse<
  TResponse extends NextResponse,
>(response: TResponse): TResponse {
  return secure(response);
}

function secure<TResponse extends NextResponse>(
  response: TResponse,
): TResponse {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  return response;
}

function bearerCookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "strict" as const,
    path: "/orders/payment-offer",
    maxAge: 5 * 60,
  };
}

function unavailable(): NextResponse {
  return secure(
    NextResponse.json(
      { error: "Payment offer is unavailable" },
      { status: 404 },
    ),
  );
}
