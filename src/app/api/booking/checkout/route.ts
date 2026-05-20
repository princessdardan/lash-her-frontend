import { NextResponse, type NextRequest } from "next/server";

import type { ValidatedCart } from "@/lib/commerce/cart";
import type { PendingOrderRecord } from "@/lib/commerce/order-store";
import type { CheckoutOrderPurpose } from "@/lib/private-db/schema";
import type { BookingHoldRecord } from "@/lib/booking/holds";

interface BookingCheckoutRequestBody {
  holdReference: string;
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
  currency: "CAD";
  paymentMode: "deposit" | "full" | "customPartial";
  selectedPayment: BookingPaymentSelection;
  title: string;
}

interface BookingPaymentSelection {
  amount: number;
  description: string;
  purpose: Extract<CheckoutOrderPurpose, "appointment_deposit" | "appointment_full" | "appointment_custom_partial">;
  sku: "BOOKING-DEPOSIT" | "BOOKING-FULL" | "BOOKING-CUSTOM-PARTIAL";
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

      const paymentSelection = getPaymentSelection(hold);

      if (paymentSelection === null) {
        return NextResponse.json(
          { error: "Booking payment is not configured" },
          { status: 400 },
        );
      }

      const cart = buildBookingCart(hold, paymentSelection);
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
  const [helcimModule, orderStoreModule, holdsModule] = await Promise.all([
    import("@/lib/commerce/helcim-client"),
    import("@/lib/commerce/order-store"),
    import("@/lib/booking/holds"),
  ]);

  return createBookingCheckoutPostHandler({
    createHelcimInvoice: helcimModule.createHelcimInvoice,
    createPendingOrder: orderStoreModule.createPendingOrder,
    getAppointmentHoldByPublicReference: holdsModule.getAppointmentHoldByPublicReference,
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

  return { holdReference };
}

function getPaymentSelection(hold: BookingHoldRecord): BookingPaymentSelection | null {
  const snapshot = toBookingOfferingSnapshot(hold.offeringSnapshot);

  if (snapshot === null) {
    return null;
  }

  return snapshot.selectedPayment;
}

function toBookingOfferingSnapshot(value: Record<string, unknown>): BookingOfferingSnapshot | null {
  const paymentMode = value.paymentMode;
  const currency = value.currency;
  const selectedPayment = toBookingPaymentSelection(value.selectedPayment);
  const title = typeof value.title === "string" && value.title.trim().length > 0
    ? value.title.trim()
    : null;

  if (
    paymentMode !== "deposit" &&
    paymentMode !== "full" &&
    paymentMode !== "customPartial"
  ) {
    return null;
  }

  if (currency !== "CAD" || title === null || selectedPayment === null) {
    return null;
  }

  return {
    currency,
    paymentMode,
    selectedPayment,
    title,
  };
}

function getHoldOfferingTitle(hold: BookingHoldRecord): string {
  const snapshot = toBookingOfferingSnapshot(hold.offeringSnapshot);

  return snapshot?.title ?? hold.offeringId;
}

function buildBookingCart(
  hold: BookingHoldRecord,
  paymentSelection: BookingPaymentSelection,
): ValidatedCart {
  return {
    amount: paymentSelection.amount,
    currency: "CAD",
    lineItems: [
      {
        productId: `booking:${hold.id}`,
        sku: paymentSelection.sku,
        description: paymentSelection.description,
        quantity: 1,
        price: paymentSelection.amount,
        total: paymentSelection.amount,
      },
    ],
  };
}

function toPositiveAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value * 100) / 100;
}

function toBookingPaymentSelection(value: unknown): BookingPaymentSelection | null {
  if (!isRecord(value)) {
    return null;
  }

  const amount = toPositiveAmount(value.amount);
  const description = typeof value.description === "string" && value.description.trim().length > 0
    ? value.description.trim()
    : null;

  if (amount === null || description === null) {
    return null;
  }

  if (
    value.purpose !== "appointment_deposit" &&
    value.purpose !== "appointment_full" &&
    value.purpose !== "appointment_custom_partial"
  ) {
    return null;
  }

  if (
    value.sku !== "BOOKING-DEPOSIT" &&
    value.sku !== "BOOKING-FULL" &&
    value.sku !== "BOOKING-CUSTOM-PARTIAL"
  ) {
    return null;
  }

  return {
    amount,
    description,
    purpose: value.purpose,
    sku: value.sku,
  };
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
