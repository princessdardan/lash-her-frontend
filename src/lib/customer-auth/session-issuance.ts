import "server-only";

import { and, eq, gt } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import { hashCustomerSession } from "./policy";
import { customerSessions, customerUsers } from "./schema";

/** Lock customer before session, matching lifecycle UPDATE -> session DELETE.
 * No provider/network await, session renewal, cleanup, or writes occur here. */
export async function issueLockedCustomerToken(sessionToken: string, issue: (customerId: string) => string, dependencies: {
  database?: typeof getPrivateDb; now?: () => Date;
} = {}): Promise<{ customerId: string; token: string } | null> {
  if (!sessionToken || sessionToken.length > 256) return null;
  const database = dependencies.database ?? getPrivateDb;
  const hash = hashCustomerSession(sessionToken);
  return database().transaction(async tx => {
    const [candidate] = await tx.select({ userId: customerSessions.userId }).from(customerSessions).where(eq(customerSessions.tokenHash, hash)).limit(1);
    if (!candidate) return null;
    const [customer] = await tx.select({ id: customerUsers.id, status: customerUsers.status }).from(customerUsers).where(eq(customerUsers.id, candidate.userId)).for("share");
    if (!customer || customer.status !== "active") return null;
    const [session] = await tx.select({ userId: customerSessions.userId }).from(customerSessions).where(and(eq(customerSessions.tokenHash, hash), eq(customerSessions.userId, customer.id),
      gt(customerSessions.expires, (dependencies.now ?? (() => new Date()))()))).for("share");
    if (!session) return null;
    // The synchronous local issuer must finish while both SHARE locks are held.
    const token = issue(customer.id);
    if (typeof token !== "string" || !token) throw new Error("CUSTOMER_TOKEN_ISSUANCE_FAILED");
    return { customerId: customer.id, token };
  });
}
