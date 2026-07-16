import "server-only";

import { eq } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminUserResources,
  adminUsers,
} from "@/lib/private-db/schema";

import type { AdminIdentity, AdminUserRecord } from "./types";

export interface AdminUserRepository {
  bindIdentity(input: AdminIdentity & { adminUserId: string }): Promise<AdminUserRecord>;
  createBootstrapOwner(identity: AdminIdentity): Promise<AdminUserRecord>;
  findByEmailNormalized(emailNormalized: string): Promise<AdminUserRecord | null>;
  findByProviderUserId(providerUserId: string): Promise<AdminUserRecord | null>;
  listBookingResourceIds(adminUserId: string): Promise<string[]>;
  recordSignIn(input: AdminIdentity & { adminUserId: string }): Promise<AdminUserRecord>;
}

export type AdminUserStore = AdminUserRepository;

const adminUserSelection = {
  displayName: adminUsers.displayName,
  email: adminUsers.email,
  emailNormalized: adminUsers.emailNormalized,
  id: adminUsers.id,
  providerUserId: adminUsers.providerUserId,
  role: adminUsers.role,
  status: adminUsers.status,
};

export function createDrizzleAdminUserRepository(): AdminUserRepository {
  const db = getPrivateDb();

  return {
    async bindIdentity(input) {
      const rows = await db
        .update(adminUsers)
        .set({
          displayName: input.displayName,
          email: input.email.trim(),
          emailNormalized: input.email.trim().toLowerCase(),
          lastSignedInAt: new Date(),
          providerUserId: input.providerUserId,
          updatedAt: new Date(),
        })
        .where(eq(adminUsers.id, input.adminUserId))
        .returning(adminUserSelection);

      if (!rows[0]) {
        throw new Error("Admin user disappeared while binding identity");
      }

      return rows[0];
    },
    async createBootstrapOwner(identity) {
      const rows = await db
        .insert(adminUsers)
        .values({
          displayName: identity.displayName,
          email: identity.email.trim(),
          emailNormalized: identity.email.trim().toLowerCase(),
          lastSignedInAt: new Date(),
          providerUserId: identity.providerUserId,
          role: "owner",
          status: "active",
        })
        .onConflictDoNothing()
        .returning(adminUserSelection);

      if (!rows[0]) {
        throw new Error("Admin bootstrap identity already exists");
      }

      return rows[0];
    },
    async findByEmailNormalized(emailNormalized) {
      const rows = await db
        .select(adminUserSelection)
        .from(adminUsers)
        .where(eq(adminUsers.emailNormalized, emailNormalized))
        .limit(1);

      return rows[0] ?? null;
    },
    async findByProviderUserId(providerUserId) {
      const rows = await db
        .select(adminUserSelection)
        .from(adminUsers)
        .where(eq(adminUsers.providerUserId, providerUserId))
        .limit(1);

      return rows[0] ?? null;
    },
    async listBookingResourceIds(adminUserId) {
      const rows = await db
        .select({ bookingResourceId: adminUserResources.bookingResourceId })
        .from(adminUserResources)
        .where(eq(adminUserResources.adminUserId, adminUserId));

      return rows.map((row) => row.bookingResourceId);
    },
    async recordSignIn(input) {
      const rows = await db
        .update(adminUsers)
        .set({
          displayName: input.displayName,
          email: input.email.trim(),
          emailNormalized: input.email.trim().toLowerCase(),
          lastSignedInAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(adminUsers.id, input.adminUserId))
        .returning(adminUserSelection);

      if (!rows[0]) {
        throw new Error("Admin user disappeared while refreshing identity");
      }

      return rows[0];
    },
  };
}

export function getAdminUserStore(): AdminUserStore {
  return createDrizzleAdminUserRepository();
}
