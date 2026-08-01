import "server-only";

import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import { getPrivateDb } from "./client";
import {
  adminUserResources,
  adminUsers,
  appointmentHolds,
  appointments,
  bookingPaymentAttempts,
  bookingProviders,
  checkoutOrders,
  type AppointmentHoldCustomerSnapshot,
  type AppointmentHoldOfferingSnapshot,
  type AppointmentHoldProviderSnapshot,
  type CheckoutOrderPurpose,
  type PaymentProvider,
} from "./schema";

type PrivateDb = ReturnType<typeof getPrivateDb>;

export interface ProviderBookingEmailClaim {
  bookingType: string;
  capturedAmountCents: number;
  currency: string;
  customer: AppointmentHoldCustomerSnapshot;
  end: Date;
  holdId: string;
  offeringSnapshot: AppointmentHoldOfferingSnapshot;
  orderId: string;
  paymentProvider: PaymentProvider;
  paymentPurpose: CheckoutOrderPurpose | null;
  providerName: string;
  recipientEmails: string[];
  start: Date;
  timezone: string;
  tipAmountCents: number;
}

export type ProviderBookingEmailLookup =
  | { holdId: string }
  | { orderId: string }
  | { publicReference: string };

export interface ClaimProviderBookingEmailInput {
  claimForMs?: number;
  lookup: ProviderBookingEmailLookup;
  now?: Date;
}

export interface ProviderBookingEmailMutationInput {
  error?: string;
  holdId: string;
  now?: Date;
}

const PROVIDER_EMAIL_CLAIM_DURATION_MS = 5 * 60_000;

export async function claimProviderBookingEmail(
  input: ClaimProviderBookingEmailInput,
  db: PrivateDb = getPrivateDb(),
): Promise<ProviderBookingEmailClaim | null> {
  const now = input.now ?? new Date();
  const claimUntil = new Date(
    now.getTime() + (input.claimForMs ?? PROVIDER_EMAIL_CLAIM_DURATION_MS),
  );

  return db.transaction(async (tx) => {
    const [hold] = await tx
      .select()
      .from(appointmentHolds)
      .where(getHoldLookupCondition(input.lookup))
      .limit(1)
      .for("update");

    if (
      hold === undefined ||
      hold.providerBookingEmailSentAt !== null ||
      (hold.providerBookingEmailClaimedUntil !== null &&
        hold.providerBookingEmailClaimedUntil > now)
    ) {
      return null;
    }

    if (!(await isSuccessfullyBooked(tx, hold))) {
      return null;
    }

    const [claimed] = await tx
      .update(appointmentHolds)
      .set({
        providerBookingEmailClaimedUntil: claimUntil,
        providerBookingEmailLastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(appointmentHolds.id, hold.id),
          isNull(appointmentHolds.providerBookingEmailSentAt),
          or(
            isNull(appointmentHolds.providerBookingEmailClaimedUntil),
            lte(appointmentHolds.providerBookingEmailClaimedUntil, now),
          ),
        ),
      )
      .returning();

    if (claimed === undefined) {
      return null;
    }

    const [checkoutOrder, capturedPayment, provider, recipients] =
      await Promise.all([
        claimed.checkoutOrderId === null
          ? Promise.resolve(undefined)
          : tx
              .select({
                amountCents: checkoutOrders.amountCents,
                currency: checkoutOrders.currency,
                orderId: checkoutOrders.orderId,
                paymentProvider: checkoutOrders.paymentProvider,
                purpose: checkoutOrders.purpose,
                tipAmountCents: checkoutOrders.squareTipAmountCents,
              })
              .from(checkoutOrders)
              .where(eq(checkoutOrders.id, claimed.checkoutOrderId))
              .limit(1)
              .then((rows) => rows[0]),
        tx
          .select({
            amountCents: bookingPaymentAttempts.amountCents,
            currency: bookingPaymentAttempts.currency,
            paymentProvider: bookingPaymentAttempts.paymentProvider,
          })
          .from(bookingPaymentAttempts)
          .where(
            and(
              eq(bookingPaymentAttempts.holdId, claimed.id),
              eq(bookingPaymentAttempts.status, "captured"),
              inArray(bookingPaymentAttempts.operation, [
                "service_booking_charge",
                "square_charge_and_store",
                "square_hosted_checkout",
              ]),
            ),
          )
          .orderBy(
            desc(bookingPaymentAttempts.capturedAt),
            desc(bookingPaymentAttempts.createdAt),
          )
          .limit(1)
          .then((rows) => rows[0]),
        claimed.providerId === null
          ? Promise.resolve(undefined)
          : tx
              .select({ displayName: bookingProviders.displayName })
              .from(bookingProviders)
              .where(eq(bookingProviders.id, claimed.providerId))
              .limit(1)
              .then((rows) => rows[0]),
        claimed.primaryResourceId === null
          ? Promise.resolve([])
          : tx
              .selectDistinct({ email: adminUsers.email })
              .from(adminUserResources)
              .innerJoin(
                adminUsers,
                eq(adminUsers.id, adminUserResources.adminUserId),
              )
              .where(
                and(
                  eq(
                    adminUserResources.bookingResourceId,
                    claimed.primaryResourceId,
                  ),
                  eq(adminUsers.status, "active"),
                ),
              )
              .orderBy(asc(adminUsers.email)),
      ]);

    return {
      bookingType: claimed.bookingType,
      capturedAmountCents:
        capturedPayment?.amountCents ?? checkoutOrder?.amountCents ?? 0,
      currency: capturedPayment?.currency ?? checkoutOrder?.currency ?? "CAD",
      customer: claimed.customerSnapshot,
      end: claimed.selectedEnd,
      holdId: claimed.id,
      offeringSnapshot: claimed.offeringSnapshot,
      orderId:
        checkoutOrder?.orderId ??
        claimed.checkoutOrderPublicId ??
        claimed.publicReference,
      paymentProvider:
        capturedPayment?.paymentProvider ??
        checkoutOrder?.paymentProvider ??
        claimed.paymentProvider,
      paymentPurpose: checkoutOrder?.purpose ?? null,
      providerName:
        readProviderDisplayName(claimed.providerSnapshot) ??
        provider?.displayName ??
        "Lash Her provider",
      recipientEmails: recipients.map((recipient) => recipient.email),
      start: claimed.selectedStart,
      timezone: claimed.timezone,
      tipAmountCents: checkoutOrder?.tipAmountCents ?? 0,
    };
  });
}

