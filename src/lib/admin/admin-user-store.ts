import "server-only";

import { eq } from "drizzle-orm";

import { normalizeAdminEmail } from "@/lib/env/admin";
import { getPrivateDb } from "@/lib/private-db/client";
import { adminUsers, type AdminRole } from "@/lib/private-db/schema";

import type { AdminUserRecord } from "./types";

export interface FindOrCreateAllowedAdminUserInput {
  allowedRole: AdminRole;
  displayName: string | null;
  email: string;
  providerUserId: string;
}

export interface AdminUserRepository {
  findByProviderUserId(providerUserId: string): Promise<AdminUserRecord | null>;
  updateAllowedAdminUserByProviderUserId(input: {
    displayName: string | null;
    email: string;
    emailNormalized: string;
    providerUserId: string;
    role: AdminRole;
  }): Promise<AdminUserRecord>;
  upsertAllowedAdminUser(input: {
    displayName: string | null;
    email: string;
    emailNormalized: string;
    providerUserId: string;
    role: AdminRole;
  }): Promise<AdminUserRecord>;
}

export interface AdminUserStore {
  findOrCreateAllowedAdminUser(input: FindOrCreateAllowedAdminUserInput): Promise<AdminUserRecord | null>;
}

export function createAdminUserStore(repository: AdminUserRepository): AdminUserStore {
  return {
    async findOrCreateAllowedAdminUser(input) {
      const existing = await repository.findByProviderUserId(input.providerUserId);

      const email = input.email.trim();
      const emailNormalized = normalizeAdminEmail(input.email);
      const adminUserInput = {
        displayName: input.displayName,
        email,
        emailNormalized,
        providerUserId: input.providerUserId,
        role: input.allowedRole,
      };

      if (existing?.status === "disabled") {
        return existing;
      }

      if (existing) {
        return repository.updateAllowedAdminUserByProviderUserId(adminUserInput);
      }

      return repository.upsertAllowedAdminUser(adminUserInput);
    },
  };
}

export function createDrizzleAdminUserRepository(): AdminUserRepository {
  const db = getPrivateDb();

  return {
    async findByProviderUserId(providerUserId) {
      const rows = await db
        .select()
        .from(adminUsers)
        .where(eq(adminUsers.providerUserId, providerUserId))
        .limit(1);

      return rows[0] ?? null;
    },
    async updateAllowedAdminUserByProviderUserId(input) {
      const rows = await db
        .update(adminUsers)
        .set({
          displayName: input.displayName,
          email: input.email,
          emailNormalized: input.emailNormalized,
          role: input.role,
          updatedAt: new Date(),
        })
        .where(eq(adminUsers.providerUserId, input.providerUserId))
        .returning();

      return rows[0];
    },
    async upsertAllowedAdminUser(input) {
      const updatedAt = new Date();
      const rows = await db
        .insert(adminUsers)
        .values({
          displayName: input.displayName,
          email: input.email,
          emailNormalized: input.emailNormalized,
          providerUserId: input.providerUserId,
          role: input.role,
          status: "active",
          updatedAt,
        })
        .onConflictDoUpdate({
          target: adminUsers.emailNormalized,
          set: {
            displayName: input.displayName,
            email: input.email,
            providerUserId: input.providerUserId,
            role: input.role,
            updatedAt,
          },
        })
        .returning();

      return rows[0];
    },
  };
}

export function getAdminUserStore(): AdminUserStore {
  return createAdminUserStore(createDrizzleAdminUserRepository());
}
