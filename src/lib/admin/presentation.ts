import type { AdminRole } from "./types";

const ADMIN_ROLE_LABELS: Record<AdminRole, string> = {
  admin: "Administrator",
  employee: "Contractor",
  owner: "Owner",
};

export function getAdminRoleLabel(role: AdminRole): string {
  return ADMIN_ROLE_LABELS[role];
}

export function toContractorTerminology(value: string): string {
  return value.replace(/employees?/gi, (legacyTerm) => {
    const replacement =
      legacyTerm.toLowerCase() === "employees" ? "contractors" : "contractor";

    if (legacyTerm === legacyTerm.toUpperCase()) {
      return replacement.toUpperCase();
    }

    if (legacyTerm[0] === legacyTerm[0]?.toUpperCase()) {
      return `${replacement[0]?.toUpperCase()}${replacement.slice(1)}`;
    }

    return replacement;
  });
}
