import type { AdminRole } from "@/lib/private-db/schema";

export type { AdminRole };

export type AdminUserStatus = "active" | "disabled";

export interface AdminUserRecord {
  displayName: string | null;
  email: string;
  emailNormalized: string;
  id: string;
  providerUserId: string;
  role: AdminRole;
  status: AdminUserStatus;
}

export interface AdminActor {
  bookingProviderResourceIds: string[];
  bookingResourceIds: string[];
  developerMode?: {
    accountRole: AdminRole;
    permissionRole: AdminRole;
  };
  user: AdminUserRecord;
}

export interface AdminIdentity {
  displayName: string | null;
  email: string;
  emailVerified: boolean;
  providerUserId: string;
}

export type AdminAuthErrorCode =
  | "disabled"
  | "forbidden"
  | "identity_conflict"
  | "not_allowed"
  | "unauthenticated"
  | "unverified_email";

export class AdminAuthError extends Error {
  constructor(public readonly code: AdminAuthErrorCode) {
    super(code);
    this.name = "AdminAuthError";
  }
}
