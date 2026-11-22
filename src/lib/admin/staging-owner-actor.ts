import "server-only";

import { normalizeAdminEmail } from "@/lib/env/admin";
import {
  createStagingFirstOwner,
  getAdminUserStore,
  isReviewedStagingAdminDatabase,
  type AdminUserStore,
} from "./admin-user-store";
import { canBootstrapStagingOwner, isAllowedStagingOwner, stagingOwnerRequest } from "./staging-owner-auth";
import { AdminAuthError, type AdminActor, type AdminIdentity, type AdminUserRecord } from "./types";

type StagingOwnerReads = Pick<AdminUserStore,
  "findByProviderUserId" | "findByEmailNormalized" | "listBookingProviderResourceIds" | "listBookingResourceIds">;

function isMatchingOwner(user: AdminUserRecord | null, identity: AdminIdentity): user is AdminUserRecord {
  return user?.role === "owner" && user.status === "active" &&
    user.emailNormalized === normalizeAdminEmail(identity.email) && user.providerUserId === identity.providerUserId;
}

export function createStagingOwnerAccess(dependencies: {
  isStagingRequest: () => Promise<boolean>;
  isAllowedOwner: (email: string) => boolean;
  canBootstrap: () => boolean;
  getStore: () => StagingOwnerReads;
  createFirstOwner: (identity: AdminIdentity) => Promise<AdminUserRecord>;
}) {
  async function verify(identity: AdminIdentity) {
    return identity.emailVerified === true && /^[!-~]{1,255}$/u.test(identity.providerUserId) &&
      dependencies.isAllowedOwner(identity.email) && await dependencies.isStagingRequest();
  }

  async function lookup(store: StagingOwnerReads, identity: AdminIdentity) {
    const [providerUser, emailUser] = await Promise.all([
      store.findByProviderUserId(identity.providerUserId),
      store.findByEmailNormalized(normalizeAdminEmail(identity.email)),
    ]);
    const owner = isMatchingOwner(providerUser, identity) && isMatchingOwner(emailUser, identity) &&
      providerUser.id === emailUser.id ? providerUser : null;
    return { owner, hasIdentity: Boolean(providerUser || emailUser) };
  }

  return {
    async establishStagingOwner(identity: AdminIdentity): Promise<boolean> {
      if (!await verify(identity)) return false;
      const { owner, hasIdentity } = await lookup(dependencies.getStore(), identity);
      if (owner) return true;
      if (hasIdentity || !dependencies.canBootstrap()) return false;
      try {
        return isMatchingOwner(await dependencies.createFirstOwner(identity), identity);
      } catch (error) {
        if (error instanceof AdminAuthError && error.code === "forbidden") return false;
        throw error;
      }
    },

    async requireStagingOwnerActor(identity: AdminIdentity | null): Promise<AdminActor> {
      if (!identity) throw new AdminAuthError("unauthenticated");
      if (!await verify(identity)) throw new AdminAuthError("forbidden");

      const store = dependencies.getStore();
      const { owner } = await lookup(store, identity);
      if (!owner) throw new AdminAuthError("forbidden");
      const [bookingProviderResourceIds, bookingResourceIds] = await Promise.all([
        store.listBookingProviderResourceIds(owner.id),
        store.listBookingResourceIds(owner.id),
      ]);
      return { user: owner, bookingProviderResourceIds, bookingResourceIds };
    },
  };
}

export const { establishStagingOwner, requireStagingOwnerActor } = createStagingOwnerAccess({
  isStagingRequest: async () => isReviewedStagingAdminDatabase() && await stagingOwnerRequest(),
  isAllowedOwner: isAllowedStagingOwner,
  canBootstrap: canBootstrapStagingOwner,
  getStore: getAdminUserStore,
  createFirstOwner: createStagingFirstOwner,
});
