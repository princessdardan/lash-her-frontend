import type { AdminRole } from "./types";

export type AdminPermissionAction =
  | "admin:view"
  | "orders:view"
  | "bookings:view"
  | "training:view"
  | "marketing:view"
  | "revenue:view"
  | "privacy:view"
  | "privacy:create"
  | "privacy:event:create"
  | "privacy:decision"
  | "privacy:export"
  | "audit:view"
  | "troubleshooting:view";

const OWNER_ONLY_ACTIONS = new Set<AdminPermissionAction>([
  "privacy:decision",
  "privacy:export",
  "audit:view",
]);

export function canAdmin(input: { action: AdminPermissionAction; role: AdminRole }): boolean {
  if (input.role === "owner") {
    return true;
  }

  if (OWNER_ONLY_ACTIONS.has(input.action)) {
    return false;
  }

  return input.role === "operator";
}
