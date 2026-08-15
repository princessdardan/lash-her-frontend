import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminUsers,
  shippingPolicyAssignments,
  type ShippingPolicyDuty,
} from "@/lib/private-db/schema";

const REQUIRED_OWNER_DUTIES: ShippingPolicyDuty[] = [
  "business_owner",
  "operations_lead",
  "finance_owner",
  "payment_fraud_owner",
  "privacy_owner",
  "security_owner",
];

type PrivateDbTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];

export interface ConfiguredFulfillmentOwner {
  id: string;
  displayName: string | null;
  email: string;
}

interface OwnerDutyAssignment {
  adminUserId: string;
  duty: ShippingPolicyDuty;
}

export async function assertConfiguredFulfillmentOwner(
  actorAdminUserId: string,
): Promise<ConfiguredFulfillmentOwner> {
  return getPrivateDb().transaction((tx) =>
    assertConfiguredFulfillmentOwnerInTransaction(tx, actorAdminUserId),
  );
}

export async function assertConfiguredOwnerIdentity(
  actorAdminUserId: string,
): Promise<ConfiguredFulfillmentOwner> {
  return getPrivateDb().transaction((tx) =>
    assertConfiguredOwnerIdentityInTransaction(tx, actorAdminUserId),
  );
}

export async function assertConfiguredFulfillmentOwnerInTransaction(
  tx: PrivateDbTransaction,
  actorAdminUserId: string,
): Promise<ConfiguredFulfillmentOwner> {
  const owner = await assertConfiguredOwnerIdentityInTransaction(
    tx,
    actorAdminUserId,
  );
  const assignments = await tx
    .select({
      adminUserId: shippingPolicyAssignments.adminUserId,
      duty: shippingPolicyAssignments.duty,
    })
    .from(shippingPolicyAssignments)
    .where(
      and(
        eq(shippingPolicyAssignments.active, true),
        inArray(shippingPolicyAssignments.duty, REQUIRED_OWNER_DUTIES),
      ),
    );
  const resolvedOwner = resolveConfiguredFulfillmentOwner({
    actorAdminUserId,
    assignments,
    configuredEmails: [owner.email],
    owners: [owner],
  });
  if (!resolvedOwner) {
    throw new Error(
      "The sole configured fulfillment owner must perform this action",
    );
  }
  return resolvedOwner;
}

export async function assertConfiguredOwnerIdentityInTransaction(
  tx: PrivateDbTransaction,
  actorAdminUserId: string,
): Promise<ConfiguredFulfillmentOwner> {
  await tx.execute(sql`
    lock table admin_users, shipping_policy_assignments in share mode
  `);
  const owners = await tx
    .select({
      id: adminUsers.id,
      displayName: adminUsers.displayName,
      email: adminUsers.email,
    })
    .from(adminUsers)
    .where(and(eq(adminUsers.role, "owner"), eq(adminUsers.status, "active")));
  const configuredEmails = configuredOwnerEmails();
  const owner = resolveConfiguredOwnerIdentity({
    actorAdminUserId,
    configuredEmails,
    owners,
  });
  if (!owner) {
    throw new Error(
      "The sole configured fulfillment owner must perform this action",
    );
  }
  return owner;
}

export function resolveConfiguredOwnerIdentity(input: {
  actorAdminUserId: string;
  configuredEmails: string[];
  owners: ConfiguredFulfillmentOwner[];
}): ConfiguredFulfillmentOwner | null {
  const configuredEmails = [
    ...new Set(
      input.configuredEmails
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const owner = input.owners[0];
  if (
    configuredEmails.length !== 1 ||
    input.owners.length !== 1 ||
    !owner ||
    owner.id !== input.actorAdminUserId ||
    owner.email.trim().toLowerCase() !== configuredEmails[0]
  ) {
    return null;
  }
  return owner;
}

export function resolveConfiguredFulfillmentOwner(input: {
  actorAdminUserId: string;
  assignments: OwnerDutyAssignment[];
  configuredEmails: string[];
  owners: ConfiguredFulfillmentOwner[];
}): ConfiguredFulfillmentOwner | null {
  const configuredEmails = [
    ...new Set(
      input.configuredEmails
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const owner = input.owners[0];
  const assignments = input.assignments;
  const assignedDuties = new Set(
    assignments.map((assignment) => assignment.duty),
  );
  if (
    configuredEmails.length !== 1 ||
    input.owners.length !== 1 ||
    !owner ||
    owner.id !== input.actorAdminUserId ||
    owner.email.trim().toLowerCase() !== configuredEmails[0] ||
    assignments.length !== REQUIRED_OWNER_DUTIES.length ||
    assignments.some((assignment) => assignment.adminUserId !== owner.id) ||
    REQUIRED_OWNER_DUTIES.some((duty) => !assignedDuties.has(duty))
  ) {
    return null;
  }
  return owner;
}

function configuredOwnerEmails(): string[] {
  return [
    ...new Set(
      (process.env.ADMIN_OWNER_EMAILS ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}
