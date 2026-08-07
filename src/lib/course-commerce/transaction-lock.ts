import { sql } from "drizzle-orm";

export function getHelcimPaymentTransactionLockQuery(
  providerTransactionId: string,
) {
  return sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`course-payment:helcim:${providerTransactionId}`}, 0)
    )
  `;
}
