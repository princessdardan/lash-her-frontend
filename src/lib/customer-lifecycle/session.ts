import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { cookies } from "next/headers";
import { customerSessionCookieName, hashCustomerSession, resolveCustomerAuthConfiguration } from "@/lib/customer-auth/policy";
import { customerSessions, customerUsers } from "@/lib/customer-auth/schema";
import { getPrivateDb } from "@/lib/private-db/client";

export interface AccountCustomerSession { userId: string; tokenHash: string }
export async function getAccountCustomerSession(): Promise<AccountCustomerSession | null> {
  const configuration = resolveCustomerAuthConfiguration();
  if (!configuration) return null;
  const token = (await cookies()).get(customerSessionCookieName(configuration.secure))?.value;
  if (!token || token.length > 256) return null;
  const tokenHash = hashCustomerSession(token);
  const [record] = await getPrivateDb().select({ userId: customerUsers.id }).from(customerSessions)
    .innerJoin(customerUsers, eq(customerUsers.id, customerSessions.userId))
    .where(and(eq(customerSessions.tokenHash, tokenHash), gt(customerSessions.expires, new Date()), eq(customerUsers.status, "active"))).limit(1);
  return record ? { userId: record.userId, tokenHash } : null;
}
