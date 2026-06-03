import type {
  CalendarFinalizationStatus,
  CheckoutOrderPurpose,
  CheckoutOrderStatus,
} from "@/lib/private-db/schema";

export type PurchaseDomain = "product" | "service" | "training";
export type InboxDomain = "booking" | "marketing" | "order" | "privacy" | "training";
export type InboxSeverity = "high" | "medium" | "low";

export interface OperationsInboxSource {
  createdAt: Date;
  domain: InboxDomain;
  href: string;
  id: string;
  reason: string;
  severity: InboxSeverity;
  title: string;
}

export interface OperationsInboxItem extends OperationsInboxSource {
  nextAction: string;
}

export function moneyFromCents(amountCents: number, currency: string): string {
  const amount = new Intl.NumberFormat("en-CA", {
    currency,
    style: "currency",
  }).format(amountCents / 100);

  return `${amount} ${currency}`;
}

export function getPurchaseDomainFromPurpose(purpose: CheckoutOrderPurpose): PurchaseDomain {
  if (purpose === "product") {
    return "product";
  }

  if (purpose === "training") {
    return "training";
  }

  return "service";
}

export function describeCheckoutStatus(status: CheckoutOrderStatus): string {
  const labels: Record<CheckoutOrderStatus, string> = {
    cancelled: "Cancelled",
    paid: "Paid",
    pending: "Payment pending",
    refunded: "Refunded",
    verification_failed: "Payment needs review",
  };

  return labels[status];
}

export function describeCalendarFinalizationStatus(status: CalendarFinalizationStatus): string {
  const labels: Record<CalendarFinalizationStatus, string> = {
    booked: "Booked",
    failed: "Calendar failed",
    manual_rebooked: "Manually rebooked",
    manual_review: "Manual review",
    not_required: "Not required",
    paid_calendar_pending: "Paid, calendar pending",
    paid_unbookable_rebooking_pending: "Paid, rebooking needed",
    pending: "Calendar pending",
    refund_required: "Refund required",
    refunded: "Refunded",
  };

  return labels[status];
}

export function toOperationsInboxItem(source: OperationsInboxSource): OperationsInboxItem {
  return {
    ...source,
    nextAction: getNextAction(source.domain),
  };
}

function getNextAction(domain: InboxDomain): string {
  if (domain === "privacy") {
    return "Open the privacy request, confirm the requester details, and record the next case event.";
  }

  if (domain === "marketing") {
    return "Open the contact or submission and review the source before taking marketing action.";
  }

  return "Open the record and review the troubleshooting panel before contacting the customer.";
}
