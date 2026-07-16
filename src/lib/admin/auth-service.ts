import type { AdminUserStore } from "./admin-user-store";
import { canAdmin, type AdminPermissionAction } from "./permissions";
import {
  AdminAuthError,
  type AdminActor,
  type AdminIdentity,
  type AdminUserRecord,
} from "./types";

interface AdminAuthDependencies {
  getIdentity: () => Promise<AdminIdentity | null>;
  getOwnerEmails: () => ReadonlySet<string>;
  userStore: AdminUserStore;
}

export interface AdminPermissionContext {
  bookingResourceId?: string;
}

export interface AdminAuthService {
  requireActor(): Promise<AdminActor>;
  requirePermission(
    action: AdminPermissionAction,
    context?: AdminPermissionContext,
  ): Promise<AdminActor>;
}

export function createAdminAuth(
  dependencies: AdminAuthDependencies,
): AdminAuthService {
  const requireActor = async (): Promise<AdminActor> => {
    const identity = await dependencies.getIdentity();

    if (!identity) {
      throw new AdminAuthError("unauthenticated");
    }

    if (!identity.emailVerified) {
      throw new AdminAuthError("unverified_email");
    }

    const emailNormalized = normalizeEmail(identity.email);

    if (!emailNormalized || !identity.providerUserId) {
      throw new AdminAuthError("unauthenticated");
    }

    const [providerUser, emailUser] = await Promise.all([
      dependencies.userStore.findByProviderUserId(identity.providerUserId),
      dependencies.userStore.findByEmailNormalized(emailNormalized),
    ]);

    if (providerUser && emailUser && providerUser.id !== emailUser.id) {
      throw new AdminAuthError("identity_conflict");
    }

    let user: AdminUserRecord;

    if (providerUser) {
      assertActiveUser(providerUser);
      user = await dependencies.userStore.recordSignIn({
        ...identity,
        adminUserId: providerUser.id,
      });
    } else if (emailUser) {
      assertActiveUser(emailUser);
      user = await dependencies.userStore.bindIdentity({
        ...identity,
        adminUserId: emailUser.id,
      });
    } else if (dependencies.getOwnerEmails().has(emailNormalized)) {
      user = await createBootstrapOwnerAfterRace(dependencies.userStore, identity);
      assertActiveUser(user);
    } else {
      throw new AdminAuthError("not_allowed");
    }

    assertActiveUser(user);

    return {
      bookingResourceIds:
        await dependencies.userStore.listBookingResourceIds(user.id),
      user,
    };
  };

  return {
    requireActor,
    async requirePermission(action, context = {}) {
      const actor = await requireActor();
      assertAdminPermission(actor, action, context);
      return actor;
    },
  };
}

export function assertAdminPermission(
  actor: AdminActor,
  action: AdminPermissionAction,
  context: AdminPermissionContext = {},
): void {
  if (!canAdmin({
    action,
    bookingResourceId: context.bookingResourceId,
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  })) {
    throw new AdminAuthError("forbidden");
  }
}

async function createBootstrapOwnerAfterRace(
  userStore: AdminUserStore,
  identity: AdminIdentity,
): Promise<AdminUserRecord> {
  try {
    return await userStore.createBootstrapOwner(identity);
  } catch (error) {
    const existing = await userStore.findByEmailNormalized(
      normalizeEmail(identity.email),
    );

    if (!existing) {
      throw error;
    }

    assertActiveUser(existing);

    if (existing.providerUserId === identity.providerUserId) {
      return userStore.recordSignIn({
        ...identity,
        adminUserId: existing.id,
      });
    }

    return userStore.bindIdentity({
      ...identity,
      adminUserId: existing.id,
    });
  }
}

function assertActiveUser(user: AdminUserRecord): void {
  if (user.status === "disabled") {
    throw new AdminAuthError("disabled");
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
