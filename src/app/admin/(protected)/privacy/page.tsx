import { createPrivacyRequestAction } from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function AdminPrivacyPage() {
  return (
    <div className="grid gap-8 xl:grid-cols-[1fr_420px]">
      <section className="rounded-3xl border border-lh-line bg-white p-8">
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Privacy
        </p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em] text-lh-shadow">
          Privacy Requests
        </h1>
        <p className="mt-4 max-w-2xl text-lh-muted">
          Track access, correction, deletion, redaction, and privacy inquiry cases. V1 records decisions and exports; redaction and deletion execution stay outside the dashboard.
        </p>
        <div className="mt-8 rounded-2xl border border-dashed border-lh-line bg-lh-neutral-1 p-5 text-sm text-lh-muted">
          New privacy cases appear in the command center. Open a case from its detail URL to add notes or run an owner export.
        </div>
      </section>
      <form action={createPrivacyRequestAction} className="rounded-3xl border border-lh-line bg-white p-6">
        <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">
          Create request
        </h2>
        <label className="mt-5 block text-sm font-semibold" htmlFor="requestType">
          Request type
        </label>
        <select id="requestType" name="requestType" className="mt-2 w-full rounded-xl border border-lh-line px-3 py-2">
          <option value="access_export">Access / export</option>
          <option value="correction">Correction</option>
          <option value="deletion">Deletion</option>
          <option value="redaction">Redaction</option>
          <option value="privacy_inquiry">Privacy inquiry</option>
        </select>
        <label className="mt-4 block text-sm font-semibold" htmlFor="subjectEmail">
          Subject email
        </label>
        <input id="subjectEmail" name="subjectEmail" type="email" required className="mt-2 w-full rounded-xl border border-lh-line px-3 py-2" />
        <label className="mt-4 block text-sm font-semibold" htmlFor="requesterName">
          Requester name
        </label>
        <input id="requesterName" name="requesterName" className="mt-2 w-full rounded-xl border border-lh-line px-3 py-2" />
        <label className="mt-4 block text-sm font-semibold" htmlFor="requesterNotes">
          Notes
        </label>
        <textarea id="requesterNotes" name="requesterNotes" className="mt-2 min-h-28 w-full rounded-xl border border-lh-line px-3 py-2" />
        <button type="submit" className="mt-5 rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.14em] text-white">
          Create case
        </button>
      </form>
    </div>
  );
}
