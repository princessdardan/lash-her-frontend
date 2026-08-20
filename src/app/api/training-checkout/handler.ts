import { NextResponse, type NextRequest } from "next/server";

import type { ValidatedCart } from "@/lib/commerce/cart";
import { parsePromotionCodeInput } from "@/lib/commerce/discounts";
import {
  validateTrainingCheckoutRequest,
  type TrainingCheckoutQuote,
} from "@/lib/training-checkout";
import type { TTrainingProgram } from "@/types";
import type { TPromotionCode } from "@/types";

type TrainingCheckoutResponseBody = { orderId: string; status: "paid" };

interface TrainingCheckoutErrorBody {
  error: string;
}

interface TrainingCheckoutPaymentInput {
  sourceId: string;
  verificationToken?: string;
}

interface TrainingCheckoutPostHandlerDependencies {
  getTrainingProgramBySlug: (slug: string) => Promise<TTrainingProgram | null>;
  getPromotionCode: (code: string) => Promise<TPromotionCode | null>;
  createTrainingEnrollment: (
    input: TrainingCheckoutEnrollmentInput,
  ) => Promise<unknown>;
  /** When true, a request carrying `payment.sourceId` is charged via Square. */
  squareCommerceEnabled?: boolean;
  reserveSquareTrainingOrder?: (input: {
    customerName: string;
    customerEmail: string;
    programSlug: string;
    amountCents: number;
    merchandiseAmountCents: number;
    taxAmountCents: number;
    cart: ValidatedCart;
  }) => Promise<{ orderId: string; databaseId: string }>;
  chargeSquareTrainingOrder?: (input: {
    orderReference: string;
    amountCents: number;
    currency: "CAD";
    sourceId: string;
    verificationToken?: string;
    origin?: string;
  }) => Promise<
    | { ok: true; squarePaymentId: string; transition: string }
    | { ok: false; reason: string }
  >;
  markTrainingOrderVerificationFailed?: (orderId: string) => Promise<void>;
}

interface TrainingCheckoutEnrollmentInput {
  checkoutEmail: string;
  checkoutOrderId: string;
  programSnapshot: {
    id: string;
    slug: string;
    title: string;
  };
  productSnapshot: {
    id: string;
    title: string;
    sku: string;
    priceCents: number;
    currency: "CAD";
  };
}

export function createTrainingCheckoutPostHandler({
  getTrainingProgramBySlug,
  getPromotionCode,
  createTrainingEnrollment,
  squareCommerceEnabled,
  reserveSquareTrainingOrder,
  chargeSquareTrainingOrder,
  markTrainingOrderVerificationFailed,
}: TrainingCheckoutPostHandlerDependencies): (
  req: NextRequest,
) => Promise<Response> {
  return async function trainingCheckoutPostHandler(
    req: NextRequest,
  ): Promise<Response> {
    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return invalidTrainingCheckoutRequest();
    }

    const programSlug = parseProgramSlug(body);

    if (programSlug === null) {
      return invalidTrainingCheckoutRequest();
    }

    try {
      const requestedPromotionCode = parsePromotionCodeInput(
        isRecord(body) ? (body.promotionCode ?? body.discountCode) : undefined,
      );
      if (requestedPromotionCode === null) {
        return NextResponse.json<TrainingCheckoutErrorBody>(
          { error: "Invalid promotion code" },
          { status: 400 },
        );
      }

      const [program, promotionCode] = await Promise.all([
        getTrainingProgramBySlug(programSlug),
        requestedPromotionCode
          ? getPromotionCode(requestedPromotionCode)
          : Promise.resolve(null),
      ]);
      const validation = validateTrainingCheckoutRequest(
        program,
        body,
        promotionCode,
      );

      if (!validation.ok) {
        return NextResponse.json<TrainingCheckoutErrorBody>(
          { error: "Invalid training checkout request" },
          { status: 400 },
        );
      }

      const { quote } = validation;

      // Square embedded-card path: reserve the order + enrollment, then charge
      // synchronously. Manual Afterpay/BNPL stays on its own invoice endpoint.
      const payment = parseTrainingPayment(body);
      if (
        squareCommerceEnabled &&
        reserveSquareTrainingOrder &&
        chargeSquareTrainingOrder &&
        payment
      ) {
        const reserved = await reserveSquareTrainingOrder({
          customerName: quote.customerName,
          customerEmail: quote.customerEmail,
          programSlug: quote.programSlug,
          amountCents: toCents(quote.total),
          merchandiseAmountCents: toCents(quote.subtotal),
          taxAmountCents: toCents(quote.tax),
          cart: toTrainingCart(quote),
        });

        await createTrainingEnrollment({
          checkoutEmail: quote.customerEmail,
          checkoutOrderId: reserved.databaseId,
          programSnapshot: {
            id: quote.programId,
            slug: quote.programSlug,
            title: quote.programTitle,
          },
          productSnapshot: {
            id: quote.productId,
            title: quote.productTitle,
            sku: quote.productSku,
            priceCents: toCents(quote.subtotal),
            currency: quote.currency,
          },
        });

        const charge = await chargeSquareTrainingOrder({
          orderReference: reserved.orderId,
          amountCents: toCents(quote.total),
          currency: "CAD",
          sourceId: payment.sourceId,
          ...(payment.verificationToken
            ? { verificationToken: payment.verificationToken }
            : {}),
          // Server-derived origin (not the client Origin header) for the URL
          // embedded in the scheduling email, matching the product checkout path.
          origin: resolveTrainingRequestOrigin(req),
        });

        if (!charge.ok) {
          if (markTrainingOrderVerificationFailed) {
            await markTrainingOrderVerificationFailed(reserved.orderId).catch(
              () => undefined,
            );
          }
          return NextResponse.json<TrainingCheckoutErrorBody>(
            { error: "Payment could not be completed" },
            { status: 402 },
          );
        }

        return NextResponse.json<TrainingCheckoutResponseBody>({
          orderId: reserved.orderId,
          status: "paid",
        });
      }

      // Square is the only training checkout gateway. Reaching here means the
      // request carried no card nonce or Square commerce checkout is disabled.
      return NextResponse.json<TrainingCheckoutErrorBody>(
        payment
          ? { error: "Training checkout is temporarily unavailable" }
          : { error: "Invalid training checkout request" },
        { status: payment ? 503 : 400 },
      );
    } catch (error) {
      console.error("[training-checkout] Unable to initialize checkout", {
        error:
          error instanceof Error
            ? error.message
            : "Unknown training checkout error",
      });

      return NextResponse.json<TrainingCheckoutErrorBody>(
        { error: "Unable to start training checkout" },
        { status: 400 },
      );
    }
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  const [
    { loaders },
    orderStore,
    { createTrainingEnrollment },
    privateCheckout,
    squareTraining,
  ] = await Promise.all([
    import("@/data/loaders"),
    import("@/lib/commerce/order-store"),
    import("@/lib/commerce/training-enrollment-store"),
    import("@/lib/env/private-checkout"),
    import("@/lib/commerce/square-training-checkout"),
  ]);

  const squareCommerceEnabled =
    privateCheckout.isSquareCommerceCheckoutEnabled();

  return createTrainingCheckoutPostHandler({
    getTrainingProgramBySlug: (slug) =>
      loaders.getTrainingProgramBySlug(slug, {
        mode: "published",
        stega: false,
      }),
    getPromotionCode: loaders.getPromotionCode,
    createTrainingEnrollment,
    squareCommerceEnabled,
    ...(squareCommerceEnabled
      ? {
          reserveSquareTrainingOrder:
            orderStore.createPendingSquareTrainingCardOrder,
          chargeSquareTrainingOrder:
            squareTraining.createLiveSquareTrainingCharger(),
          markTrainingOrderVerificationFailed:
            orderStore.markOrderVerificationFailed,
        }
      : {}),
  })(req);
}

