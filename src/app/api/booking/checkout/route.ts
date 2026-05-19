import { NextResponse, type NextRequest } from "next/server";

import {
  buildValidatedCart,
  type CatalogProduct,
  type ValidatedCart,
} from "@/lib/commerce/cart";
import type { PendingOrderRecord } from "@/lib/commerce/order-store";
import type { CheckoutOrderPurpose } from "@/lib/private-db/schema";
import type { BookingHoldRecord } from "@/lib/booking/holds";
import type { TSellableProduct } from "@/types";

interface BookingCheckoutRequestBody {
  holdReference: string;
  paymentOption?: "deposit" | "full";
}

interface BookingCheckoutInvoiceInput {
  currency: "CAD";
  type: "INVOICE";
  status: "DUE";
  notes: string;
  lineItems: Array<{
    sku: string;
    description: string;
    quantity: number;
    price: number;
  }>;
}

interface BookingCheckoutInvoice {
  invoiceId: number;
  invoiceNumber: string;
}

interface BookingCheckoutPaySessionInput {
  paymentType: "purchase";
  amount: number;
  currency: "CAD";
  invoiceNumber: string;
}

interface BookingCheckoutPaySession {
  checkoutToken: string;
  secretToken: string;
}

interface BookingCheckoutPendingOrderInput {
  customerName: string;
  customerEmail: string;
  checkoutToken: string;
  secretToken: string;
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
  purpose: CheckoutOrderPurpose;
  cart: ValidatedCart;
}

interface BookingCheckoutPostHandlerDependencies {
  createHelcimInvoice: (input: BookingCheckoutInvoiceInput) => Promise<BookingCheckoutInvoice>;
  createPendingOrder: (input: BookingCheckoutPendingOrderInput) => Promise<PendingOrderRecord>;
  getAppointmentHoldByPublicReference: (publicReference: string) => Promise<BookingHoldRecord | null>;
  getSellableProductsByIds: (ids: string[]) => Promise<TSellableProduct[]>;
  initializeHelcimPay: (input: BookingCheckoutPaySessionInput) => Promise<BookingCheckoutPaySession>;
  transitionAppointmentHold: (input: {
    checkoutOrderId: string;
    checkoutOrderPublicId: string;
    helcimInvoiceId: number;
    helcimInvoiceNumber: string;
    holdId: string;
    now: Date;
    requiredState: "held";
    expiresAfter: Date;
    status: "payment_pending";
  }) => Promise<BookingHoldRecord | null>;
}

interface BookingOfferingSnapshot {
  depositProductId?: string;
  fullProductId?: string;
  paymentMode?: "deposit" | "full" | "choice";
  title?: string;
}

export function createBookingCheckoutPostHandler(
  dependencies: BookingCheckoutPostHandlerDependencies,
): (req: NextRequest) => Promise<Response> {
  return async function bookingCheckoutPostHandler(req: NextRequest): Promise<Response> {
    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return invalidBookingCheckoutRequest();
    }

    const checkoutRequest = parseBookingCheckoutRequest(body);

    if (checkoutRequest === null) {
      return invalidBookingCheckoutRequest();
    }

    try {
      const now = new Date();
      const hold = await dependencies.getAppointmentHoldByPublicReference(
        checkoutRequest.holdReference,
      );

      if (hold === null || hold.state !== "held" || hold.expiresAt <= now) {
        return NextResponse.json(
          { error: "Booking hold is no longer available" },
          { status: 409 },
        );
      }

      const paymentSelection = getPaymentSelection(hold, checkoutRequest.paymentOption);

      if (paymentSelection === null) {
        return NextResponse.json(
          { error: "Booking payment is not configured" },
          { status: 400 },
        );
      }

      const products = await dependencies.getSellableProductsByIds([paymentSelection.productId]);
      const cart = buildValidatedCart(
        [{ productId: paymentSelection.productId, quantity: 1 }],
        products.map(toCatalogProduct),
      );
      const invoice = await dependencies.createHelcimInvoice({
        currency: "CAD",
        type: "INVOICE",
        status: "DUE",
        notes: `Lash Her booking checkout: ${getHoldOfferingTitle(hold)}`,
        lineItems: cart.lineItems.map(({ sku, description, quantity, price }) => ({
          sku,
          description,
          quantity,
          price,
        })),
      });
      const helcimPaySession = await dependencies.initializeHelcimPay({
        paymentType: "purchase",
        amount: cart.amount,
        currency: "CAD",
        invoiceNumber: invoice.invoiceNumber,
      });
      const order = await dependencies.createPendingOrder({
        customerName: hold.customer.name,
        customerEmail: hold.customer.email,
        checkoutToken: helcimPaySession.checkoutToken,
        secretToken: helcimPaySession.secretToken,
        helcimInvoiceId: invoice.invoiceId,
        helcimInvoiceNumber: invoice.invoiceNumber,
        purpose: paymentSelection.purpose,
        cart,
      });
      const updatedHold = await dependencies.transitionAppointmentHold({
        checkoutOrderId: order._id,
        checkoutOrderPublicId: order.orderId,
        expiresAfter: now,
        helcimInvoiceId: invoice.invoiceId,
        helcimInvoiceNumber: invoice.invoiceNumber,
        holdId: hold.id,
        now,
        requiredState: "held",
        status: "payment_pending",
      });

      if (updatedHold === null) {
        return NextResponse.json(
          { error: "Booking hold is no longer available" },
          { status: 409 },
        );
      }

      return NextResponse.json({
        checkoutToken: helcimPaySession.checkoutToken,
        holdReference: hold.publicReference,
        orderId: order.orderId,
      });
    } catch (error) {
      console.error("[booking checkout] Unable to initialize checkout", {
        error: error instanceof Error ? error.message : "Unknown checkout error",
      });

      return NextResponse.json(
        { error: "Unable to start booking checkout" },
        { status: 400 },
      );
    }
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  const [loadersModule, helcimModule, orderStoreModule, holdsModule] = await Promise.all([
    import("@/data/loaders"),
    import("@/lib/commerce/helcim-client"),
    import("@/lib/commerce/order-store"),
    import("@/lib/booking/holds"),
  ]);

  return createBookingCheckoutPostHandler({
    createHelcimInvoice: helcimModule.createHelcimInvoice,
    createPendingOrder: orderStoreModule.createPendingOrder,
    getAppointmentHoldByPublicReference: holdsModule.getAppointmentHoldByPublicReference,
    getSellableProductsByIds: loadersModule.loaders.getSellableProductsByIds,
    initializeHelcimPay: helcimModule.initializeHelcimPay,
    transitionAppointmentHold: holdsModule.transitionAppointmentHold,
  })(req);
}

