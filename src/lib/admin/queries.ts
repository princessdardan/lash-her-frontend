import "server-only";

import { desc, eq, inArray, ne, or } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  appointmentHolds,
  checkoutOrders,
  marketingConsentEvents,
  marketingContacts,
  marketingContactSubmissions,
  privacyRequests,
  type AppointmentHoldCustomerSnapshot,
  type AppointmentHoldStatus,
  type CalendarFinalizationStatus,
  type CheckoutOrderPurpose,
  type CheckoutOrderStatus,
} from "@/lib/private-db/schema";

import {
  describeCalendarFinalizationStatus,
  describeCheckoutStatus,
  getPurchaseDomainFromPurpose,
  moneyFromCents,
  toOperationsInboxItem,
  type OperationsInboxItem,
  type PurchaseDomain,
} from "./read-models";

interface RecentOrderRow {
  amountCents: number;
  bookingHoldId?: string | null;
  createdAt: Date;
  currency: string;
  customerEmail: string;
  customerName: string;
  id: string;
  orderId: string;
  purpose: CheckoutOrderPurpose;
  status: CheckoutOrderStatus;
}

interface AttentionBookingRow {
  createdAt: Date;
  customerSnapshot: AppointmentHoldCustomerSnapshot;
  finalizationStatus: CalendarFinalizationStatus;
  id: string;
  publicReference: string;
  selectedStart: Date;
  status: AppointmentHoldStatus | string;
}

interface MarketingSummaryRow {
  contacts: number;
  source: string;
  submissions: number;
  unsubscribes: number;
}

interface PrivacyRequestSummaryRow {
  id: string;
  requestType: string;
  status: string;
  subjectEmailNormalized: string;
}

export interface AdminQueryRepository {
  listAttentionBookings(): Promise<AttentionBookingRow[]>;
  listMarketingSummaryRows(): Promise<MarketingSummaryRow[]>;
  listPrivacyRequests(): Promise<PrivacyRequestSummaryRow[]>;
  listRecentOrders(): Promise<RecentOrderRow[]>;
}

export interface CommandCenterData {
  cards: {
    marketingSources: number;
    openPrivacyRequests: number;
    recentOrders: number;
    recentRevenueCents: number;
  };
  inboxItems: OperationsInboxItem[];
}

export interface RevenueRow {
  amount: string;
  amountCents: number;
  createdAt: Date;
  customerName: string;
  domain: PurchaseDomain;
  href: string;
  orderId: string;
  status: string;
}

export function createAdminQueryService(repository: AdminQueryRepository) {
  return {
    async getCommandCenterData(): Promise<CommandCenterData> {
      const [orders, bookings, marketing, privacy] = await Promise.all([
        repository.listRecentOrders(),
        repository.listAttentionBookings(),
        repository.listMarketingSummaryRows(),
        repository.listPrivacyRequests(),
      ]);

      return {
        cards: {
          marketingSources: marketing.length,
          openPrivacyRequests: privacy.filter((request) => isOpenPrivacyRequestStatus(request.status)).length,
          recentOrders: orders.length,
          recentRevenueCents: orders
            .filter((order) => order.status === "paid")
            .reduce((total, order) => total + order.amountCents, 0),
        },
        inboxItems: bookings.map((booking) => toOperationsInboxItem({
          createdAt: booking.createdAt,
          domain: "booking",
          href: `/admin/bookings/${booking.id}`,
          id: booking.id,
          reason: describeCalendarFinalizationStatus(booking.finalizationStatus),
          severity: "high",
          title: "Booking needs manual follow-up",
        })),
      };
    },
    async listRevenueRows(): Promise<RevenueRow[]> {
      const orders = await repository.listRecentOrders();

      return orders.map((order) => {
        const domain = getPurchaseDomainFromPurpose(order.purpose);

        return {
          amount: moneyFromCents(order.amountCents, order.currency),
          amountCents: order.amountCents,
          createdAt: order.createdAt,
          customerName: order.customerName,
          domain,
          href: getRevenueRowHref(domain, order.id, order.bookingHoldId),
          orderId: order.orderId,
          status: describeCheckoutStatus(order.status),
        };
      });
    },
  };
}

