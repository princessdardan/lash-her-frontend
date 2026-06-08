import "server-only";

import { createHash, createHmac } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";
import { nanoid } from "nanoid";

import { getSquareServiceBookingEnv } from "@/lib/env/private-checkout";
import { appointmentHolds, checkoutOrders } from "@/lib/private-db/schema";
import { getPrivateDb } from "@/lib/private-db/client";

import type { BookingHoldRecord } from "./holds";
import {
  buildBookingPaymentCart,
  getBookingPaymentSelection,
  toBookingPaymentAmountCents,
  type BookingPaymentSelection,
} from "./payment-policy";
import {
  calculateServiceBookingHstQuote,
  SERVICE_BOOKING_HST_PERCENTAGE,
  SERVICE_BOOKING_HST_TAX_NAME,
  SERVICE_BOOKING_HST_TAX_UID,
  type ServiceBookingHstQuote,
} from "./service-tax-policy";
import type { SquareClient, SquarePaymentLink } from "./square-client";

export interface SquareServiceCheckoutInput {
  hold: BookingHoldRecord;
  now?: Date;
  request?: Request;
}

export interface SquareServiceCheckoutResult {
  checkoutUrl: string;
  holdReference: string;
  orderId: string;
  reused: boolean;
  squareOrderId?: string;
  squarePaymentLinkId: string;
}

export interface PersistSquareServiceCheckoutInput {
  amountCents: number;
  hold: BookingHoldRecord;
  idempotencyKey: string;
  locationId: string;
  now: Date;
  orderId: string;
  paymentLink: SquarePaymentLink;
  paymentSelection: BookingPaymentSelection;
  taxQuote: ServiceBookingHstQuote;
}

export interface SquarePendingServiceCheckout {
  checkoutUrl: string;
  orderId: string;
  squareOrderId?: string;
  squarePaymentLinkId: string;
}

export interface SquareServiceCheckoutRepository {
  findPendingCheckoutForHold(holdId: string): Promise<SquarePendingServiceCheckout | null>;
  persistPendingCheckout(input: PersistSquareServiceCheckoutInput): Promise<SquarePendingServiceCheckout>;
}

export interface SquareServiceCheckoutDependencies {
  getEnv: typeof getSquareServiceBookingEnv;
  repository: SquareServiceCheckoutRepository;
  squareClientFactory: (env: NonNullable<ReturnType<typeof getSquareServiceBookingEnv>>) => SquareClient;
}

export function createSquareServiceCheckout(
  dependencies: SquareServiceCheckoutDependencies,
): (input: SquareServiceCheckoutInput) => Promise<SquareServiceCheckoutResult> {
  return async function squareServiceCheckout(input) {
    const now = input.now ?? new Date();
    const env = dependencies.getEnv();

    if (env === null) {
      throw new Error("Square service booking checkout is not enabled");
    }

    const reusableCheckout = await dependencies.repository.findPendingCheckoutForHold(input.hold.id);

    if (reusableCheckout !== null) {
      return toSquareServiceCheckoutResult(input.hold, reusableCheckout, true);
    }

    if (input.hold.state !== "held" || input.hold.expiresAt <= now) {
      throw new Error("Booking hold is no longer available");
    }

    const paymentSelection = getBookingPaymentSelection(input.hold);

    if (paymentSelection === null) {
      throw new Error("Booking payment is not configured");
    }

    const amountCents = toBookingPaymentAmountCents(paymentSelection);
    const taxQuote = calculateServiceBookingHstQuote(amountCents);
    const idempotencyKey = buildSquareServiceCheckoutIdempotencyKey(input.hold, amountCents, taxQuote.expectedAmountCents);
    const orderId = `lh-sq-${nanoid(12)}`;
    const paymentLink = await dependencies.squareClientFactory(env).createPaymentLink({
      idempotency_key: idempotencyKey,
      order: {
        location_id: env.locationId,
        reference_id: orderId,
        line_items: [
          {
            applied_taxes: [{ tax_uid: SERVICE_BOOKING_HST_TAX_UID }],
            name: paymentSelection.description,
            quantity: "1",
            base_price_money: {
              amount: amountCents,
              currency: "CAD",
            },
            note: `Lash Her ${paymentSelection.sku}`,
          },
        ],
        taxes: [{
          name: SERVICE_BOOKING_HST_TAX_NAME,
          percentage: SERVICE_BOOKING_HST_PERCENTAGE,
          scope: "LINE_ITEM",
          type: "ADDITIVE",
          uid: SERVICE_BOOKING_HST_TAX_UID,
        }],
        metadata: {
          lh_hold_id: input.hold.id,
          lh_hold_reference: input.hold.publicReference,
          lh_order_id: orderId,
        },
      },
      checkout_options: {
        allow_tipping: true,
        redirect_url: env.serviceBookingReturnUrl,
      },
      payment_note: `Lash Her booking hold ${input.hold.publicReference} order ${orderId}`,
    });

    const persistedCheckout = await dependencies.repository.persistPendingCheckout({
      amountCents: taxQuote.expectedAmountCents,
      hold: input.hold,
      idempotencyKey,
      locationId: env.locationId,
      now,
      orderId,
      paymentLink: paymentLink.payment_link,
      paymentSelection,
      taxQuote,
    });

    return toSquareServiceCheckoutResult(input.hold, persistedCheckout, false);
  };
}

