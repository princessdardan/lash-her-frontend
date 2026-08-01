import Link from "next/link";

import { StatusPill } from "@/components/admin/status-pill";
import { getSetupReadiness } from "@/lib/admin/operations-read";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminBookingHealthPage() {
  await requireAdminPagePermission("setup:view");
  const readiness = await getSetupReadiness();
  const providersWithProblems = readiness.providerReadiness.filter(
    (provider) => !provider.ready,
  );
  const generalProblems = [
    ...(readiness.settings
      ? []
      : [
          {
            description:
              "Booking defaults have not been saved for this business.",
            href: "/admin/booking-settings",
            label: "Booking settings need review",
          },
        ]),
    ...(readiness.counts.providers > 0
      ? []
      : [
          {
            description:
              "Add a bookable team member before services can be offered online.",
            href: "/admin/staff",
            label: "No bookable team members",
          },
        ]),
    ...(readiness.counts.activeServices > 0
      ? []
      : [
          {
            description:
              "At least one active service is required for online booking.",
            href: "/admin/offerings",
            label: "No active services",
          },
        ]),
    ...(readiness.counts.activeOfferings > 0
      ? []
      : [
          {
            description:
              "At least one service and team-member combination must be active.",
            href: "/admin/offerings",
            label: "No active bookable services",
          },
        ]),
  ];
  const issueCount = generalProblems.length + providersWithProblems.length;

  return (
    <div className="space-y-8">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Settings
        </p>
        <h1 className="mt-2 font-heading text-4xl uppercase leading-none tracking-[0.08em] sm:text-5xl lg:text-6xl">
          Booking health
        </h1>
        <p className="mt-3 max-w-3xl text-lh-muted">
          Issues here can prevent a service or team member from accepting online
          bookings.
        </p>
      </header>

      {issueCount === 0 ? (
        <section className="rounded-2xl border border-lh-primary-soft bg-white p-5">
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill tone="success">Ready</StatusPill>
            <p className="font-semibold">Nothing needs attention.</p>
          </div>
        </section>
      ) : (
        <section aria-labelledby="booking-health-issues">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2
              className="font-heading text-3xl uppercase tracking-[0.08em]"
              id="booking-health-issues"
            >
              {issueCount} {issueCount === 1 ? "issue" : "issues"}
            </h2>
            <StatusPill tone="attention">Action needed</StatusPill>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {generalProblems.map((problem) => (
              <IssueCard
                description={problem.description}
                href={problem.href}
                key={problem.label}
                title={problem.label}
              />
            ))}
            {providersWithProblems.map((provider) => (
              <article
                className="rounded-2xl border border-lh-line bg-white p-5"
                key={provider.id}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-semibold">
                      {provider.displayName}
                    </h3>
                    <p className="mt-1 text-sm text-lh-muted">
                      Online booking is unavailable for this team member.
                    </p>
                  </div>
                  <StatusPill tone="attention">Needs setup</StatusPill>
                </div>
                <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-lh-muted">
                  {provider.blockers.map((blocker) => (
                    <li key={blocker}>{presentBlocker(blocker)}</li>
                  ))}
                </ul>
                <nav
                  aria-label={`Fix booking setup for ${provider.displayName}`}
                  className="mt-4 flex flex-wrap gap-2 text-sm font-semibold"
                >
                  <Link className={fixLinkClass} href="/admin/staff">
                    Team
                  </Link>
                  <Link className={fixLinkClass} href="/admin/offerings">
                    Services &amp; pricing
                  </Link>
                  <Link className={fixLinkClass} href="/admin/schedules">
                    Availability
                  </Link>
                  <Link
                    className={fixLinkClass}
                    href="/admin/calendar-connections"
                  >
                    Calendar sync
                  </Link>
                </nav>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function IssueCard({
  description,
  href,
  title,
}: {
  description: string;
  href: string;
  title: string;
}) {
  return (
    <article className="rounded-2xl border border-lh-line bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="mt-2 text-sm text-lh-muted">{description}</p>
        </div>
        <StatusPill tone="attention">Needs review</StatusPill>
      </div>
      <Link className={`${fixLinkClass} mt-4`} href={href}>
        Review
      </Link>
    </article>
  );
}

function presentBlocker(blocker: string): string {
  const labels: Record<string, string> = {
    "No active service offering": "No active service is assigned.",
    "No active weekly schedule": "Regular hours have not been added.",
    "No active booking calendar": "No calendar is receiving new bookings.",
    "Primary resource is not active":
      "The bookable team-member record is not active.",
    "Provider display name is missing": "A client-facing name is missing.",
    "Provider is not active":
      "The team member is not active for online booking.",
    "Provider public slug is missing":
      "The public booking profile is incomplete.",
  };

  return (
    labels[blocker] ??
    (blocker.startsWith("No active offering")
      ? "The active service is missing client-facing details or required resources."
      : "This booking setup needs review.")
  );
}

const fixLinkClass =
  "inline-flex min-h-11 items-center rounded-full border border-lh-line px-4 py-2 hover:bg-lh-neutral-2";
