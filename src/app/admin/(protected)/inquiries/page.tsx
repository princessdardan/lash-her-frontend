import {
  AdminWorkspaceHeader,
  AdminWorkspaceResults,
  AdminWorkspaceSearch,
} from "@/components/admin/admin-workspace-list";
import { StatusPill } from "@/components/admin/status-pill";
import {
  listAdminInquiries,
  type AdminInquiryRow,
} from "@/lib/admin/operations-workspaces";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface AdminInquiriesPageProps {
  searchParams: Promise<{
    page?: string | string[];
    q?: string | string[];
  }>;
}

export default async function AdminInquiriesPage({
  searchParams,
}: AdminInquiriesPageProps) {
  await requireAdminPagePermission("marketing:view");
  const params = await searchParams;
  const result = await listAdminInquiries({
    page: parsePositivePage(firstString(params.page)),
    search: firstString(params.q),
  });

  return (
    <div className="space-y-6">
      <AdminWorkspaceHeader
        description={
          <>
            <p>
              Saved general and training inquiry submissions with the contact
              details and message fields supplied by the customer.
            </p>
            <p className="mt-2 text-sm">
              Read, assigned, answered, and email-delivery states are not
              recorded. This page therefore does not label an inquiry as new,
              unanswered, or complete.
            </p>
          </>
        }
        eyebrow="Daily work"
        title="Inquiries"
      />

      <AdminWorkspaceSearch
        action="/admin/inquiries"
        label="Search inquiries"
        placeholder="Search name, email, phone, message, or program"
        search={result.search}
      />

      <p className="text-sm text-lh-muted">
        Submission times shown in {result.timezoneLabel}. Retained records may
        have customer details removed under the data-retention policy.
      </p>

      <AdminWorkspaceResults
        emptyMessage={
          result.search
            ? "No saved general or training inquiries match this search."
            : "No general or training inquiry submissions have been saved."
        }
        page={result.page}
        pageCount={result.pageCount}
        pageSize={result.pageSize}
        path="/admin/inquiries"
        rows={
          <>
            <div className="space-y-3 md:hidden">
              {result.rows.map((inquiry) => (
                <InquiryCard
                  inquiry={inquiry}
                  key={inquiry.id}
                  timezone={result.timezone}
                />
              ))}
            </div>
            <InquiryTable inquiries={result.rows} timezone={result.timezone} />
          </>
        }
        search={result.search}
        total={result.total}
      />
    </div>
  );
}

function InquiryCard({
  inquiry,
  timezone,
}: {
  inquiry: AdminInquiryRow;
  timezone: string;
}) {
  return (
    <article className="rounded-2xl border border-lh-line bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{inquiry.content.subject}</p>
          <p className="mt-1 text-sm text-lh-muted">{inquiry.typeLabel}</p>
        </div>
        <StatusPill>{inquiry.consentLabel}</StatusPill>
      </div>

      <dl className="mt-4 grid gap-3 text-sm">
        <div>
          <dt className={termClass}>Contact</dt>
          <dd className="mt-1 font-semibold">{inquiry.name}</dd>
          {inquiry.email ? (
            <dd className="break-all text-lh-muted">{inquiry.email}</dd>
          ) : null}
          {inquiry.phone ? (
            <dd className="text-lh-muted">{inquiry.phone}</dd>
          ) : null}
          {inquiry.instagram ? (
            <dd className="text-lh-muted">{inquiry.instagram}</dd>
          ) : null}
        </div>
        <div>
          <dt className={termClass}>Submitted</dt>
          <dd className="mt-1">
            {formatDateTime(inquiry.submittedAt, timezone)}
          </dd>
        </div>
      </dl>

      <InquiryContent inquiry={inquiry} />
    </article>
  );
}

function InquiryTable({
  inquiries,
  timezone,
}: {
  inquiries: AdminInquiryRow[];
  timezone: string;
}) {
  return (
    <div
      aria-label="Inquiry results"
      className="hidden overflow-x-auto rounded-2xl border border-lh-line bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary md:block"
      role="region"
      tabIndex={0}
    >
      <table className="min-w-[900px] w-full text-left text-sm">
        <caption className="sr-only">
          General and training inquiry submissions
        </caption>
        <thead className="bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted">
          <tr>
            <th className={cellClass} scope="col">
              Inquiry
            </th>
            <th className={cellClass} scope="col">
              Contact
            </th>
            <th className={cellClass} scope="col">
              Submitted
            </th>
            <th className={cellClass} scope="col">
              Consent
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-lh-line">
          {inquiries.map((inquiry) => (
            <tr key={inquiry.id}>
              <th className={cellClass} scope="row">
                <p className="font-semibold">{inquiry.content.subject}</p>
                <p className="mt-1 text-xs font-normal text-lh-muted">
                  {inquiry.typeLabel}
                </p>
                <InquiryContent inquiry={inquiry} />
              </th>
              <td className={cellClass}>
                <p className="font-semibold">{inquiry.name}</p>
                {inquiry.email ? (
                  <p className="max-w-64 break-all text-xs text-lh-muted">
                    {inquiry.email}
                  </p>
                ) : null}
                {inquiry.phone ? (
                  <p className="text-xs text-lh-muted">{inquiry.phone}</p>
                ) : null}
                {inquiry.instagram ? (
                  <p className="text-xs text-lh-muted">{inquiry.instagram}</p>
                ) : null}
              </td>
              <td className={`${cellClass} whitespace-nowrap`}>
                {formatDateTime(inquiry.submittedAt, timezone)}
              </td>
              <td className={cellClass}>
                <StatusPill>{inquiry.consentLabel}</StatusPill>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InquiryContent({ inquiry }: { inquiry: AdminInquiryRow }) {
  if (inquiry.content.redacted) {
    return (
      <p className="mt-3 text-sm font-normal text-lh-muted">
        Inquiry content was removed under the data-retention policy.
      </p>
    );
  }

  if (
    inquiry.content.message === null &&
    inquiry.content.detailLines.length === 0
  ) {
    return (
      <p className="mt-3 text-sm font-normal text-lh-muted">
        No additional inquiry details were supplied.
      </p>
    );
  }

  return (
    <div className="mt-3 max-w-2xl space-y-2 text-sm font-normal text-lh-muted">
      {inquiry.content.message ? (
        <p className="whitespace-pre-wrap">{inquiry.content.message}</p>
      ) : null}
      {inquiry.content.messageTruncated ? (
        <p className="text-xs">
          The saved message is longer than the display limit.
        </p>
      ) : null}
      {inquiry.content.detailLines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

function formatDateTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(value);
}

function firstString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value[0]
      : undefined;
}

function parsePositivePage(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    return undefined;
  }

  const page = Number(value);
  return Number.isSafeInteger(page) ? page : undefined;
}

const termClass = "text-xs uppercase tracking-[0.12em] text-lh-muted";
const cellClass = "px-4 py-4 align-top";
