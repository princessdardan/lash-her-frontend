import type { AdminSearchItem } from "@/lib/admin/admin-search";

import { canAdmin, type AdminPermissionAction } from "./permissions";
import type { AdminActor, AdminRole } from "./types";

export const ADMIN_DESTINATION_GROUPS = [
  "Daily work",
  "Manage business",
  "Insights",
  "Settings",
] as const;

export type AdminDestinationGroup = (typeof ADMIN_DESTINATION_GROUPS)[number];

export interface AdminDestination extends AdminSearchItem {
  activePaths?: readonly string[];
  group: AdminDestinationGroup;
}

export type AdminCalendarManagementHref =
  | "/admin/calendar-connections"
  | "/admin/my-calendar";

interface AdminDestinationDefinition extends AdminDestination {
  action: AdminPermissionAction;
  roles?: readonly AdminRole[];
}

const ADMIN_DESTINATION_DEFINITIONS: readonly AdminDestinationDefinition[] = [
  {
    action: "admin:view",
    description: "See today's schedule, follow-up work, and booking health.",
    group: "Daily work",
    href: "/admin",
    keywords: [
      "dashboard",
      "home",
      "overview",
      "needs attention",
      "quick links",
    ],
    label: "Today",
    navigation: true,
  },
  {
    action: "bookings:view",
    description: "Find and manage upcoming and past client appointments.",
    group: "Daily work",
    href: "/admin/appointments",
    keywords: [
      "bookings",
      "clients",
      "scheduled",
      "completed",
      "cancelled",
      "no show",
      "follow-up",
    ],
    label: "Appointments",
    navigation: true,
  },
  {
    action: "calendar-connections:self-manage",
    description:
      "Connect a personal calendar and choose calendars that block busy time.",
    group: "Daily work",
    href: "/admin/my-calendar",
    keywords: [
      "google calendar",
      "personal calendar",
      "busy calendar",
      "calendar connection",
    ],
    label: "My availability",
    navigation: true,
    roles: ["employee"],
  },
  {
    action: "payments:view",
    description:
      "Review product orders, payment status, and fulfilment details.",
    group: "Daily work",
    href: "/admin/orders",
    keywords: [
      "products",
      "shop",
      "checkout",
      "shipping",
      "fulfilment",
      "fulfillment",
    ],
    label: "Orders",
    navigation: true,
  },
  {
    action: "payments:view",
    description:
      "Review training purchases, enrollments, and scheduling follow-up.",
    group: "Daily work",
    href: "/admin/training",
    keywords: ["courses", "classes", "enrollments", "students", "invoices"],
    label: "Training",
    navigation: true,
  },
  {
    action: "payments:view",
    description: "Review checkout payments and completed Square refunds.",
    group: "Daily work",
    href: "/admin/payments",
    keywords: [
      "transactions",
      "revenue",
      "checkout",
      "square",
      "tips",
      "refunds",
    ],
    label: "Payments",
    navigation: true,
  },
  {
    action: "payments:view",
    description:
      "Investigate incomplete bookings and payment reconciliation problems.",
    group: "Daily work",
    href: "/admin/booking-issues",
    keywords: [
      "failed booking",
      "payment alert",
      "reconciliation",
      "holds",
      "exceptions",
    ],
    label: "Booking issues",
    navigation: true,
  },
  {
    action: "marketing:view",
    description:
      "Review contact-form messages and prospective client requests.",
    group: "Daily work",
    href: "/admin/inquiries",
    keywords: ["contact", "messages", "leads", "requests", "forms"],
    label: "Inquiries",
    navigation: true,
  },
  {
    action: "schedules:view",
    description: "Set regular hours, time off, extra hours, and calendar sync.",
    group: "Manage business",
    href: "/admin/schedules",
    keywords: [
      "schedule",
      "working hours",
      "time off",
      "extra hours",
      "calendar",
    ],
    label: "Availability",
    navigation: true,
  },
  {
    action: "offerings:view",
    description: "Manage services, provider pricing, timing, and add-ons.",
    group: "Manage business",
    href: "/admin/offerings",
    keywords: [
      "offerings",
      "duration",
      "deposit",
      "buffers",
      "bookable services",
    ],
    label: "Services & pricing",
    navigation: true,
  },
  {
    action: "service-promotions:view",
    description: "Create and manage promotional codes for service bookings.",
    group: "Manage business",
    href: "/admin/service-promotions",
    keywords: ["discounts", "promo code", "coupon", "campaign"],
    label: "Service promotions",
    navigation: true,
  },
  {
    action: "staff:view",
    description:
      "Manage staff access, bookable resources, and Square sales matching.",
    group: "Manage business",
    href: "/admin/staff",
    keywords: [
      "contractors",
      "accounts",
      "roles",
      "people",
      "rooms",
      "equipment",
      "square",
    ],
    label: "Team",
    navigation: true,
  },
  {
    action: "marketing:view",
    description:
      "Review audience growth, opt-ins, unsubscribes, and delivery sync.",
    group: "Insights",
    href: "/admin/marketing",
    keywords: ["contacts", "audience", "consent", "email", "delivery"],
    label: "Marketing",
    navigation: true,
  },
  {
    action: "analytics:view",
    description:
      "Review appointment, payment, marketing, and team performance.",
    group: "Insights",
    href: "/admin/analytics",
    keywords: ["analytics", "revenue", "metrics", "team sales", "methodology"],
    label: "Reports",
    navigation: true,
  },
  {
    action: "setup:view",
    description: "Find configuration problems that can prevent online booking.",
    group: "Settings",
    href: "/admin/setup",
    keywords: ["readiness", "setup", "online booking", "missing configuration"],
    label: "Booking health",
    navigation: true,
  },
  {
    action: "setup:view",
    description:
      "Set booking windows, timing defaults, and client intake text.",
    group: "Settings",
    href: "/admin/booking-settings",
    keywords: [
      "timezone",
      "notice period",
      "booking horizon",
      "buffers",
      "intake questions",
    ],
    label: "Booking settings",
    navigation: true,
  },
  {
    action: "calendar-connections:view",
    activePaths: ["/admin/calendar-connections"],
    description:
      "Manage Google Calendar connections and Square sales matching.",
    group: "Settings",
    href: "/admin/integrations",
    keywords: [
      "external services",
      "calendar sync",
      "google",
      "square",
      "connections",
    ],
    label: "Integrations",
    navigation: true,
  },
  {
    action: "audit:view",
    description:
      "Review administrative changes and the staff member who made them.",
    group: "Settings",
    href: "/admin/audit",
    keywords: ["audit log", "events", "changes", "actor", "date"],
    label: "Activity history",
    navigation: true,
  },
  {
    action: "bookings:view",
    description: "Open appointments that need staff review or follow-up.",
    group: "Daily work",
    href: "/admin/appointments?view=needs-attention",
    keywords: ["attention", "follow-up", "problems", "exceptions"],
    label: "Appointments needing follow-up",
    navigation: false,
  },
  {
    action: "payments:view",
    description: "Review completed Square refund events.",
    group: "Daily work",
    href: "/admin/payments?view=refunds",
    keywords: ["refund payments", "money returned", "square refunds"],
    label: "Refunds",
    navigation: false,
  },
  {
    action: "calendar-connections:self-manage",
    description:
      "Choose personal calendars whose events block appointment times.",
    group: "Daily work",
    href: "/admin/my-calendar",
    keywords: ["google calendar", "conflicts", "blocked time", "availability"],
    label: "Busy calendars",
    navigation: false,
    roles: ["employee"],
  },
  {
    action: "schedules:view",
    description: "Review or set the standard weekly working schedule.",
    group: "Manage business",
    href: "/admin/schedules?tab=hours",
    keywords: ["weekly schedule", "business hours", "working hours"],
    label: "Regular hours",
    navigation: false,
  },
  {
    action: "schedules:view",
    description:
      "Block unavailable time or open hours outside the regular schedule.",
    group: "Manage business",
    href: "/admin/schedules?tab=exceptions#time-off",
    keywords: [
      "vacation",
      "absence",
      "block time",
      "open extra time",
      "exceptions",
    ],
    label: "Time off and extra hours",
    navigation: false,
  },
  {
    action: "schedules:view",
    description: "Review how connected calendars affect staff availability.",
    group: "Manage business",
    href: "/admin/schedules?tab=calendar",
    keywords: ["busy time", "google calendar", "conflicts"],
    label: "Availability calendar sync",
    navigation: false,
  },
  {
    action: "offerings:view",
    description: "Manage the client-facing service catalog.",
    group: "Manage business",
    href: "/admin/offerings?tab=services",
    keywords: ["service catalog", "service name", "website content"],
    label: "Services",
    navigation: false,
  },
  {
    action: "offerings:view",
    description:
      "Set provider prices, deposits, duration, buffers, and required resources.",
    group: "Manage business",
    href: "/admin/offerings?tab=price-timing",
    keywords: [
      "deposit",
      "duration",
      "slot interval",
      "buffer",
      "provider pricing",
    ],
    label: "Price, timing and availability",
    navigation: false,
  },
  {
    action: "offerings:view",
    description: "Create and manage optional extras for services.",
    group: "Manage business",
    href: "/admin/offerings?tab=add-ons",
    keywords: ["extras", "upgrades", "service options"],
    label: "Service add-ons",
    navigation: false,
  },
  {
    action: "staff:view",
    description:
      "Manage admin accounts, roles, status, and resource assignments.",
    group: "Manage business",
    href: "/admin/staff?tab=people",
    keywords: [
      "staff access",
      "contractors",
      "owner",
      "administrator",
      "permissions",
    ],
    label: "Team access",
    navigation: false,
  },
  {
    action: "staff:view",
    description: "Manage bookable people, rooms, and equipment.",
    group: "Manage business",
    href: "/admin/staff?tab=resources",
    keywords: ["providers", "resource assignments", "chairs", "spaces"],
    label: "Bookable resources",
    navigation: false,
  },
  {
    action: "staff:manage",
    description:
      "Match bookable team members to the person credited for Square sales.",
    group: "Manage business",
    href: "/admin/staff?tab=square",
    keywords: [
      "square team",
      "payment attribution",
      "sales credit",
      "provider match",
    ],
    label: "Square sales matching",
    navigation: false,
  },
  {
    action: "marketing:view",
    description: "Search opted-in and unsubscribed marketing contacts.",
    group: "Insights",
    href: "/admin/marketing?tab=contacts",
    keywords: ["audience", "email", "consent", "suppression"],
    label: "Marketing contacts",
    navigation: false,
  },
  {
    action: "marketing:view",
    description:
      "Review contacts whose marketing delivery sync needs attention.",
    group: "Insights",
    href: "/admin/marketing?tab=delivery",
    keywords: ["email sync", "delivery problems", "advanced"],
    label: "Marketing delivery sync",
    navigation: false,
  },
  {
    action: "analytics:view",
    description: "Review appointment totals and status for a reporting period.",
    group: "Insights",
    href: "/admin/analytics?tab=appointments",
    keywords: ["completed", "cancelled", "no show", "metrics"],
    label: "Appointment report",
    navigation: false,
  },
  {
    action: "analytics:view",
    description: "Review payments attributed to each team member.",
    group: "Insights",
    href: "/admin/analytics?tab=team-sales",
    keywords: ["square attribution", "staff revenue", "sales"],
    label: "Team payment report",
    navigation: false,
  },
  {
    action: "setup:view",
    description:
      "Set the business time zone used for booking and availability.",
    group: "Settings",
    href: "/admin/booking-settings",
    keywords: ["timezone", "toronto time", "local time"],
    label: "Business time zone",
    navigation: false,
  },
  {
    action: "setup:view",
    description:
      "Set how far ahead clients can book and the minimum notice required.",
    group: "Settings",
    href: "/admin/booking-settings",
    keywords: ["booking horizon", "lead time", "days ahead", "hours notice"],
    label: "Booking window and notice",
    navigation: false,
  },
  {
    action: "setup:view",
    description:
      "Set appointment start intervals and default time before and after.",
    group: "Settings",
    href: "/admin/booking-settings",
    keywords: [
      "slot interval",
      "buffer before",
      "buffer after",
      "timing defaults",
    ],
    label: "Appointment timing and buffers",
    navigation: false,
  },
  {
    action: "setup:view",
    description: "Edit the questions clients answer while booking.",
    group: "Settings",
    href: "/admin/booking-settings",
    keywords: ["booking form", "client questions", "intake form"],
    label: "Client intake questions",
    navigation: false,
  },
  {
    action: "setup:view",
    description:
      "Edit the consent wording shown for marketing opt-in during booking.",
    group: "Settings",
    href: "/admin/booking-settings",
    keywords: ["consent text", "subscribe wording", "marketing checkbox"],
    label: "Marketing opt-in wording",
    navigation: false,
  },
  {
    action: "calendar-connections:view",
    description:
      "Connect Google accounts and choose booking and busy calendars.",
    group: "Settings",
    href: "/admin/calendar-connections",
    keywords: [
      "oauth",
      "booking destination",
      "busy calendars",
      "calendar accounts",
    ],
    label: "Google Calendar connections",
    navigation: false,
  },
  {
    action: "calendar-connections:view",
    description: "Review the Square integration used for team sales matching.",
    group: "Settings",
    href: "/admin/integrations",
    keywords: ["square team", "sales attribution", "external service"],
    label: "Square integration",
    navigation: false,
  },
];

export function getVisibleAdminDestinations(
  actor: AdminActor,
): AdminDestination[] {
  const permissionContext = {
    bookingProviderResourceIds: actor.bookingProviderResourceIds,
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  };

  return ADMIN_DESTINATION_DEFINITIONS.filter(
    (destination) =>
      (destination.roles === undefined ||
        destination.roles.includes(actor.user.role)) &&
      canAdmin({ action: destination.action, ...permissionContext }),
  ).map((destination) => ({
    activePaths: destination.activePaths,
    description: destination.description,
    group: destination.group,
    href: destination.href,
    keywords: destination.keywords,
    label: destination.label,
    navigation: destination.navigation,
  }));
}

export function getAdminCalendarManagementHref(
  actor: AdminActor,
): AdminCalendarManagementHref | null {
  const permissionContext = {
    bookingProviderResourceIds: actor.bookingProviderResourceIds,
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  };

  if (actor.user.role === "employee") {
    return canAdmin({
      action: "calendar-connections:self-manage",
      ...permissionContext,
    })
      ? "/admin/my-calendar"
      : null;
  }

  return canAdmin({ action: "calendar-connections:view", ...permissionContext })
    ? "/admin/calendar-connections"
    : null;
}