export async function markProviderBookingEmailSent(
  input: ProviderBookingEmailMutationInput,
  db: PrivateDb = getPrivateDb(),
): Promise<void> {
  const now = input.now ?? new Date();
  await db
    .update(appointmentHolds)
    .set({
      providerBookingEmailClaimedUntil: null,
      providerBookingEmailLastError: null,
      providerBookingEmailSentAt: now,
      updatedAt: now,
    })
    .where(eq(appointmentHolds.id, input.holdId));
}

export async function recordProviderBookingEmailFailure(
  input: ProviderBookingEmailMutationInput & { error: string },
  db: PrivateDb = getPrivateDb(),
): Promise<void> {
  const now = input.now ?? new Date();
  await db
    .update(appointmentHolds)
    .set({
      providerBookingEmailClaimedUntil: null,
      providerBookingEmailLastError: input.error,
      updatedAt: now,
    })
    .where(eq(appointmentHolds.id, input.holdId));
}

function getHoldLookupCondition(lookup: ProviderBookingEmailLookup) {
  if ("holdId" in lookup) {
    return eq(appointmentHolds.id, lookup.holdId);
  }

  if ("orderId" in lookup) {
    return eq(appointmentHolds.checkoutOrderPublicId, lookup.orderId);
  }

  return eq(appointmentHolds.publicReference, lookup.publicReference);
}

async function isSuccessfullyBooked(
  tx: Parameters<Parameters<PrivateDb["transaction"]>[0]>[0],
  hold: typeof appointmentHolds.$inferSelect,
): Promise<boolean> {
  if (hold.bookingModelVersion !== 2) {
    return hold.status === "booked" && hold.googleEventId !== null;
  }

  const [appointment] = await tx
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.sourceHoldId, hold.id),
        eq(appointments.status, "confirmed"),
        eq(appointments.calendarSyncStatus, "synced"),
      ),
    )
    .limit(1);

  return appointment !== undefined;
}

function readProviderDisplayName(
  snapshot: AppointmentHoldProviderSnapshot | null,
): string | null {
  const value = snapshot?.displayName;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
