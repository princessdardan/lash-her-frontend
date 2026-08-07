import "server-only";

import { and, eq } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import { customerUsers } from "@/lib/private-db/schema";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function isActiveCustomerUser(
  customerUserId: string,
): Promise<boolean> {
  if (!UUID_PATTERN.test(customerUserId)) {
    return false;
  }

  const [customer] = await getPrivateDb()
    .select({ id: customerUsers.id })
    .from(customerUsers)
    .where(
      and(
        eq(customerUsers.id, customerUserId),
        eq(customerUsers.status, "active"),
      ),
    )
    .limit(1);

  return customer !== undefined;
}
