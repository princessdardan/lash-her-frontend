import { NextResponse, type NextRequest } from "next/server";

import type { ValidatedCart } from "@/lib/commerce/cart";
import { parsePromotionCodeInput } from "@/lib/commerce/discounts";
import type { HelcimGateway } from "@/lib/commerce/helcim-gateway";
import { createPaymentMockStore } from "@/lib/payment-mocks/in-memory-store";
import {
  TRAINING_CHECKOUT_TAX_RATE,
  validateTrainingCheckoutRequest,
  type TrainingCheckoutQuote,
} from "@/lib/training-checkout";
import type { TTrainingProgram } from "@/types";
import type { TPromotionCode } from "@/types";

const trainingCheckoutPaymentMockStore = createPaymentMockStore();

interface TrainingCheckoutResponseBody {
  checkoutToken: string;
}

interface TrainingCheckoutErrorBody {
  error: string;
}

interface TrainingCheckoutPostHandlerDependencies {
  getTrainingProgramBySlug: (slug: string) => Promise<TTrainingProgram | null>;
  getPromotionCode: (code: string) => Promise<TPromotionCode | null>;
  createHelcimInvoice: (input: TrainingCheckoutInvoiceInput) => Promise<TrainingCheckoutInvoice>;
  initializeHelcimPay: (input: TrainingCheckoutPaySessionInput) => Promise<TrainingCheckoutPaySession>;
  createPendingOrder: (input: TrainingCheckoutPendingOrderInput) => Promise<TrainingCheckoutPendingOrder>;
  createTrainingEnrollment: (input: TrainingCheckoutEnrollmentInput) => Promise<unknown>;
}

interface TrainingCheckoutInvoiceInput {
  currency: "CAD";
  type: "INVOICE";
  status: "DUE";
  notes: string;
  lineItems: Array<{
    sku: string;
    description: string;
    quantity: number;
    price: number;
    discountCode?: string;
    taxAmount: number;
    taxName: string;
    taxRate: number;
  }>;
}

interface TrainingCheckoutInvoice {
  invoiceId: number;
  invoiceNumber: string;
}

interface TrainingCheckoutPaySessionInput {
  paymentType: "purchase";
  amount: number;
  currency: "CAD";
  invoiceNumber: string;
}

interface TrainingCheckoutPaySession {
  checkoutToken: string;
  secretToken: string;
}

interface TrainingCheckoutPendingOrderInput {
  customerName: string;
  customerEmail: string;
  checkoutToken: string;
  secretToken: string;
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
  cart: ValidatedCart;
}

