import type { AdminActor, AdminRole, AdminUserRecord } from "./types";

export const ADMIN_DEVELOPER_ACCESS_COOKIE = "lash_admin_developer_access";
export const ADMIN_DEVELOPER_MODE_COOKIE = "lash_admin_developer_mode";
export const ADMIN_DEVELOPER_ACCESS_KEY_MIN_LENGTH = 32;

interface AdminDeveloperModeEnv {
  ADMIN_DEVELOPER_ACCESS_KEY?: string;
  ADMIN_DEVELOPER_MODE?: string;
  NODE_ENV?: string;
  VERCEL_ENV?: string;
}

export interface AdminDeveloperSession {
  actingAdminUserId: string;
  permissionRole: AdminRole;
}

export interface AdminDeveloperUserOption {
  displayName: string | null;
  email: string;
  id: string;
  role: AdminRole;
  status: AdminUserRecord["status"];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADMIN_ROLES = new Set<AdminRole>(["owner", "admin", "employee"]);

export function isAdminDeveloperModeEnabled(
  env?: AdminDeveloperModeEnv,
): boolean {
  const resolvedEnv = env ?? {
    ADMIN_DEVELOPER_ACCESS_KEY: process.env.ADMIN_DEVELOPER_ACCESS_KEY,
    ADMIN_DEVELOPER_MODE: process.env.ADMIN_DEVELOPER_MODE,
  };

  return (
    resolvedEnv.ADMIN_DEVELOPER_MODE === "true" &&
    typeof resolvedEnv.ADMIN_DEVELOPER_ACCESS_KEY === "string" &&
    resolvedEnv.ADMIN_DEVELOPER_ACCESS_KEY.length >=
      ADMIN_DEVELOPER_ACCESS_KEY_MIN_LENGTH
  );
}

export function parseAdminDeveloperSession(
  value: string | undefined,
): AdminDeveloperSession | null {
  if (!value) return null;

  const [actingAdminUserId, permissionRole, unexpected] = value.split(".");
  if (
    unexpected !== undefined ||
    !UUID_PATTERN.test(actingAdminUserId ?? "") ||
    !ADMIN_ROLES.has(permissionRole as AdminRole)
  ) {
    return null;
  }

  return {
    actingAdminUserId,
    permissionRole: permissionRole as AdminRole,
  };
}

export function serializeAdminDeveloperSession(
  session: AdminDeveloperSession,
): string {
  const parsed = parseAdminDeveloperSession(
    `${session.actingAdminUserId}.${session.permissionRole}`,
  );
  if (!parsed) {
    throw new Error("Invalid admin developer session");
  }

  return `${parsed.actingAdminUserId}.${parsed.permissionRole}`;
}

export function createAdminDeveloperActor(input: {
  bookingProviderResourceIds: string[];
  bookingResourceIds: string[];
  session: AdminDeveloperSession;
  user: AdminUserRecord;
}): AdminActor {
  return {
    bookingProviderResourceIds: input.bookingProviderResourceIds,
    bookingResourceIds: input.bookingResourceIds,
    developerMode: {
      accountRole: input.user.role,
      permissionRole: input.session.permissionRole,
    },
    user: {
      ...input.user,
      role: input.session.permissionRole,
    },
  };
}
