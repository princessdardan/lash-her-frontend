import { createHash } from "node:crypto";
import type { CourseJob } from "./store";

export type JobDetails = Partial<
  Pick<CourseJob, "refundId" | "accessGeneration" | "revokeReason">
>;

export function purchaseJobKey(
  kind: CourseJob["kind"],
  orderId: string,
  { refundId, accessGeneration, revokeReason }: JobDetails = {},
) {
  const suffix = refundId
    ? `-${createHash("sha256").update(refundId).digest("hex").slice(0, 32)}`
    : accessGeneration
      ? `-g${accessGeneration}`
      : "";
  // A refund must record its own terminal fence after a dispute revoke.
  const dispute =
    kind === "revoke" && revokeReason === "dispute" ? "-dispute" : "";
  return `course-${kind}-${orderId}${suffix}${dispute}`;
}
