import "server-only";

import { asc, desc, eq, sql } from "drizzle-orm";
import { mintApplicationToken } from "@/lib/api-integration/application-jwt";
import { getGatewayTransport } from "@/lib/api-integration/gateway-transport";
import { parseCourseResponse } from "@/lib/api-integration/response-validation";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  coursePurchaseJobReplays as replays,
  coursePurchaseJobs as jobs,
  coursePurchaseOrders as orders,
} from "./schema";

export async function readCoursePurchaseSupport(orderId: string) {
  return getPrivateDb().transaction(
    async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const [order] = await tx
        .select({
          id: orders.id,
          customerId: orders.customerId,
          courseId: orders.courseId,
          title: orders.courseTitle,
          status: orders.status,
          access: orders.access,
          paymentId: orders.squarePaymentId,
          totalCents: orders.totalCents,
          refundedCents: orders.refundedCents,
          chargedAt: orders.chargedAt,
        })
        .from(orders)
        .where(eq(orders.id, orderId));
      if (!order) return null;

      const recoveryJobs = await tx
        .select({
          id: jobs.id,
          kind: jobs.kind,
          status: jobs.status,
          attempts: jobs.attempts,
          lastFailure: jobs.lastFailure,
        })
        .from(jobs)
        .where(eq(jobs.orderId, orderId))
        .orderBy(asc(jobs.createdAt), asc(jobs.id));
      const latestReplays = await tx
        .selectDistinctOn([replays.jobId], {
          jobId: replays.jobId,
          reason: replays.reason,
          createdAt: replays.createdAt,
        })
        .from(replays)
        .innerJoin(jobs, eq(replays.jobId, jobs.id))
        .where(eq(jobs.orderId, orderId))
        .orderBy(asc(replays.jobId), desc(replays.createdAt), desc(replays.id));
      const replayByJob = new Map(
        latestReplays.map((replay) => [replay.jobId, replay]),
      );

      return {
        order,
        jobs: recoveryJobs.map((job) => ({
          ...job,
          replay: replayByJob.get(job.id),
        })),
      };
    },
    { accessMode: "read only", isolationLevel: "repeatable read" },
  );
}

const grantsPath = "/v1/admin/entitlements/grants";

export async function readOrderCourseGrants(
  order: { id: string; customerId: string; courseId: string },
  adminId: string,
) {
  const params = new URLSearchParams({
    orderId: order.id,
    userId: order.customerId,
    courseId: order.courseId,
    grantReason: "purchase",
    provider: "square",
  });
  try {
    const response = await getGatewayTransport()({
      method: "GET",
      path: `${grantsPath}?${params}`,
      applicationToken: mintApplicationToken({ profile: "course-admin", adminId, capabilities: ["course-support"] }),
    });
    if (!response.ok) return null;
    const result = parseCourseResponse(
      grantsPath,
      "get",
      200,
      await response.json(),
    );
    if (
      result.grants.some(
        (grant) =>
          grant.orderId !== order.id ||
          grant.userId !== order.customerId ||
          grant.courseId !== order.courseId ||
          grant.grantReason !== "purchase" ||
          grant.provider !== "square",
      )
    )
      return null;
    const now = Date.now();
    return {
      grants: result.grants.map(
        ({ grantId, enrollmentId, status, expiresAt }) => ({
          grantId,
          enrollmentId,
          status:
            status === "active" && expiresAt && Date.parse(expiresAt) <= now
              ? ("expired" as const)
              : status,
        }),
      ),
      partial: result.nextCursor !== null,
    };
  } catch {
    return null;
  }
}
