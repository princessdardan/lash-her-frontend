import "server-only";

import { and, eq } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  customerProviderAccounts,
  customerUsers,
  customerVerifiedEmails,
} from "@/lib/private-db/schema";

import type { CustomerIdentityStore } from "./types";

export function createDrizzleCustomerIdentityStore(): CustomerIdentityStore {
  const db = getPrivateDb();

  return {
    transaction(operation) {
      return db.transaction(async (transaction) =>
        operation({
          async createCustomer(input) {
            await transaction.insert(customerUsers).values({
              createdAt: input.createdAt,
              displayName: input.displayName,
              id: input.id,
              lastSignedInAt: input.createdAt,
              status: "active",
              updatedAt: input.createdAt,
            });
          },
          async createProviderAccount(input) {
            const rows = await transaction
              .insert(customerProviderAccounts)
              .values({
                createdAt: input.createdAt,
                customerUserId: input.customerUserId,
                email: input.email,
                emailNormalized: input.emailNormalized,
                emailVerifiedAt: input.verifiedAt,
                id: input.id,
                lastSignedInAt: input.createdAt,
                provider: input.provider,
                providerAccountId: input.providerAccountId,
                updatedAt: input.createdAt,
              })
              .onConflictDoNothing({
                target: [
                  customerProviderAccounts.provider,
                  customerProviderAccounts.providerAccountId,
                ],
              })
              .returning({ id: customerProviderAccounts.id });

            return rows[0] !== undefined;
          },
          async createVerifiedEmail(input) {
            const rows = await transaction
              .insert(customerVerifiedEmails)
              .values({
                createdAt: input.createdAt,
                customerUserId: input.customerUserId,
                email: input.email,
                emailNormalized: input.emailNormalized,
                id: input.id,
                updatedAt: input.createdAt,
                verificationProvider: input.verificationProvider,
                verifiedAt: input.verifiedAt,
              })
              .onConflictDoNothing({
                target: customerVerifiedEmails.emailNormalized,
              })
              .returning({ id: customerVerifiedEmails.id });

            return rows[0] !== undefined;
          },
          async findProviderAccount(provider, providerAccountId) {
            const rows = await transaction
              .select({
                customerUserId: customerProviderAccounts.customerUserId,
              })
              .from(customerProviderAccounts)
              .where(
                and(
                  eq(customerProviderAccounts.provider, provider),
                  eq(
                    customerProviderAccounts.providerAccountId,
                    providerAccountId,
                  ),
                ),
              )
              .limit(1);

            return rows[0] ?? null;
          },
          async findCustomerStatus(customerUserId) {
            const rows = await transaction
              .select({ status: customerUsers.status })
              .from(customerUsers)
              .where(eq(customerUsers.id, customerUserId))
              .limit(1);

            return rows[0]?.status ?? null;
          },
          async findVerifiedEmail(emailNormalized) {
            const rows = await transaction
              .select({
                customerUserId: customerVerifiedEmails.customerUserId,
              })
              .from(customerVerifiedEmails)
              .where(
                eq(customerVerifiedEmails.emailNormalized, emailNormalized),
              )
              .limit(1);

            return rows[0] ?? null;
          },
          async recordSignIn(input) {
            await transaction
              .update(customerUsers)
              .set({
                ...(input.displayName === null
                  ? {}
                  : { displayName: input.displayName }),
                lastSignedInAt: input.signedInAt,
                updatedAt: input.signedInAt,
              })
              .where(eq(customerUsers.id, input.customerUserId));

            await transaction
              .update(customerProviderAccounts)
              .set({
                email: input.email,
                emailNormalized: input.emailNormalized,
                emailVerifiedAt: input.signedInAt,
                lastSignedInAt: input.signedInAt,
                updatedAt: input.signedInAt,
              })
              .where(
                and(
                  eq(customerProviderAccounts.provider, input.provider),
                  eq(
                    customerProviderAccounts.providerAccountId,
                    input.providerAccountId,
                  ),
                  eq(
                    customerProviderAccounts.customerUserId,
                    input.customerUserId,
                  ),
                ),
              );
          },
        }),
      );
    },
  };
}
