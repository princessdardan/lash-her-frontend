import Link from "next/link";

import { CampaignComposer } from "@/components/admin/marketing/campaign-composer";
import { AdminCard } from "@/components/admin/admin-card";
import { AdminTabLink } from "@/components/admin/admin-tab-link";
import { AdminTable } from "@/components/admin/admin-table";
import { StatusPill } from "@/components/admin/status-pill";
import {
  listAdminMarketingContacts,
  type AdminMarketingContactStatusFilter,
} from "@/lib/admin/operations-read";
import { getBusinessDateRange } from "@/lib/admin/business-time";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import { canAdmin } from "@/lib/admin/permissions";
import {
  countOptedInMarketingContacts,
  listCampaigns,
  type MarketingCampaign,
} from "@/lib/marketing-campaign/marketing-campaign-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type MarketingTab = "campaigns" | "contacts" | "delivery" | "overview";

export default async function AdminMarketingPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string | string[];
    page?: string | string[];
    q?: string | string[];
    source?: string | string[];
    status?: string | string[];
    tab?: string | string[];
    to?: string | string[];
  }>;
}) {
  const actor = await requireAdminPagePermission("marketing:view");
  const canSend = canAdmin({
    action: "marketing:send",
    bookingProviderResourceIds: actor.bookingProviderResourceIds,
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  });
  const params = await searchParams;
  const tab = normalizeTab(firstString(params.tab), canSend);

  if (tab === "campaigns") {
    const [optedInCount, campaigns] = await Promise.all([
      countOptedInMarketingContacts(),
      listCampaigns({ limit: 25 }),
    ]);

    return (
      <div className="space-y-8">
        <MarketingHeader />
        <MarketingTabsNav canSend={canSend} tab={tab} />
        <section className="space-y-6" aria-labelledby="campaigns-heading">
          <div>
            <h2 className="font-heading text-2xl uppercase tracking-[0.08em]">
              Send a marketing email
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-lh-muted">
              Write your email, send a test to yourself, then send it to your
              opted-in audience. Recipients who unsubscribe are removed
              automatically — you never need to manage the list by hand.
            </p>
          </div>
          <CampaignComposer optedInCount={optedInCount} />
          <CampaignHistory campaigns={campaigns} />
        </section>
      </div>
    );
  }

  const query = firstString(params.q) ?? "";
  const source = firstString(params.source) ?? "";
  const from = firstString(params.from) ?? "";
  const to = firstString(params.to) ?? "";
  const dateError = validateConsentRange(from, to);
  const requestedStatus = normalizeStatus(firstString(params.status));
  const status =
    tab === "delivery" && requestedStatus === "all"
      ? "delivery_issue"
      : requestedStatus;
  const data = await listAdminMarketingContacts({
    page: parsePage(firstString(params.page)),
    q: query,
    source,
    status,
    ...(dateError ? {} : { from, to }),
  });
  const showingFrom =
    data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const showingTo = Math.min(data.page * data.pageSize, data.total);

  return (
    <div className="space-y-8">
      <MarketingHeader />
      <MarketingTabsNav canSend={canSend} tab={tab} />

      {tab === "overview" ? (
        <section aria-labelledby="audience-overview">
          <h2 className="sr-only" id="audience-overview">
            Audience overview
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <AdminCard
              href="/admin/marketing?tab=contacts&status=opted_in"
              label="Current audience"
              value={data.overview.currentAudience}
            />
            <AdminCard
              href="/admin/analytics?tab=overview"
              label="List growth"
              value="View report"
              valueClassName="text-xl"
            >
              New opt-ins use the selected reporting period.
            </AdminCard>
            <AdminCard
              href="/admin/marketing?tab=contacts&status=unsubscribed"
              label="Unsubscribed"
              value={data.overview.unsubscribed}
            />
            <AdminCard
              href="/admin/marketing?tab=delivery"
              label="Delivery needs review"
              value={data.overview.deliveryIssues}
            />
          </div>
          <p className="mt-5 rounded-2xl border border-lh-line bg-white p-5 text-sm text-lh-muted">
            Contact details are retained for consent and suppression records.
            Delivery status reflects only each contact&apos;s newest sync job.
          </p>
        </section>
      ) : (
        <section className="space-y-5">
          <form
            className="grid gap-3 rounded-2xl border border-lh-line bg-white p-4 sm:grid-cols-2 xl:grid-cols-6"
            method="get"
          >
            <input name="tab" type="hidden" value={tab} />
            <Field className="xl:col-span-2" label="Search">
              <input
                className={inputClass}
                defaultValue={query}
                name="q"
                placeholder="Name or email"
                type="search"
              />
            </Field>
            <Field label="Audience status">
              <select
                className={inputClass}
                defaultValue={status}
                name="status"
              >
                <option value="all">All contacts</option>
                <option value="opted_in">Opted in</option>
                <option value="unsubscribed">Unsubscribed</option>
                <option value="delivery_issue">Delivery needs review</option>
              </select>
            </Field>
            <Field label="Source">
              <select
                className={inputClass}
                defaultValue={source}
                name="source"
              >
                <option value="">All sources</option>
                {data.sources.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="First opted in from">
              <input
                aria-describedby={
                  dateError ? "marketing-consent-date-error" : undefined
                }
                aria-invalid={dateError ? true : undefined}
                className={inputClass}
                defaultValue={from}
                name="from"
                type="date"
              />
            </Field>
            <Field label="First opted in to">
              <input
                aria-describedby={
                  dateError ? "marketing-consent-date-error" : undefined
                }
                aria-invalid={dateError ? true : undefined}
                className={inputClass}
                defaultValue={to}
                name="to"
                type="date"
              />
            </Field>
            {dateError ? (
              <p
                className="text-sm text-lh-accent sm:col-span-2 xl:col-span-6"
                id="marketing-consent-date-error"
                role="alert"
              >
                {dateError}
              </p>
            ) : null}
            <button
              className={`${buttonClass} self-end xl:col-start-6`}
              type="submit"
            >
              Apply filters
            </button>
          </form>

          {data.consentRange ? (
            <p className="rounded-2xl border border-lh-line bg-white p-4 text-sm text-lh-muted">
              Showing contacts whose first recorded opt-in was from{" "}
              {formatDate(data.consentRange.from)} to{" "}
              {formatDate(data.consentRange.to)}, including contacts who later
              unsubscribed.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p aria-live="polite" className="text-lh-muted">
              Showing {showingFrom}–{showingTo} of {data.total}
            </p>
            {query || source || status !== "all" || from || to ? (
              <Link
                className="font-semibold text-lh-primary underline"
                href={`/admin/marketing?tab=${tab}`}
              >
                Clear filters
              </Link>
            ) : null}
          </div>

          <div className="space-y-3 md:hidden">
            {data.rows.map((contact) => (
              <article
                className="rounded-2xl border border-lh-line bg-white p-5"
                key={contact.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-semibold">
                      {contact.name ?? "Unnamed contact"}
                    </h2>
                    <p className="mt-1 break-all text-sm text-lh-muted">
                      {contact.email}
                    </p>
                  </div>
                  <StatusPill
                    tone={contact.unsubscribedAt ? "attention" : "success"}
                  >
                    {contact.unsubscribedAt ? "Unsubscribed" : "Opted in"}
                  </StatusPill>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <ContactDetail label="Source" value={contact.sourceLabel} />
                  <ContactDetail
                    label="First opted in"
                    value={contact.firstConsentedAt.toLocaleDateString("en-CA")}
                  />
                  <ContactDetail
                    label="Latest sync"
                    value={syncLabel(contact)}
                  />
                </dl>
              </article>
            ))}
          </div>

          <div className="hidden md:block">
            <AdminTable caption="Marketing contacts and latest delivery state">
              <thead className={theadClass}>
                <tr>
                  <th className={cellClass} scope="col">
                    Contact
                  </th>
                  <th className={cellClass} scope="col">
                    Source
                  </th>
                  <th className={cellClass} scope="col">
                    First opted in
                  </th>
                  <th className={cellClass} scope="col">
                    Audience
                  </th>
                  <th className={cellClass} scope="col">
                    Latest sync
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-lh-line">
                {data.rows.map((contact) => (
                  <tr key={contact.id}>
                    <td className={cellClass}>
                      <p className="font-semibold">
                        {contact.name ?? "Unnamed contact"}
                      </p>
                      <p className="text-xs text-lh-muted">{contact.email}</p>
                    </td>
                    <td className={cellClass}>{contact.sourceLabel}</td>
                    <td className={cellClass}>
                      {contact.firstConsentedAt.toLocaleDateString("en-CA")}
                    </td>
                    <td className={cellClass}>
                      <StatusPill
                        tone={contact.unsubscribedAt ? "attention" : "success"}
                      >
                        {contact.unsubscribedAt ? "Unsubscribed" : "Opted in"}
                      </StatusPill>
                    </td>
                    <td className={cellClass}>
                      <span
                        className={
                          contact.syncIssue ? "text-lh-accent" : undefined
                        }
                      >
                        {syncLabel(contact)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          </div>

          {data.rows.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-lh-line bg-white p-6 text-lh-muted">
              No contacts match these filters.
            </p>
          ) : null}

          <Pagination
            page={data.page}
            pageCount={data.pageCount}
            query={{ from, q: query, source, status, tab, to }}
          />
        </section>
      )}
    </div>
  );
}

function syncLabel(
  contact: Awaited<
    ReturnType<typeof listAdminMarketingContacts>
  >["rows"][number],
) {
  if (contact.unsubscribedAt) return "Not active for delivery";
  return contact.latestSync?.label ?? "No sync record";
}

function Pagination({
  page,
  pageCount,
  query,
}: {
  page: number;
  pageCount: number;
  query: {
    from: string;
    q: string;
    source: string;
    status: AdminMarketingContactStatusFilter;
    tab: MarketingTab;
    to: string;
  };
}) {
  if (pageCount <= 1) return null;
  return (
    <nav
      aria-label="Marketing contact pages"
      className="flex items-center justify-between gap-3"
    >
      {page > 1 ? (
        <Link className={buttonClass} href={pageHref(page - 1, query)}>
          Previous
        </Link>
      ) : (
        <span />
      )}
      <span className="text-sm text-lh-muted">
        Page {page} of {pageCount}
      </span>
      {page < pageCount ? (
        <Link className={buttonClass} href={pageHref(page + 1, query)}>
          Next
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

function pageHref(
  page: number,
  query: {
    from: string;
    q: string;
    source: string;
    status: AdminMarketingContactStatusFilter;
    tab: MarketingTab;
    to: string;
  },
) {
  const params = new URLSearchParams({ page: String(page), tab: query.tab });
  if (query.q) params.set("q", query.q);
  if (query.from) params.set("from", query.from);
  if (query.source) params.set("source", query.source);
  if (query.status !== "all") params.set("status", query.status);
  if (query.to) params.set("to", query.to);
  return `/admin/marketing?${params.toString()}`;
}

function ContactDetail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.12em] text-lh-muted">
        {label}
      </dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}

function Field({
  children,
  className,
  label,
}: {
  children: React.ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <label className={`block text-sm font-semibold ${className ?? ""}`}>
      <span className="mb-2 block">{label}</span>
      {children}
    </label>
  );
}

function normalizeTab(
  value: string | undefined,
  canSend: boolean,
): MarketingTab {
  if (value === "campaigns") return canSend ? "campaigns" : "overview";
  return value === "contacts" || value === "delivery" ? value : "overview";
}

function MarketingHeader() {
  return (
    <header>
      <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
        Insights
      </p>
      <h1 className="mt-2 font-heading text-4xl uppercase leading-none tracking-[0.08em] sm:text-5xl lg:text-6xl">
        Marketing audience
      </h1>
      <p className="mt-3 max-w-3xl text-lh-muted">
        Review people who opted in, unsubscribe records, and the latest verified
        delivery-sync state.
      </p>
    </header>
  );
}

function MarketingTabsNav({
  canSend,
  tab,
}: {
  canSend: boolean;
  tab: MarketingTab;
}) {
  const tabs: [MarketingTab, string][] = [["overview", "Overview"]];
  if (canSend) tabs.push(["campaigns", "Campaigns"]);
  tabs.push(["contacts", "Contacts"], ["delivery", "Delivery sync — Advanced"]);

  return (
    <nav
      aria-label="Marketing audience sections"
      className="flex flex-wrap gap-2"
    >
      {tabs.map(([value, label]) => (
        <AdminTabLink
          active={tab === value}
          href={`/admin/marketing?tab=${value}`}
          key={value}
        >
          {label}
        </AdminTabLink>
      ))}
    </nav>
  );
}

function CampaignHistory({ campaigns }: { campaigns: MarketingCampaign[] }) {
  if (campaigns.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-lh-line bg-white p-6 text-sm text-lh-muted">
        No campaigns yet. Your sent and scheduled emails will appear here.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="font-heading text-lg uppercase tracking-[0.08em]">
        Recent campaigns
      </h3>

      <div className="space-y-3 md:hidden">
        {campaigns.map((campaign) => (
          <article
            className="rounded-2xl border border-lh-line bg-white p-4"
            key={campaign.id}
          >
            <div className="flex items-start justify-between gap-3">
              <h4 className="min-w-0 font-semibold">{campaign.subject}</h4>
              <StatusPill tone={campaignTone(campaign.status)}>
                {campaignStatusLabel(campaign.status)}
              </StatusPill>
            </div>
            <p className="mt-2 text-xs text-lh-muted">
              {formatCampaignTime(campaign)} ·{" "}
              {campaign.recipientCountEstimate ?? "—"} recipients
            </p>
          </article>
        ))}
      </div>

      <div className="hidden md:block">
        <AdminTable caption="Recent marketing campaigns">
          <thead className={theadClass}>
            <tr>
              <th className={cellClass} scope="col">
                Subject
              </th>
              <th className={cellClass} scope="col">
                Status
              </th>
              <th className={cellClass} scope="col">
                Recipients
              </th>
              <th className={cellClass} scope="col">
                Sent / scheduled
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-lh-line">
            {campaigns.map((campaign) => (
              <tr key={campaign.id}>
                <td className={cellClass}>{campaign.subject}</td>
                <td className={cellClass}>
                  <StatusPill tone={campaignTone(campaign.status)}>
                    {campaignStatusLabel(campaign.status)}
                  </StatusPill>
                </td>
                <td className={cellClass}>
                  {campaign.recipientCountEstimate ?? "—"}
                </td>
                <td className={cellClass}>{formatCampaignTime(campaign)}</td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      </div>
    </div>
  );
}

function campaignStatusLabel(status: MarketingCampaign["status"]): string {
  const labels: Record<MarketingCampaign["status"], string> = {
    draft: "Draft",
    scheduled: "Scheduled",
    sending: "Sending",
    sent: "Sent",
    failed: "Failed",
    canceled: "Canceled",
  };
  return labels[status];
}

function campaignTone(
  status: MarketingCampaign["status"],
): "attention" | "neutral" | "success" {
  if (status === "sent") return "success";
  if (status === "scheduled" || status === "sending" || status === "failed") {
    return "attention";
  }
  return "neutral";
}

function formatCampaignTime(campaign: MarketingCampaign): string {
  const when = campaign.sentAt ?? campaign.scheduledAt;
  if (!when) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(when);
}

function normalizeStatus(
  value: string | undefined,
): AdminMarketingContactStatusFilter {
  return value === "delivery_issue" ||
    value === "opted_in" ||
    value === "unsubscribed"
    ? value
    : "all";
}

function parsePage(value: string | undefined) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function validateConsentRange(from: string, to: string): string | null {
  if (!from && !to) return null;
  if (!from || !to) return "Choose both a start and end date.";

  try {
    getBusinessDateRange(from, to, "UTC");
    return null;
  } catch {
    return "Use valid dates with the start on or before the end.";
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function firstString(value: string | string[] | undefined) {
  return typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value[0]
      : undefined;
}

const inputClass =
  "min-h-11 w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm";
const buttonClass =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-lh-line px-4 py-2 text-sm font-semibold hover:bg-lh-neutral-2";
const theadClass =
  "bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted";
const cellClass = "px-4 py-3 align-top";