function parseBookingCheckoutRequest(body: unknown): BookingCheckoutRequestBody | null {
  if (!isRecord(body)) {
    return null;
  }

  const holdReference = parseRequiredString(body.holdReference);

  if (holdReference === null) {
    return null;
  }

  const paymentOption = parsePaymentOption(body.paymentOption);

  return {
    holdReference,
    ...(paymentOption ? { paymentOption } : {}),
  };
}

function getPaymentSelection(
  hold: BookingHoldRecord,
  paymentOption: "deposit" | "full" | undefined,
): { productId: string; purpose: Extract<CheckoutOrderPurpose, "appointment_deposit" | "appointment_full"> } | null {
  const snapshot = toBookingOfferingSnapshot(hold.offeringSnapshot);

  if (snapshot === null) {
    return null;
  }

  if (snapshot.paymentMode === "deposit") {
    return snapshot.depositProductId
      ? { productId: snapshot.depositProductId, purpose: "appointment_deposit" }
      : null;
  }

  if (snapshot.paymentMode === "full") {
    return snapshot.fullProductId
      ? { productId: snapshot.fullProductId, purpose: "appointment_full" }
      : null;
  }

  if (snapshot.paymentMode === "choice") {
    if (paymentOption === "deposit" && snapshot.depositProductId) {
      return { productId: snapshot.depositProductId, purpose: "appointment_deposit" };
    }

    if (paymentOption === "full" && snapshot.fullProductId) {
      return { productId: snapshot.fullProductId, purpose: "appointment_full" };
    }
  }

  return null;
}

function toBookingOfferingSnapshot(value: Record<string, unknown>): BookingOfferingSnapshot | null {
  const paymentMode = value.paymentMode;

  if (paymentMode !== "deposit" && paymentMode !== "full" && paymentMode !== "choice") {
    return null;
  }

  return {
    ...(typeof value.depositProductId === "string" ? { depositProductId: value.depositProductId } : {}),
    ...(typeof value.fullProductId === "string" ? { fullProductId: value.fullProductId } : {}),
    paymentMode,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
  };
}

function getHoldOfferingTitle(hold: BookingHoldRecord): string {
  const snapshot = toBookingOfferingSnapshot(hold.offeringSnapshot);

  return snapshot?.title ?? hold.offeringId;
}

function toCatalogProduct(product: TSellableProduct): CatalogProduct {
  return {
    id: product._id,
    sku: product.sku,
    title: product.title,
    price: product.price,
    currency: product.currency,
    isAvailable: product.isAvailable,
    variants: product.variants?.map((variant) => ({
      id: variant._key,
      sku: variant.sku,
      title: variant.title,
      price: variant.price,
      isAvailable: variant.isAvailable,
    })),
  };
}

function parsePaymentOption(value: unknown): "deposit" | "full" | null {
  return value === "deposit" || value === "full" ? value : null;
}

function parseRequiredString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();

  return trimmedValue.length > 0 ? trimmedValue : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidBookingCheckoutRequest(): NextResponse<{ error: string }> {
  return NextResponse.json(
    { error: "Invalid booking checkout request" },
    { status: 400 },
  );
}
