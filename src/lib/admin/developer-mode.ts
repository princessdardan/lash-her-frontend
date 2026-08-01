import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

import {
  findAdminUserById,
  getAdminUserStore,
  listAdminUsersForDeveloperMode,
} from "./admin-user-store";
import {
  ADMIN_DEVELOPER_ACCESS_COOKIE,
  ADMIN_DEVELOPER_MODE_COOKIE,
  createAdminDeveloperActor,
  isAdminDeveloperModeEnabled,
  parseAdminDeveloperSession,
  serializeAdminDeveloperSession,
  type AdminDeveloperSession,
  type AdminDeveloperUserOption,
} from "./developer-mode-config";
import {
  createAdminDeveloperToken,
  verifyAdminDeveloperToken,
} from "./developer-mode-token";
import type { AdminActor } from "./types";

const DEVELOPER_ACCESS_MAX_AGE_SECONDS = 15 * 60;
const DEVELOPER_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const DEVELOPER_ACCESS_TOKEN_PURPOSE = "admin-developer-access";
const DEVELOPER_SESSION_TOKEN_PURPOSE = "admin-developer-session";
const DEVELOPER_ACCESS_TOKEN_VALUE = "authorized";

export async function getAdminDeveloperActor(): Promise<AdminActor | null> {
  if (!isAdminDeveloperModeEnabled()) return null;

  const cookieStore = await cookies();
  const session = readSignedDeveloperSession(
    cookieStore.get(ADMIN_DEVELOPER_MODE_COOKIE)?.value,
  );
  if (!session) return null;

  const user = await findAdminUserById(session.actingAdminUserId);
  if (!user) return null;

  const store = getAdminUserStore();
  const [bookingProviderResourceIds, bookingResourceIds] = await Promise.all([
    store.listBookingProviderResourceIds(user.id),
    store.listBookingResourceIds(user.id),
  ]);

  return createAdminDeveloperActor({
    bookingProviderResourceIds,
    bookingResourceIds,
    session,
    user,
  });
}

export async function listAdminDeveloperUserOptions(): Promise<
  AdminDeveloperUserOption[]
> {
  if (!(await hasAdminDeveloperAccess())) return [];
  return listAdminUsersForDeveloperMode();
}

export async function authorizeAdminDeveloperAccess(
  candidateAccessKey: string,
): Promise<boolean> {
  if (!isAdminDeveloperModeEnabled()) return false;
  const configuredAccessKey = getAdminDeveloperAccessKey();
  if (!constantTimeMatches(candidateAccessKey, configuredAccessKey)) {
    return false;
  }

  const cookieStore = await cookies();
  cookieStore.set(
    ADMIN_DEVELOPER_ACCESS_COOKIE,
    createAdminDeveloperToken({
      expiresAt: Date.now() + DEVELOPER_ACCESS_MAX_AGE_SECONDS * 1_000,
      purpose: DEVELOPER_ACCESS_TOKEN_PURPOSE,
      secret: configuredAccessKey,
      value: DEVELOPER_ACCESS_TOKEN_VALUE,
    }),
    cookieOptions(DEVELOPER_ACCESS_MAX_AGE_SECONDS),
  );
  return true;
}

export async function setAdminDeveloperSession(
  session: AdminDeveloperSession,
): Promise<void> {
  assertAdminDeveloperModeEnabled();
  if (!(await hasAdminDeveloperAccess())) {
    throw new Error("Admin developer access has not been authorized");
  }

  const user = await findAdminUserById(session.actingAdminUserId);
  if (!user) {
    throw new Error("Selected admin user does not exist");
  }

  const cookieStore = await cookies();
  cookieStore.set(
    ADMIN_DEVELOPER_MODE_COOKIE,
    createAdminDeveloperToken({
      expiresAt: Date.now() + DEVELOPER_SESSION_MAX_AGE_SECONDS * 1_000,
      purpose: DEVELOPER_SESSION_TOKEN_PURPOSE,
      secret: getAdminDeveloperAccessKey(),
      value: serializeAdminDeveloperSession(session),
    }),
    cookieOptions(DEVELOPER_SESSION_MAX_AGE_SECONDS),
  );

  const { recordAdminAuditBestEffort } = await import("./audit-log");
  await recordAdminAuditBestEffort({
    action: "developer_session_started",
    actor: createAdminDeveloperActor({
      bookingProviderResourceIds: [],
      bookingResourceIds: [],
      session,
      user,
    }),
    domain: "authorization",
    outcome: "success",
    targetId: user.id,
    targetType: "admin_user",
  });
}

export async function clearAdminDeveloperSession(): Promise<boolean> {
  const cookieStore = await cookies();
  const hadDeveloperCookie =
    cookieStore.has(ADMIN_DEVELOPER_ACCESS_COOKIE) ||
    cookieStore.has(ADMIN_DEVELOPER_MODE_COOKIE);
  cookieStore.set(ADMIN_DEVELOPER_ACCESS_COOKIE, "", cookieOptions(0));
  cookieStore.set(ADMIN_DEVELOPER_MODE_COOKIE, "", cookieOptions(0));
  return hadDeveloperCookie;
}

export async function hasAdminDeveloperSession(): Promise<boolean> {
  if (!isAdminDeveloperModeEnabled()) return false;
  const cookieStore = await cookies();
  return (
    readSignedDeveloperSession(
      cookieStore.get(ADMIN_DEVELOPER_MODE_COOKIE)?.value,
    ) !== null
  );
}

export async function hasAdminDeveloperAccess(): Promise<boolean> {
  if (!isAdminDeveloperModeEnabled()) return false;
  if (await hasAdminDeveloperSession()) return true;

  const cookieStore = await cookies();
  return (
    verifyAdminDeveloperToken({
      now: Date.now(),
      purpose: DEVELOPER_ACCESS_TOKEN_PURPOSE,
      secret: getAdminDeveloperAccessKey(),
      token: cookieStore.get(ADMIN_DEVELOPER_ACCESS_COOKIE)?.value,
    }) === DEVELOPER_ACCESS_TOKEN_VALUE
  );
}

export function assertAdminDeveloperModeEnabled(): void {
  if (!isAdminDeveloperModeEnabled()) {
    throw new Error("Admin developer mode is not available");
  }
}

function readSignedDeveloperSession(
  token: string | undefined,
): AdminDeveloperSession | null {
  const serializedSession = verifyAdminDeveloperToken({
    now: Date.now(),
    purpose: DEVELOPER_SESSION_TOKEN_PURPOSE,
    secret: getAdminDeveloperAccessKey(),
    token,
  });
  return parseAdminDeveloperSession(serializedSession ?? undefined);
}

function getAdminDeveloperAccessKey(): string {
  const accessKey = process.env.ADMIN_DEVELOPER_ACCESS_KEY;
  if (!accessKey) {
    throw new Error("Admin developer access key is not configured");
  }
  return accessKey;
}

function constantTimeMatches(candidate: string, expected: string): boolean {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    maxAge,
    path: "/",
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV !== "development",
  };
}
