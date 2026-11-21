import "server-only";

import { and, asc, gt, inArray, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import { compareCourseEntitlements } from "./course-api";
import { coursePurchaseOrders as orders } from "./schema";

const pageSize = 100;
const findingLimit = 2 * pageSize;

export async function reconcileCoursePurchasePage(
  after: string | null,
  signal?: AbortSignal,
) {
  const rows = await getPrivateDb().transaction(
    async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      return tx
        .select({
          orderId: orders.id,
          userId: orders.customerId,
          courseId: orders.courseId,
          status: orders.status,
        })
        .from(orders)
        .where(
          and(
            inArray(orders.status, ["paid", "refunded"]),
            after === null ? undefined : gt(orders.id, after),
          ),
        )
        .orderBy(asc(orders.id))
        .limit(pageSize + 1);
    },
    { accessMode: "read only" },
  );
  const grants = rows.slice(0, pageSize).map(({ status, ...scope }) => ({
    ...scope,
    expectedStatus:
      status === "paid" ? ("active" as const) : ("revoked" as const),
  }));

  const result = grants.length
    ? await compareCourseEntitlements(
        { grants, pageSize, snapshotComplete: false },
        signal,
      )
    : { checkpoint: null, mismatches: [] };
  const orderIds = new Set(grants.map(({ orderId }) => orderId));

  return {
    checkpoint: result.checkpoint,
    checkedOrders: grants.length,
    nextCursor: rows.length > pageSize ? grants[pageSize - 1].orderId : null,
    mismatchCount: result.mismatches.length,
    adminOverrideCount: result.mismatches.filter(
      ({ mismatchType }) => mismatchType === "admin_override",
    ).length,
    mismatches: result.mismatches
      .slice(0, findingLimit)
      .map(({ orderId, expectedStatus, actualStatus, mismatchType }) => ({
        orderId: orderIds.has(orderId) ? orderId : null,
        expectedStatus,
        actualStatus,
        mismatchType,
      })),
  };
}
