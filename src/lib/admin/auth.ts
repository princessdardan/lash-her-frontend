import { runAdminIdentityWriter } from "./user-writer-admission";
import "server-only";

import { cookies } from "next/headers";

import { getAdminOwnerEmails } from "@/lib/env/admin";

import { getAdminUserStore } from "./admin-user-store";
import { getAdminAuthorizationActor, runAdminAuthorizationOperation } from "./authorization-operation";
import { assertFreshAdminAuthenticationTimestamp } from "./authentication-freshness";
import {
  assertAdminPermission,
  createAdminAuth,
  readSelectedAdminGoogleUser,
  type AdminAuthService,
  type AdminPermissionContext,
} from "./auth-service";
import {
  ADMIN_PERMISSION_DENIAL_AUDIT_EVENT,
  requirePermissionWithAudit,
} from "./authorization-policy";
import { getAdminDeveloperActor } from "./developer-mode";
import type { AdminPermissionAction } from "./permissions";
import { AdminAuthError, type AdminActor, type AdminIdentity } from "./types";
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

export function getAdminAuth(): AdminAuthService {
  const service = createAdminAuth({
    getIdentity: getAuthJsIdentity,
    getOwnerEmails: getAdminOwnerEmails,
    userStore: getAdminUserStore(),
  });
  return {
    requireActor: () => runAdminAuthorizationOperation(() => service.requireActor()),
    requirePermission: (action, context) => runAdminAuthorizationOperation(() => service.requirePermission(action, context)),
  };
}

export async function requireAdminActor(): Promise<AdminActor> {
  return runAdminAuthorizationOperation(getRequestActor);
}

// Only the separately verified rotation Course GET may use this lookup.
export async function requireRotationAdminCourseEditor(selectedId: string): Promise<AdminActor> {
  const identity = await getAuthJsIdentity();
  if (!identity) throw new AdminAuthError("unauthenticated");
  const user = await readSelectedAdminGoogleUser(getAdminUserStore(), identity, selectedId);
  if (!user) throw new AdminAuthError("forbidden");
  const actor = { user, bookingProviderResourceIds: [], bookingResourceIds: [] };
  assertAdminPermission(actor, "courses:edit");
  return actor;
}

export async function requirePermission(
  action: AdminPermissionAction,
  context: AdminPermissionContext = {},
): Promise<AdminActor> {
  return runAdminAuthorizationOperation(() => requirePermissionWithAudit({
    action,
    context,
    getActor: getRequestActor,
    recordDenial: async ({ actor: deniedActor, requestedPermission }) => {
      // The writer does not authorize. The dynamic import avoids the
      // audit-log -> auth read-path dependency becoming a module cycle.
      const { recordAdminAuditBestEffort } = await import("./audit-log");
      await runAdminIdentityWriter("recovery", () =>
        recordAdminAuditBestEffort({
          ...ADMIN_PERMISSION_DENIAL_AUDIT_EVENT,
          actor: deniedActor,
          metadata: { requestedPermission },
        }),
      );
    },
  }));
}

export async function requireFreshAdminGoogleAuthentication(
  maxAgeMs = 5 * 60_000,
): Promise<Date> {
  const { auth } = await import("@/auth");
  const session = await auth();
  return assertFreshAdminAuthenticationTimestamp(session?.user?.authenticatedAt, Date.now(), maxAgeMs);
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
  return getAdminAuthorizationActor(resolveRequestActor);
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
