import type { AdminRole } from "./types";

export type AdminPermissionAction =
  | "admin:view"
  | "analytics:view"
  | "audit:view"
  | "bookings:manage"
  | "bookings:view"
  | "fulfillment:manage"
  | "fulfillment:view"
  | "inventory:manage"
  | "inventory:view"
  | "calendar-connections:manage"
  | "calendar-connections:self-manage"
  | "calendar-connections:view"
  | "marketing:export"
  | "marketing:manage"
  | "marketing:send"
  | "marketing:view"
  | "offerings:manage"
  | "offerings:view"
  | "payments:refund"
  | "payments:view"
  | "schedules:manage"
  | "schedules:view"
  | "service-promotions:manage"
  | "service-promotions:view"
  | "settings:manage"
  | "setup:view"
  | "staff:manage"
  | "staff:view";

interface PermissionCheckInput {
  action: AdminPermissionAction;
  bookingResourceId?: string;
  bookingProviderResourceIds: readonly string[];
  bookingResourceIds: readonly string[];
  role: AdminRole;
}

const ADMIN_ACTIONS = new Set<AdminPermissionAction>([
  "admin:view",
  "analytics:view",
  "bookings:manage",
  "bookings:view",
  "fulfillment:manage",
  "fulfillment:view",
  "inventory:manage",
  "inventory:view",
  "calendar-connections:manage",
  "calendar-connections:view",
  "marketing:manage",
  "marketing:send",
  "marketing:view",
  "offerings:manage",
  "offerings:view",
  "payments:view",
  "schedules:manage",
  "schedules:view",
  "service-promotions:manage",
  "service-promotions:view",
  "settings:manage",
  "setup:view",
  "staff:view",
]);

const EMPLOYEE_ACTIONS = new Set<AdminPermissionAction>([
  "admin:view",
  "bookings:manage",
  "bookings:view",
  "calendar-connections:self-manage",
  "offerings:manage",
  "offerings:view",
  "schedules:manage",
  "schedules:view",
]);

const EMPLOYEE_RESOURCE_ACTIONS = new Set<AdminPermissionAction>([
  "bookings:manage",
  "bookings:view",
  "calendar-connections:self-manage",
  "offerings:manage",
  "offerings:view",
  "schedules:manage",
  "schedules:view",
]);

export function canAdmin(input: PermissionCheckInput): boolean {
  if (input.role === "owner") {
    return true;
  }

  if (input.role === "admin") {
    return ADMIN_ACTIONS.has(input.action);
  }

  if (!EMPLOYEE_ACTIONS.has(input.action)) {
    return false;
  }

  if (!EMPLOYEE_RESOURCE_ACTIONS.has(input.action)) {
    return true;
  }

  if (
    input.action === "calendar-connections:self-manage" ||
    input.action === "offerings:manage" ||
    input.action === "offerings:view"
  ) {
    if (input.bookingResourceId) {
      return input.bookingProviderResourceIds.includes(input.bookingResourceId);
    }

    return input.bookingProviderResourceIds.length > 0;
  }

  if (input.bookingResourceId) {
    return input.bookingResourceIds.includes(input.bookingResourceId);
  }

  return input.bookingResourceIds.length > 0;
}

export function getVisibleAdminSections(input: {
  bookingProviderResourceIds: readonly string[];
  bookingResourceIds: readonly string[];
  role: AdminRole;
}): AdminPermissionAction[] {
  const candidates: AdminPermissionAction[] = [
    "admin:view",
    "bookings:view",
    "fulfillment:view",
    "inventory:view",
    "schedules:view",
    "offerings:view",
    "service-promotions:view",
    "setup:view",
    "calendar-connections:view",
    "marketing:view",
    "analytics:view",
    "staff:view",
    "audit:view",
  ];

  return candidates.filter((action) =>
    canAdmin({
      action,
      bookingProviderResourceIds: input.bookingProviderResourceIds,
      bookingResourceIds: input.bookingResourceIds,
      role: input.role,
    }),
  );
}