interface TrainingCheckoutPendingOrder {
  _id: string;
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
  createHelcimInvoice,
  initializeHelcimPay,
  createPendingOrder,
  createTrainingEnrollment,
}: TrainingCheckoutPostHandlerDependencies): (req: NextRequest) => Promise<Response> {
  return async function trainingCheckoutPostHandler(req: NextRequest): Promise<Response> {
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
      const requestedPromotionCode = parsePromotionCodeInput(isRecord(body) ? body.promotionCode ?? body.discountCode : undefined);
      if (requestedPromotionCode === null) {
        return NextResponse.json<TrainingCheckoutErrorBody>(
          { error: "Invalid promotion code" },
          { status: 400 },
        );
      }

      const [program, promotionCode] = await Promise.all([
        getTrainingProgramBySlug(programSlug),
        requestedPromotionCode ? getPromotionCode(requestedPromotionCode) : Promise.resolve(null),
      ]);
      const validation = validateTrainingCheckoutRequest(program, body, promotionCode);

      if (!validation.ok) {
        return NextResponse.json<TrainingCheckoutErrorBody>(
          { error: "Invalid training checkout request" },
          { status: 400 },
        );
      }

      const { quote } = validation;
      const invoice = await createHelcimInvoice({
        currency: "CAD",
        type: "INVOICE",
        status: "DUE",
        notes: `Lash Her training checkout: ${quote.programTitle}`,
        lineItems: [
          {
            sku: quote.productSku,
            description: quote.productTitle,
            quantity: 1,
            price: quote.subtotal,
            ...(quote.promotionCode ? { discountCode: quote.promotionCode } : {}),
            taxAmount: quote.tax,
            taxName: "Ontario HST",
            taxRate: TRAINING_CHECKOUT_TAX_RATE,
          },
        ],
      });

      const helcimPaySession = await initializeHelcimPay({
        paymentType: "purchase",
        amount: quote.total,
        currency: "CAD",
        invoiceNumber: invoice.invoiceNumber,
      });

      const pendingOrder = await createPendingOrder({
        customerName: quote.customerName,
        customerEmail: quote.customerEmail,
        checkoutToken: helcimPaySession.checkoutToken,
        secretToken: helcimPaySession.secretToken,
        helcimInvoiceId: invoice.invoiceId,
        helcimInvoiceNumber: invoice.invoiceNumber,
        cart: toTrainingCart(quote),
      });

      await createTrainingEnrollment({
        checkoutEmail: quote.customerEmail,
        checkoutOrderId: pendingOrder._id,
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

      return NextResponse.json<TrainingCheckoutResponseBody>({
        checkoutToken: helcimPaySession.checkoutToken,
      });
    } catch (error) {
      console.error("[training-checkout] Unable to initialize checkout", {
        error: error instanceof Error ? error.message : "Unknown training checkout error",
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
    gateway,
    { createPendingOrder },
    { createTrainingEnrollment },
  ] = await Promise.all([
    import("@/data/loaders"),
    resolveTrainingCheckoutHelcimGatewayForRequest(req),
    import("@/lib/commerce/order-store"),
    import("@/lib/commerce/training-enrollment-store"),
  ]);

  return createTrainingCheckoutPostHandler({
    getTrainingProgramBySlug: (slug) => loaders.getTrainingProgramBySlug(slug, { mode: "published", stega: false }),
    getPromotionCode: loaders.getPromotionCode,
    createHelcimInvoice: gateway.createInvoice,
    initializeHelcimPay: gateway.initializePay,
    createPendingOrder,
    createTrainingEnrollment,
  })(req);
}

export async function resolveTrainingCheckoutHelcimGatewayForRequest(req: Request): Promise<HelcimGateway> {
  const runtimeControls = await import("@/lib/payment-mocks/runtime-controls");
  const runtimeEnvironment = getPaymentMockRuntimeEnvironment();

  runtimeControls.assertPaymentMockAllowed({ env: runtimeEnvironment, request: req });

  if (runtimeControls.resolvePaymentGatewayMode(runtimeEnvironment) !== "mock") {
    const liveGateway = await import("@/lib/commerce/helcim-gateway");
    return liveGateway.createLiveHelcimGateway();
  }

  const mockGateway = await import("@/lib/commerce/helcim-mock-gateway");

  return mockGateway.createMockHelcimGateway({
    scenario: runtimeControls.resolvePaymentMockScenario({
      env: runtimeEnvironment,
      now: new Date(),
      request: req,
    }),
    store: trainingCheckoutPaymentMockStore,
  });
}

function getPaymentMockRuntimeEnvironment() {
  return {
    NODE_ENV: process.env.NODE_ENV,
    PAYMENT_GATEWAY_MODE: process.env.PAYMENT_GATEWAY_MODE,
    PAYMENT_MOCK_DEFAULT_SCENARIO: process.env.PAYMENT_MOCK_DEFAULT_SCENARIO,
    VERCEL_ENV: process.env.VERCEL_ENV,
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
  const originalTotal = (quote.originalSubtotal ?? amountBeforePromotion) + quote.tax;

  return {
    amount: quote.total,
    currency: "CAD",
    ...(quote.promotionDiscount > 0 ? { amountBeforePromotion } : {}),
    ...(quote.originalSubtotal !== undefined || quote.promotionDiscount > 0 ? { originalAmount: originalTotal } : {}),
    ...(quote.manualDiscount > 0 ? { manualDiscountAmount: quote.manualDiscount } : {}),
    ...(quote.promotionCode ? { promotionCode: quote.promotionCode } : {}),
    ...(quote.promotionDiscount > 0 ? { promotionDiscountAmount: quote.promotionDiscount } : {}),
    lineItems: [
      {
        productId: quote.productId,
        sku: quote.productSku,
        description: `${quote.productTitle} — full training enrollment with Ontario HST`,
        quantity: 1,
        price: quote.total,
        ...(quote.originalSubtotal !== undefined || quote.promotionDiscount > 0 ? { originalPrice: originalTotal } : {}),
        ...(quote.manualDiscount > 0 ? { manualDiscount: quote.manualDiscount } : {}),
        total: quote.total,
        ...(quote.originalSubtotal !== undefined || quote.promotionDiscount > 0 ? { originalTotal } : {}),
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
