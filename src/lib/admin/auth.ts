import "server-only";

import { getAdminEmailAllowlists, resolveAllowedAdminRole, type AdminEmailAllowlists } from "@/lib/env/admin";

import { getAdminUserStore, type AdminUserStore } from "./admin-user-store";
import { AdminAuthError, type AdminActor } from "./types";

interface SessionUser {
  displayName: string | null;
  email: string;
  providerUserId: string;
}

interface AdminAuthDependencies {
  getAllowlists: () => AdminEmailAllowlists;
  getSessionUser: () => Promise<SessionUser | null>;
  userStore: AdminUserStore;
}

export interface AdminAuthService {
  requireAdmin(): Promise<AdminActor>;
  requireOwner(): Promise<AdminActor>;
}

export function createAdminAuth(dependencies: AdminAuthDependencies): AdminAuthService {
  return {
    async requireAdmin() {
      const sessionUser = await dependencies.getSessionUser();

      if (sessionUser === null) {
        throw new AdminAuthError("unauthenticated");
      }

      const allowedRole = resolveAllowedAdminRole(sessionUser.email, dependencies.getAllowlists());

      if (allowedRole === null) {
        throw new AdminAuthError("not_allowed");
      }

      const user = await dependencies.userStore.findOrCreateAllowedAdminUser({
        allowedRole,
        displayName: sessionUser.displayName,
        email: sessionUser.email,
        providerUserId: sessionUser.providerUserId,
      });

      if (user === null) {
        throw new AdminAuthError("not_allowed");
      }

      if (user.status === "disabled") {
        throw new AdminAuthError("disabled");
      }

      return { user };
    },
    async requireOwner() {
      const actor = await this.requireAdmin();

      if (actor.user.role !== "owner") {
        throw new AdminAuthError("forbidden");
      }

      return actor;
    },
  };
}

export function getAdminAuth(): AdminAuthService {
  return createAdminAuth({
    getAllowlists: getAdminEmailAllowlists,
    getSessionUser: getClerkSessionUser,
    userStore: getAdminUserStore(),
  });
}

async function getClerkSessionUser(): Promise<SessionUser | null> {
  const { currentUser } = await import("@clerk/nextjs/server");
  const user = await currentUser();

  if (!user) {
    return null;
  }

  const primaryEmail = user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)
    ?? user.emailAddresses[0];

  if (!primaryEmail) {
    return null;
  }

  return {
    displayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.fullName || null,
    email: primaryEmail.emailAddress,
    providerUserId: user.id,
  };
}
