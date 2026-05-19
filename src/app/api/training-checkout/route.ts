import { NextResponse, type NextRequest } from "next/server";

import type { ValidatedCart } from "@/lib/commerce/cart";
import {
  TRAINING_CHECKOUT_TAX_RATE,
  validateTrainingCheckoutRequest,
  type TrainingCheckoutQuote,
} from "@/lib/training-checkout";
import type { TTrainingProgram } from "@/types";

interface TrainingCheckoutResponseBody {
  checkoutToken: string;
}

interface TrainingCheckoutErrorBody {
  error: string;
}

interface TrainingCheckoutPostHandlerDependencies {
  getTrainingProgramBySlug: (slug: string) => Promise<TTrainingProgram | null>;
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
      const program = await getTrainingProgramBySlug(programSlug);
      const validation = validateTrainingCheckoutRequest(program, body);

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
    { createHelcimInvoice, initializeHelcimPay },
    { createPendingOrder },
    { createTrainingEnrollment },
  ] = await Promise.all([
    import("@/data/loaders"),
    import("@/lib/commerce/helcim-client"),
    import("@/lib/commerce/order-store"),
    import("@/lib/commerce/training-enrollment-store"),
  ]);

  return createTrainingCheckoutPostHandler({
    getTrainingProgramBySlug: loaders.getTrainingProgramBySlug,
    createHelcimInvoice,
    initializeHelcimPay,
    createPendingOrder,
    createTrainingEnrollment,
  })(req);
}

function parseProgramSlug(body: unknown): string | null {
  if (!isRecord(body) || typeof body.programSlug !== "string") {
    return null;
  }

  const programSlug = body.programSlug.trim();

  return programSlug.length > 0 ? programSlug : null;
}

function toTrainingCart(quote: TrainingCheckoutQuote): ValidatedCart {
  return {
    amount: quote.total,
    currency: "CAD",
    lineItems: [
      {
        productId: quote.productId,
        sku: quote.productSku,
        description: `${quote.productTitle} — full training enrollment with Ontario HST`,
        quantity: 1,
        price: quote.total,
        total: quote.total,
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