export async function createSquareServiceBookingCheckout(
  input: SquareServiceCheckoutInput,
): Promise<SquareServiceCheckoutResult> {
  const { createSquareServiceBookingClient, getSquareServiceBookingRuntimeEnv } = await import("./square-runtime");

  return createSquareServiceCheckout({
    getEnv: getSquareServiceBookingRuntimeEnv,
    repository: createDrizzleSquareServiceCheckoutRepository(),
    squareClientFactory: (env) => createSquareServiceBookingClient({
      env,
      now: input.now,
      request: input.request,
    }),
  })(input);
}

export function buildSquareServiceCheckoutIdempotencyKey(
  hold: Pick<BookingHoldRecord, "id" | "publicReference">,
  amountCents: number,
  expectedAmountCents = amountCents,
): string {
  const digest = createHash("sha256")
    .update(`${hold.id}:${hold.publicReference}:${amountCents}:${expectedAmountCents}:${calculateServiceBookingHstQuote(amountCents).policyVersion}`, "utf8")
    .digest("hex")
    .slice(0, 32);

  return `svc_${digest}`;
}

function createDrizzleSquareServiceCheckoutRepository(): SquareServiceCheckoutRepository {
  return {
    async findPendingCheckoutForHold(holdId) {
      const [row] = await getPrivateDb()
        .select()
        .from(appointmentHolds)
        .where(eq(appointmentHolds.id, holdId))
        .limit(1);

      if (
        row?.status !== "payment_pending" ||
        row.paymentProvider !== "square" ||
        row.squarePaymentLinkId === null ||
        row.squarePaymentLinkUrl === null ||
        row.checkoutOrderPublicId === null
      ) {
        return null;
      }

      return {
        checkoutUrl: row.squarePaymentLinkUrl,
        orderId: row.checkoutOrderPublicId,
        squareOrderId: row.squareOrderId ?? undefined,
        squarePaymentLinkId: row.squarePaymentLinkId,
      };
    },

    async persistPendingCheckout(input) {
      return getPrivateDb().transaction(async (tx) => {
        const [{ encryptCheckoutSecret }, { getCheckoutSecretEncryptionKey }] = await Promise.all([
          import("@/lib/commerce/checkout-secret"),
          import("@/sanity/env"),
        ]);
        const cart = buildBookingPaymentCart(input.hold, input.paymentSelection);
        const [createdOrder] = await tx
          .insert(checkoutOrders)
          .values({
            amountCents: input.amountCents,
            calendarFinalizationStatus: "pending",
            checkoutTokenHash: hashSquareCheckoutToken(
              input.idempotencyKey,
              getCheckoutSecretEncryptionKey(),
            ),
            createdAt: input.now,
            currency: "CAD",
            customerEmail: input.hold.customer.email,
            customerName: input.hold.customer.name,
            lineItems: cart.lineItems.map((lineItem) => ({
              productId: lineItem.productId,
              sku: lineItem.sku,
              description: lineItem.description,
              quantity: lineItem.quantity,
              unitPriceCents: input.taxQuote.taxableAmountCents,
              totalCents: input.taxQuote.taxableAmountCents,
            })),
            orderId: input.orderId,
            paymentProvider: "square",
            providerCheckoutId: input.paymentLink.id,
            providerMetadata: {
              holdId: input.hold.id,
              holdReference: input.hold.publicReference,
              idempotencyKey: input.idempotencyKey,
              tax: input.taxQuote,
            },
            providerOrderId: input.paymentLink.order_id,
            providerStatus: "payment_link_created",
            purpose: input.paymentSelection.purpose,
            secretTokenCiphertext: encryptCheckoutSecret(input.idempotencyKey),
            squareLocationId: input.locationId,
            squarePaymentLinkId: input.paymentLink.id,
            squarePaymentLinkUrl: input.paymentLink.url,
            status: "pending",
            updatedAt: input.now,
          })
          .returning({ id: checkoutOrders.id });

        const [updatedHold] = await tx
          .update(appointmentHolds)
          .set({
            checkoutOrderId: createdOrder.id,
            checkoutOrderPublicId: input.orderId,
            finalizationStatus: "pending",
            paymentProvider: "square",
            reconciliationMetadata: {
              idempotencyKey: input.idempotencyKey,
              squareLocationId: input.locationId,
              tax: input.taxQuote,
            },
            squareCheckoutId: input.paymentLink.id,
            squareOrderId: input.paymentLink.order_id,
            squarePaymentLinkId: input.paymentLink.id,
            squarePaymentLinkUrl: input.paymentLink.url,
            status: "payment_pending",
            updatedAt: input.now,
          })
          .where(
            and(
              eq(appointmentHolds.id, input.hold.id),
              eq(appointmentHolds.status, "held"),
              gt(appointmentHolds.expiresAt, input.now),
            ),
          )
          .returning({ id: appointmentHolds.id });

        if (updatedHold === undefined) {
          throw new Error("Booking hold is no longer available");
        }

        return {
          checkoutUrl: input.paymentLink.url,
          orderId: input.orderId,
          squareOrderId: input.paymentLink.order_id,
          squarePaymentLinkId: input.paymentLink.id,
        };
      });
    },
  };
}

function toSquareServiceCheckoutResult(
  hold: BookingHoldRecord,
  checkout: SquarePendingServiceCheckout,
  reused: boolean,
): SquareServiceCheckoutResult {
  return {
    checkoutUrl: checkout.checkoutUrl,
    holdReference: hold.publicReference,
    orderId: checkout.orderId,
    reused,
    squareOrderId: checkout.squareOrderId,
    squarePaymentLinkId: checkout.squarePaymentLinkId,
  };
}

function hashSquareCheckoutToken(idempotencyKey: string, encryptionKey: Buffer): string {
  return createHmac("sha256", encryptionKey)
    .update(idempotencyKey, "utf8")
    .digest("hex");
}
