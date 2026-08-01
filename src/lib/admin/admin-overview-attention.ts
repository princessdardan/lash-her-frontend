import type { AdminOverviewAttentionAccess } from "./admin-overview-model";

export type AdminOverviewAttentionKind =
  | "attendance"
  | "booking_exception"
  | "booking_email"
  | "calendar_connection"
  | "calendar_sync"
  | "customer_email"
  | "marketing_delivery"
  | "service_availability"
  | "training_scheduling";

export interface AdminOverviewAttentionItem {
  count: number;
  description: string;
  href: string;
  kind: AdminOverviewAttentionKind;
  title: string;
}

export interface AdminOverviewAttentionCounts {
  appointmentAttendance: number | null | undefined;
  appointmentCalendarSync: number | null | undefined;
  appointmentEmailFailures: number | null | undefined;
  bookingIssues: number | null | undefined;
  calendarConnections: number | null | undefined;
  holdEmailFailures: number | null | undefined;
  marketingFailures: number | null | undefined;
  serviceAvailabilityIssues: number | null | undefined;
  trainingSchedulingIssues: number | null | undefined;
}

export function buildAdminOverviewAttentionItems(
  access: AdminOverviewAttentionAccess,
  counts: AdminOverviewAttentionCounts,
): AdminOverviewAttentionItem[] {
  const items: AdminOverviewAttentionItem[] = [];

  addAttentionItem(items, counts.appointmentAttendance, {
    description:
      "Confirmed appointments have ended without attendance recorded.",
    href: "/admin/appointments?view=needs-attention",
    kind: "attendance",
    title: "Appointments need attendance",
  });
  addAttentionItem(items, counts.appointmentCalendarSync, {
    description: "Calendar updates need a staff review.",
    href: "/admin/appointments?view=needs-attention",
    kind: "calendar_sync",
    title: "Calendar sync needs follow-up",
  });
  addAttentionItem(items, counts.appointmentEmailFailures, {
    description: "Appointment confirmation emails could not be delivered.",
    href: "/admin/appointments?view=needs-attention",
    kind: "customer_email",
    title: "Appointment emails need review",
  });
  if (access.bookingIssuesHref) {
    addAttentionItem(items, counts.holdEmailFailures, {
      description:
        "A booking confirmation failed before an appointment was created.",
      href: access.bookingIssuesHref,
      kind: "booking_email",
      title: "Booking emails need review",
    });
    addAttentionItem(items, counts.bookingIssues, {
      description:
        "Booking and payment records require finalization, rebooking, or refund review.",
      href: access.bookingIssuesHref,
      kind: "booking_exception",
      title: "Booking issues need review",
    });
  }
  addAttentionItem(items, counts.calendarConnections, {
    description: "Connected Google accounts need to be authorized again.",
    href: access.calendarHref,
    kind: "calendar_connection",
    title: "Calendar accounts need reconnection",
  });
  addAttentionItem(items, counts.serviceAvailabilityIssues, {
    description:
      "Active services have configuration that blocks online booking.",
    href: "/admin/offerings",
    kind: "service_availability",
    title: "Services are unavailable online",
  });
  addAttentionItem(items, counts.marketingFailures, {
    description: "The latest delivery sync attempt needs review.",
    href: "/admin/marketing?status=delivery_issue",
    kind: "marketing_delivery",
    title: "Marketing delivery needs review",
  });
  addAttentionItem(items, counts.trainingSchedulingIssues, {
    description: "Paid training enrollments are waiting for scheduling.",
    href: "/admin/training",
    kind: "training_scheduling",
    title: "Training scheduling needs attention",
  });

  return items;
}

function addAttentionItem(
  items: AdminOverviewAttentionItem[],
  count: number | null | undefined,
  item: Omit<AdminOverviewAttentionItem, "count">,
): void {
  if (!count || count < 1) return;
  items.push({ ...item, count });
}
