import Link from "next/link";

import { AdminSubmitButton } from "@/components/admin/admin-submit-button";
import { StatusPill } from "@/components/admin/status-pill";
import { canAdmin } from "@/lib/admin/permissions";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import { getSquareAttributionReadiness } from "@/lib/admin/square-team-attribution";

import { setSquareAttributionRequirementAction } from "../actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminIntegrationsPage() {
  const actor = await requireAdminPagePermission("calendar-connections:view");
  const square = await getSquareAttributionReadiness();
  const canManageSquare = canAdmin({
    action: "staff:manage",
    bookingProviderResourceIds: actor.bookingProviderResourceIds,
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  });
  const missingSquareMappings = square.providers.filter(
    (provider) => !provider.ready,
  );

  return (
    <div className="space-y-8">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Settings
        </p>
        <h1 className="mt-2 font-heading text-4xl uppercase leading-none tracking-[0.08em] sm:text-5xl lg:text-6xl">
          Integrations
        </h1>
        <p className="mt-3 max-w-3xl text-lh-muted">
          Review the external services used for booking calendars and sales
          matching.
        </p>
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-2xl border border-lh-line bg-white p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">
                Google Calendar
              </h2>
              <p className="mt-2 text-sm text-lh-muted">
                Choose where new appointments are added and which calendars
                block busy time.
              </p>
            </div>
            <StatusPill>Calendar sync</StatusPill>
          </div>
          <Link
            className={`${linkClass} mt-5`}
            href="/admin/calendar-connections"
          >
            Manage calendar sync
          </Link>
        </section>

        <section className="rounded-2xl border border-lh-line bg-white p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">
                Square
              </h2>
              <p className="mt-2 text-sm text-lh-muted">
                Match bookable team members to Square so payments can be
                attributed consistently.
              </p>
            </div>
            <StatusPill
              tone={missingSquareMappings.length > 0 ? "attention" : "success"}
            >
              {missingSquareMappings.length > 0
                ? `${missingSquareMappings.length} need review`
                : "Ready"}
            </StatusPill>
          </div>

          {missingSquareMappings.length > 0 ? (
            <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-lh-muted">
              {missingSquareMappings.map((provider) => (
                <li key={provider.providerId}>
                  {provider.displayName} needs a verified Square match.
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-5 flex flex-wrap gap-3">
            <Link className={linkClass} href="/admin/staff?squareTeam=1">
              Review Square sales matching
            </Link>
            {canManageSquare ? (
              <form action={setSquareAttributionRequirementAction}>
                <input
                  name="required"
                  type="hidden"
                  value={square.required ? "false" : "true"}
                />
                <AdminSubmitButton
                  className={linkClass}
                  disabled={
                    !square.required && missingSquareMappings.length > 0
                  }
                  pendingLabel="Saving…"
                >
                  {square.required
                    ? "Make matching optional"
                    : "Require verified matching"}
                </AdminSubmitButton>
              </form>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

const linkClass =
  "inline-flex min-h-11 items-center rounded-full border border-lh-line px-4 py-2 text-sm font-semibold hover:bg-lh-neutral-2 disabled:cursor-not-allowed disabled:opacity-50";
