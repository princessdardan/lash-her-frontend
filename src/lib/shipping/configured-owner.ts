import "server-only";

import { and, eq } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import { adminUsers } from "@/lib/private-db/schema";

/**
 * Owner gate for fulfillment/shipping admin actions.
 *
 * Simplified for a solo-operator business: the "owner" is any active admin
 * whose email is listed in `ADMIN_OWNER_EMAILS`. The former model — exactly one
 * active `role='owner'` admin holding six separately-assigned duties in
 * `shipping_policy_assignments`, verified via step-up — was separation-of-duties
 * ceremony that protects nothing when one person holds every duty, and it
 * created a bootstrap deadlock (assigning the first duty required already
 * holding all six). Function names are unchanged so callers are unaffected.
 */

type PrivateDbTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];

export interface ConfiguredFulfillmentOwner {
  id: string;
  displayName: string | null;
  email: string;
}

export function configuredOwnerEmails(): string[] {
  return [
    ...new Set(
      (process.env.ADMIN_OWNER_EMAILS ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function isConfiguredOwnerEmail(
  email: string | null | undefined,
  configuredEmails: string[] = configuredOwnerEmails(),
): boolean {
  if (typeof email !== "string") return false;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 && configuredEmails.includes(normalized);
}

export async function assertConfiguredFulfillmentOwner(
  actorAdminUserId: string,
): Promise<ConfiguredFulfillmentOwner> {
  return getPrivateDb().transaction((tx) =>
    assertConfiguredOwnerIdentityInTransaction(tx, actorAdminUserId),
  );
}

export async function assertConfiguredOwnerIdentity(
  actorAdminUserId: string,
): Promise<ConfiguredFulfillmentOwner> {
  return getPrivateDb().transaction((tx) =>
    assertConfiguredOwnerIdentityInTransaction(tx, actorAdminUserId),
  );
}

// Duty assignments no longer exist; the fulfillment-owner check is the identity
// check. Kept as a distinct export for callers that referenced it.
export async function assertConfiguredFulfillmentOwnerInTransaction(
  tx: PrivateDbTransaction,
  actorAdminUserId: string,
): Promise<ConfiguredFulfillmentOwner> {
  return assertConfiguredOwnerIdentityInTransaction(tx, actorAdminUserId);
}

export async function assertConfiguredOwnerIdentityInTransaction(
  tx: PrivateDbTransaction,
  actorAdminUserId: string,
): Promise<ConfiguredFulfillmentOwner> {
  const configuredEmails = configuredOwnerEmails();
  if (configuredEmails.length === 0) {
    throw new Error(
      "No fulfillment owner is configured (set ADMIN_OWNER_EMAILS)",
    );
  }
  const [actor] = await tx
    .select({
      id: adminUsers.id,
      displayName: adminUsers.displayName,
      email: adminUsers.email,
    })
    .from(adminUsers)
    .where(
      and(eq(adminUsers.id, actorAdminUserId), eq(adminUsers.status, "active")),
    )
    .limit(1);
  if (!actor || !isConfiguredOwnerEmail(actor.email, configuredEmails)) {
    throw new Error(
      "The configured fulfillment owner must perform this action",
    );
  }
  return actor;
}
