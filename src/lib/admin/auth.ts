import "server-only";

import { headers } from "next/headers";
import { after } from "next/server";

import { getAdminOwnerEmails } from "@/lib/env/admin";

import { getAdminUserStore } from "./admin-user-store";
import {
  createAdminAuth,
  type AdminAuthService,
  type AdminPermissionContext,
} from "./auth-service";
import type { AdminPermissionAction } from "./permissions";
import type { AdminActor, AdminIdentity } from "./types";

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
  const actor = await getRequestActor();
  const { assertAdminPermission } = await import("./auth-service");

  assertAdminPermission(actor, action, context);
  return actor;
}

async function getRequestActor(): Promise<AdminActor> {
  const requestId = (await headers()).get(ADMIN_REQUEST_ID_HEADER);

  if (!requestId) {
    return getAdminAuth().requireActor();
  }

  const cached = requestActors.get(requestId);

  if (cached) {
    return cached;
  }

  const actorPromise = getAdminAuth().requireActor();
  requestActors.set(requestId, actorPromise);
  after(() => {
    requestActors.delete(requestId);
  });

  return actorPromise;
}

async function getAuthJsIdentity(): Promise<AdminIdentity | null> {
  const { auth } = await import("@/auth");
  const session = await auth();
  const sessionUser = session?.user;

  if (
    !sessionUser
    || typeof sessionUser.email !== "string"
    || typeof sessionUser.providerUserId !== "string"
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
