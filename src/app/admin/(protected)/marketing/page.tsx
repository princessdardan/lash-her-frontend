import { AdminTable } from "@/components/admin/admin-table";
import { StatusPill } from "@/components/admin/status-pill";
import { listAdminMarketingContacts } from "@/lib/admin/operations-read";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminMarketingPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  await requireAdminPagePermission("marketing:view");
  const params = await searchParams;
  const query = Array.isArray(params.q) ? params.q[0] : params.q;
  const contacts = await listAdminMarketingContacts(query);

  return (
    <div className="space-y-6">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">Consent-aware directory</p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em]">Marketing contacts</h1>
        <p className="mt-3 max-w-3xl text-lh-muted">Only contacts with recorded consent are present. Unsubscribed contacts remain visible for suppression and compliance.</p>
      </header>
      <form className="flex max-w-xl gap-2" method="GET">
        <label className="sr-only" htmlFor="marketing-search">Search contacts</label>
        <input id="marketing-search" className="min-w-0 flex-1 rounded-full border border-lh-line bg-white px-4 py-3 text-sm" name="q" defaultValue={query ?? ""} placeholder="Search name or email" />
        <button className="rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold text-white" type="submit">Search</button>
      </form>
      <AdminTable caption="Marketing contacts and consent status">
        <thead className={theadClass}><tr><th className={cellClass}>Contact</th><th className={cellClass}>Source</th><th className={cellClass}>Consented</th><th className={cellClass}>Status</th><th className={cellClass}>Sync</th></tr></thead>
        <tbody className="divide-y divide-lh-line">
          {contacts.map((contact) => (
            <tr key={contact.id}>
              <td className={cellClass}><p className="font-semibold">{contact.name ?? "Unnamed contact"}</p><p className="text-xs text-lh-muted">{contact.email}</p>{contact.phone ? <p className="text-xs text-lh-muted">{contact.phone}</p> : null}</td>
              <td className={cellClass}>{contact.source}</td>
              <td className={cellClass}>{contact.lastConsentedAt.toLocaleDateString("en-CA")}</td>
              <td className={cellClass}><StatusPill tone={contact.unsubscribedAt ? "attention" : "success"}>{contact.unsubscribedAt ? "Unsubscribed" : "Opted in"}</StatusPill></td>
              <td className={cellClass}>{contact.syncIssue ? <span className="text-lh-accent">{contact.syncIssue.status}</span> : "No active issue"}</td>
            </tr>
          ))}
        </tbody>
      </AdminTable>
    </div>
  );
}

const theadClass = "bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted";
const cellClass = "px-4 py-3 align-top";