export function createDrizzleAdminQueryRepository(): AdminQueryRepository {
  const db = getPrivateDb();

  return {
    async listAttentionBookings() {
      return db
        .select({
          createdAt: appointmentHolds.createdAt,
          customerSnapshot: appointmentHolds.customerSnapshot,
          finalizationStatus: appointmentHolds.finalizationStatus,
          id: appointmentHolds.id,
          publicReference: appointmentHolds.publicReference,
          selectedStart: appointmentHolds.selectedStart,
          status: appointmentHolds.status,
        })
        .from(appointmentHolds)
        .where(or(
          inArray(appointmentHolds.status, [
            "booking_failed",
            "manual_followup",
            "paid_unbookable_rebooking_pending",
            "refund_required",
          ]),
          inArray(appointmentHolds.finalizationStatus, [
            "failed",
            "manual_review",
            "paid_calendar_pending",
            "paid_unbookable_rebooking_pending",
            "refund_required",
          ]),
        ))
        .orderBy(desc(appointmentHolds.updatedAt))
        .limit(25);
    },
    async listMarketingSummaryRows() {
      const submissions = await db
        .select()
        .from(marketingContactSubmissions)
        .orderBy(desc(marketingContactSubmissions.submittedAt))
        .limit(100);
      const contacts = await db
        .select()
        .from(marketingContacts)
        .orderBy(desc(marketingContacts.updatedAt))
        .limit(100);
      const events = await db
        .select()
        .from(marketingConsentEvents)
        .orderBy(desc(marketingConsentEvents.occurredAt))
        .limit(100);
      const sources = new Map<string, MarketingSummaryRow>();

      for (const submission of submissions) {
        const row = sources.get(submission.source) ?? createMarketingSummaryRow(submission.source);
        row.submissions += 1;
        sources.set(submission.source, row);
      }

      for (const contact of contacts) {
        const row = sources.get(contact.source) ?? createMarketingSummaryRow(contact.source);
        row.contacts += 1;
        sources.set(contact.source, row);
      }

      for (const event of events) {
        if (event.eventType === "unsubscribe") {
          const row = sources.get(event.source) ?? createMarketingSummaryRow(event.source);
          row.unsubscribes += 1;
          sources.set(event.source, row);
        }
      }

      return [...sources.values()];
    },
    async listPrivacyRequests() {
      return db
        .select({
          id: privacyRequests.id,
          requestType: privacyRequests.requestType,
          status: privacyRequests.status,
          subjectEmailNormalized: privacyRequests.subjectEmailNormalized,
        })
        .from(privacyRequests)
        .orderBy(desc(privacyRequests.createdAt))
        .limit(50);
    },
    async listRecentOrders() {
      return db
        .select({
          amountCents: checkoutOrders.amountCents,
          bookingHoldId: appointmentHolds.id,
          createdAt: checkoutOrders.createdAt,
          currency: checkoutOrders.currency,
          customerEmail: checkoutOrders.customerEmail,
          customerName: checkoutOrders.customerName,
          id: checkoutOrders.id,
          orderId: checkoutOrders.orderId,
          purpose: checkoutOrders.purpose,
          status: checkoutOrders.status,
        })
        .from(checkoutOrders)
        .leftJoin(appointmentHolds, eq(appointmentHolds.checkoutOrderId, checkoutOrders.id))
        .where(ne(checkoutOrders.status, "pending"))
        .orderBy(desc(checkoutOrders.createdAt))
        .limit(100);
    },
  };
}

export function getAdminQueryService() {
  return createAdminQueryService(createDrizzleAdminQueryRepository());
}

function getRevenueRowHref(domain: PurchaseDomain, id: string, bookingHoldId?: string | null): string {
  if (domain === "product") {
    return `/admin/orders/${id}`;
  }

  if (domain === "training") {
    return `/admin/training/${id}`;
  }

  return `/admin/bookings/${bookingHoldId ?? id}`;
}

function isOpenPrivacyRequestStatus(status: string): boolean {
  return status !== "completed" && status !== "cancelled";
}

function createMarketingSummaryRow(source: string): MarketingSummaryRow {
  return { contacts: 0, source, submissions: 0, unsubscribes: 0 };
}
