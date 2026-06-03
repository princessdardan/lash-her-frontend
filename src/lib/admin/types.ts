import type {
  AdminAuditAction,
  AdminRole,
  AdminUserStatus,
  PrivacyRequestEventType,
  PrivacyRequestStatus,
  PrivacyRequestType,
} from "@/lib/private-db/schema";

export type {
  AdminAuditAction,
  AdminRole,
  AdminUserStatus,
  PrivacyRequestEventType,
  PrivacyRequestStatus,
  PrivacyRequestType,
};

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
  user: AdminUserRecord;
}

export class AdminAuthError extends Error {
  constructor(public readonly code: "unauthenticated" | "not_allowed" | "disabled" | "forbidden") {
    super(code);
    this.name = "AdminAuthError";
  }
}
