import { notFound } from "next/navigation";

import { getAuditLogService } from "@/lib/admin/audit-log";
import { getAdminAuth } from "@/lib/admin/auth";
import { getPrivacyRequestService } from "@/lib/admin/privacy-requests";

import { addPrivacyRequestEventAction } from "../actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ id: string }> };

export default async function AdminPrivacyRequestDetailPage({ params }: PageProps) {
  const actor = await getAdminAuth().requireAdmin();
  const { id } = await params;
  const result = await getPrivacyRequestService().getRequestWithEvents(id);

  if (!result) {
    notFound();
  }

  await getAuditLogService().record({
    action: "privacy_request_view",
    actor,
    domain: "privacy",
    privacyRequestId: result.request.id,
    targetId: result.request.id,
    targetType: "privacy_request",
  });

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-lh-line bg-white p-8">
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Privacy case
        </p>
        <h1 className="mt-2 font-heading text-5xl uppercase tracking-[0.08em] text-lh-shadow">
          {result.request.subjectEmailNormalized}
        </h1>
        <dl className="mt-5 grid gap-4 text-sm text-lh-muted md:grid-cols-3">
          <div>
            <dt className="font-semibold text-lh-ink">Status</dt>
            <dd className="mt-1">{result.request.status}</dd>
          </div>
          <div>
            <dt className="font-semibold text-lh-ink">Request type</dt>
            <dd className="mt-1">{result.request.requestType}</dd>
          </div>
          <div>
            <dt className="font-semibold text-lh-ink">Created</dt>
            <dd className="mt-1">{result.request.createdAt.toISOString()}</dd>
          </div>
        </dl>
        {actor.user.role === "owner" ? (
          <form action={`/admin/privacy/${result.request.id}/export`} method="POST" className="mt-6 max-w-xl rounded-2xl border border-lh-line bg-lh-neutral-1 p-5">
            <label className="block text-sm font-semibold" htmlFor="reason">
              Owner export reason
            </label>
            <p className="mt-1 text-sm text-lh-muted">
              Required for audit logging. Use the active privacy case reason, not a generic shortcut.
            </p>
            <input id="reason" name="reason" required minLength={5} className="mt-3 w-full rounded-xl border border-lh-line px-3 py-2" />
            <button type="submit" className="mt-4 inline-flex rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.14em] text-white">
              Download owner export
            </button>
          </form>
        ) : null}
      </section>
      <form action={addPrivacyRequestEventAction} className="rounded-3xl border border-lh-line bg-white p-6">
        <input type="hidden" name="privacyRequestId" value={result.request.id} />
        <label className="block text-sm font-semibold" htmlFor="message">
          Add case note
        </label>
        <textarea id="message" name="message" required className="mt-2 min-h-28 w-full rounded-xl border border-lh-line px-3 py-2" />
        <button type="submit" className="mt-4 rounded-full border border-lh-line px-5 py-3 text-sm font-semibold uppercase tracking-[0.14em]">
          Add note
        </button>
      </form>
      <section className="rounded-3xl border border-lh-line bg-white p-6">
        <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">
          Case history
        </h2>
        <div className="mt-4 divide-y divide-lh-line">
          {result.events.map((event) => (
            <article key={event.id} className="py-4">
              <p className="font-semibold">{event.eventType}</p>
              {event.message ? <p className="mt-1 text-lh-muted">{event.message}</p> : null}
              <p className="mt-2 text-xs uppercase tracking-[0.14em] text-lh-muted">
                {event.createdAt.toISOString()}
              </p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