function resolveTrainingRequestOrigin(req: NextRequest): string {
  return req.nextUrl?.origin ?? new URL(req.url).origin;
}

function parseTrainingPayment(
  body: unknown,
): TrainingCheckoutPaymentInput | null {
  if (!isRecord(body) || !isRecord(body.payment)) {
    return null;
  }

  const sourceId =
    typeof body.payment.sourceId === "string"
      ? body.payment.sourceId.trim()
      : "";
  if (!sourceId || sourceId.length > 512) {
    return null;
  }

  const rawToken = body.payment.verificationToken;
  const verificationToken =
    typeof rawToken === "string" &&
    rawToken.trim().length > 0 &&
    rawToken.length <= 2048
      ? rawToken.trim()
      : undefined;

  return {
    sourceId,
    ...(verificationToken ? { verificationToken } : {}),
  };
}

function parseProgramSlug(body: unknown): string | null {
  if (!isRecord(body) || typeof body.programSlug !== "string") {
    return null;
  }

  const programSlug = body.programSlug.trim();

  return programSlug.length > 0 ? programSlug : null;
}

function toTrainingCart(quote: TrainingCheckoutQuote): ValidatedCart {
  const amountBeforePromotion = quote.subtotal + quote.promotionDiscount;
  const originalTotal =
    (quote.originalSubtotal ?? amountBeforePromotion) + quote.tax;

  return {
    amount: quote.total,
    currency: "CAD",
    ...(quote.promotionDiscount > 0 ? { amountBeforePromotion } : {}),
    ...(quote.originalSubtotal !== undefined || quote.promotionDiscount > 0
      ? { originalAmount: originalTotal }
      : {}),
    ...(quote.manualDiscount > 0
      ? { manualDiscountAmount: quote.manualDiscount }
      : {}),
    ...(quote.promotionCode ? { promotionCode: quote.promotionCode } : {}),
    ...(quote.promotionDiscount > 0
      ? { promotionDiscountAmount: quote.promotionDiscount }
      : {}),
    lineItems: [
      {
        productId: quote.productId,
        sku: quote.productSku,
        description: `${quote.productTitle} — full training enrollment with Ontario HST`,
        quantity: 1,
        price: quote.total,
        ...(quote.originalSubtotal !== undefined || quote.promotionDiscount > 0
          ? { originalPrice: originalTotal }
          : {}),
        ...(quote.manualDiscount > 0
          ? { manualDiscount: quote.manualDiscount }
          : {}),
        total: quote.total,
        ...(quote.originalSubtotal !== undefined || quote.promotionDiscount > 0
          ? { originalTotal }
          : {}),
      },
    ],
  };
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidTrainingCheckoutRequest(): NextResponse<TrainingCheckoutErrorBody> {
  return NextResponse.json<TrainingCheckoutErrorBody>(
    { error: "Invalid training checkout request" },
    { status: 400 },
  );
}
