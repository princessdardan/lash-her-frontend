import "server-only";

import { cookies, headers } from "next/headers";
import { after } from "next/server";

import { getAdminOwnerEmails } from "@/lib/env/admin";

import { getAdminUserStore } from "./admin-user-store";
import {
  createAdminAuth,
  type AdminAuthService,
  type AdminPermissionContext,
} from "./auth-service";
import {
  ADMIN_PERMISSION_DENIAL_AUDIT_EVENT,
  requirePermissionWithAudit,
} from "./authorization-policy";
import { getAdminDeveloperActor } from "./developer-mode";
import type { AdminPermissionAction } from "./permissions";
import type { AdminActor, AdminIdentity } from "./types";
import {
  ADMIN_STEP_UP_PROOF_COOKIE,
  consumeAdminStepUpProof,
} from "./step-up-proof";

export {
  assertAdminPermission,
  createAdminAuth,
  type AdminAuthService,
  type AdminPermissionContext,
} from "./auth-service";

const ADMIN_REQUEST_ID_HEADER = "x-lash-admin-request-id";
const requestActors = new Map<string, Promise<AdminActor>>();

export function getAdminAuth(): AdminAuthService {
  return createAdminAuth({
    getIdentity: getAuthJsIdentity,
    getOwnerEmails: getAdminOwnerEmails,
    userStore: getAdminUserStore(),
  });
}

export async function requireAdminActor(): Promise<AdminActor> {
  return getRequestActor();
}

export async function requirePermission(
  action: AdminPermissionAction,
  context: AdminPermissionContext = {},
): Promise<AdminActor> {
  return requirePermissionWithAudit({
    action,
    context,
    getActor: getRequestActor,
    recordDenial: async ({ actor: deniedActor, requestedPermission }) => {
      // The writer does not authorize. The dynamic import avoids the
      // audit-log -> auth read-path dependency becoming a module cycle.
      const { recordAdminAuditBestEffort } = await import("./audit-log");
      await recordAdminAuditBestEffort({
        ...ADMIN_PERMISSION_DENIAL_AUDIT_EVENT,
        actor: deniedActor,
        metadata: { requestedPermission },
      });
    },
  });
}

export async function requireFreshAdminGoogleAuthentication(
  maxAgeMs = 5 * 60_000,
): Promise<Date> {
  const { auth } = await import("@/auth");
  const session = await auth();
  const authenticatedAt = session?.user?.authenticatedAt;
  if (typeof authenticatedAt !== "number" || authenticatedAt <= 0) {
    throw new Error("Step-up authentication is required");
  }
  const authenticatedAtDate = new Date(authenticatedAt * 1_000);
  if (Date.now() - authenticatedAtDate.getTime() > maxAgeMs) {
    throw new Error("Step-up authentication has expired");
  }
  return authenticatedAtDate;
}

export async function requireRecentAdminAuthentication(input: {
  action: string;
  maxAgeMs?: number;
  target: string;
}): Promise<Date> {
  const authenticatedAt = await requireFreshAdminGoogleAuthentication(
    input.maxAgeMs,
  );
  const actor = await requireAdminActor();
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_STEP_UP_PROOF_COOKIE)?.value;
  if (!token) throw new Error("Step-up proof is required for this action");
  try {
    return await consumeAdminStepUpProof({
      action: input.action,
      actorAdminUserId: actor.user.id,
      authenticatedAt,
      target: input.target,
      token,
    });
  } finally {
    cookieStore.delete(ADMIN_STEP_UP_PROOF_COOKIE);
  }
}

async function getRequestActor(): Promise<AdminActor> {
  const requestId = (await headers()).get(ADMIN_REQUEST_ID_HEADER);

  if (!requestId) {
    return resolveRequestActor();
  }

  const cached = requestActors.get(requestId);

  if (cached) {
    return cached;
  }

  const actorPromise = resolveRequestActor();
  requestActors.set(requestId, actorPromise);
  after(() => {
    requestActors.delete(requestId);
  });

  return actorPromise;
}

async function resolveRequestActor(): Promise<AdminActor> {
  return (await getAdminDeveloperActor()) ?? getAdminAuth().requireActor();
}

async function getAuthJsIdentity(): Promise<AdminIdentity | null> {
  const { auth } = await import("@/auth");
  const session = await auth();
  const sessionUser = session?.user;

  if (
    !sessionUser ||
    typeof sessionUser.email !== "string" ||
    typeof sessionUser.providerUserId !== "string"
  ) {
    return null;
  }

  return {
    displayName:
      typeof sessionUser.name === "string" && sessionUser.name.trim()
        ? sessionUser.name.trim()
        : null,
    email: sessionUser.email,
    emailVerified: sessionUser.isEmailVerified === true,
    providerUserId: sessionUser.providerUserId,
  };
}
