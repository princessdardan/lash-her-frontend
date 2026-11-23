import { redirect } from "next/navigation";
import {
  AdminWorkspaceHeader,
  AdminWorkspaceSearch,
} from "@/components/admin/admin-workspace-list";
import { CourseJobReplayForm } from "@/components/admin/course-job-replay-form";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import { canAdmin } from "@/lib/admin/permissions";
import { hasP407CheckoutBinding } from "@/lib/writer-admission/p407-course";
import { courseRecoveryEnabled } from "@/lib/course-purchases/policy";
import { lookupSupportOrderId } from "@/lib/course-purchases/store";
import {
  readCoursePurchaseSupport,
  readOrderCourseGrants,
} from "@/lib/course-purchases/support";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const paymentStatus = {
  quoted: "Awaiting payment",
  charging: "Payment pending",
  paid: "Paid",
  failed: "Payment failed",
  refunded: "Refunded",
};
const recordedAccess = {
  none: "Not granted",
  pending: "Being prepared",
  active: "Active",
  revocation_pending: "Removal pending",
  revoked: "Removed",
};
const grantStatus = {
  active: "Active",
  revoked: "Revoked",
  expired: "Expired",
};
const jobKind = {
  grant: "Grant access",
  revoke: "Revoke access",
  tax_sale: "Record sale tax",
  tax_refund: "Record refund tax",
  receipt: "Send receipt",
};
const jobStatus = {
  pending: "Queued",
  processing: "Processing",
  done: "Completed",
  dead: "Failed",
  canceled: "Canceled",
};
const money = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  currencyDisplay: "code",
});
const dateTime = new Intl.DateTimeFormat("en-CA", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Toronto",
});
const panel = "space-y-3 rounded-2xl border border-lh-line bg-white p-5";

export default async function CoursePurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const actor = await requireAdminPagePermission("payments:view");
  if (actor.developerMode) redirect("/admin/not-authorized");
  const { q } = await searchParams;
  const reference = typeof q === "string" ? q.trim().slice(0, 80) : "";
  const orderId =
    typeof q === "string" ? lookupSupportOrderId(reference) : undefined;
  const support = orderId
    ? await readCoursePurchaseSupport(orderId).catch(() => undefined)
    : null;
  const enrollment = support
    ? await readOrderCourseGrants(support.order, actor.user.id)
    : null;
  const canReplay =
    !hasP407CheckoutBinding() &&
    courseRecoveryEnabled() &&
    canAdmin({
      action: "payments:refund",
      role: actor.user.role,
      bookingProviderResourceIds: actor.bookingProviderResourceIds,
      bookingResourceIds: actor.bookingResourceIds,
    });

  return (
    <div className="space-y-6">
      <AdminWorkspaceHeader
        title="Course purchases"
        eyebrow="Daily work"
        description="Find a Course payment, enrollment, and recovery jobs using the buyer’s exact order reference."
      />
      <AdminWorkspaceSearch
        action="/admin/course-purchases"
        label="Order reference"
        placeholder="Order reference"
        search={reference}
      />
      {q !== undefined && !orderId && (
        <p role="alert">Enter a complete order reference.</p>
      )}
      {orderId && support === null && (
        <p>No Course purchase matches this order reference.</p>
      )}
      {support === undefined && (
        <p role="alert">Course purchase records are temporarily unavailable.</p>
      )}
      {support && (
        <>
          <section className={panel} aria-labelledby="course-payment">
            <h2 id="course-payment" className="text-lg font-semibold">
              Payment
            </h2>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Detail label="Order reference">{support.order.id}</Detail>
              <Detail label="Course">{support.order.title}</Detail>
              <Detail label="Payment status">
                {paymentStatus[support.order.status]}
              </Detail>
              <Detail label="Square payment ID">
                {support.order.paymentId ?? "Not recorded"}
              </Detail>
              <Detail label="Order total">
                {money.format(support.order.totalCents / 100)}
              </Detail>
              <Detail label="Refunded">
                {money.format(support.order.refundedCents / 100)}
              </Detail>
              {support.order.chargedAt && (
                <Detail label="Payment recorded (Toronto time)">
                  {dateTime.format(support.order.chargedAt)}
                </Detail>
              )}
            </dl>
          </section>
          <section className={panel} aria-labelledby="course-enrollment">
            <h2 id="course-enrollment" className="text-lg font-semibold">
              Enrollment
            </h2>
            <dl>
              <Detail label="Access recorded by checkout">
                {recordedAccess[support.order.access]}
              </Detail>
            </dl>
            {enrollment === null && (
              <p role="status">
                Course enrollment verification is temporarily unavailable.
              </p>
            )}
            {enrollment?.grants.length === 0 && (
              <p>Course has no purchase grant for this order.</p>
            )}
            {enrollment?.grants.map((grant) => (
              <dl
                key={grant.grantId}
                className="grid gap-3 border-t border-lh-line pt-3 sm:grid-cols-2"
              >
                <Detail label="Course grant status">
                  {grantStatus[grant.status]}
                </Detail>
                <Detail label="Enrollment ID">
                  {grant.enrollmentId ?? "Not recorded"}
                </Detail>
                <Detail label="Purchase grant ID">{grant.grantId}</Detail>
              </dl>
            ))}
            {enrollment?.partial && (
              <p>Additional grants exist in the Course ledger.</p>
            )}
          </section>
          <section className={panel} aria-labelledby="course-recovery">
            <h2 id="course-recovery" className="text-lg font-semibold">
              Recovery jobs
            </h2>
            {support.jobs.length === 0 && (
              <p>No recovery jobs for this order.</p>
            )}
            {support.jobs.map((job) => (
              <article
                key={job.id}
                className="space-y-2 border-t border-lh-line pt-3"
              >
                <h3 className="font-semibold">{jobKind[job.kind]}</h3>
                <dl className="grid gap-3 sm:grid-cols-2">
                  <Detail label="Job ID">{job.id}</Detail>
                  <Detail label="Job status">{jobStatus[job.status]}</Detail>
                  <Detail label="Attempts">{job.attempts}</Detail>
                  {job.lastFailure && (
                    <Detail label="Last failure">{job.lastFailure}</Detail>
                  )}
                  {job.replay && (
                    <Detail label="Latest replay reason">
                      {job.replay.reason} (
                      {dateTime.format(job.replay.createdAt)}, Toronto time)
                    </Detail>
                  )}
                </dl>
                {canReplay && job.status === "dead" && (
                  <CourseJobReplayForm
                    orderReference={support.order.id}
                    jobId={job.id}
                  />
                )}
              </article>
            ))}
          </section>
        </>
      )}
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-lh-muted">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}
