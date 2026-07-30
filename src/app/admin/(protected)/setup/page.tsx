import Link from "next/link";

import { AdminCard } from "@/components/admin/admin-card";
import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { StatusPill } from "@/components/admin/status-pill";
import { getSetupReadiness } from "@/lib/admin/operations-read";
import { canAdmin } from "@/lib/admin/permissions";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import { getSquareAttributionReadiness } from "@/lib/admin/square-team-attribution";
import { DEFAULT_BOOKING_MARKETING_OPT_IN_LABEL } from "@/lib/booking/operational-ui-settings";

import {
  setSquareAttributionRequirementAction,
  updateBookingSettingsAction,
} from "../actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminSetupPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    notice?: string | string[];
  }>;
}) {
  const feedback = await searchParams;
  const actor = await requireAdminPagePermission("setup:view");
  const [readiness, squareReadiness] = await Promise.all([
    getSetupReadiness(),
    getSquareAttributionReadiness(),
  ]);
  const canManage = canAdmin({
    action: "settings:manage",
    bookingProviderResourceIds: actor.bookingProviderResourceIds,
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  });
  const canManageSquare = canAdmin({
    action: "staff:manage",
    bookingProviderResourceIds: actor.bookingProviderResourceIds,
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  });
  const settings = readiness.settings ?? {
    bookingHorizonDays: 30,
    defaultBufferAfterMinutes: 15,
    defaultBufferBeforeMinutes: 15,
    intakeQuestions: [],
    marketingOptInLabel: DEFAULT_BOOKING_MARKETING_OPT_IN_LABEL,
    minimumLeadTimeHours: 24,
    requireSquareTeamAttribution: false,
    slotIntervalMinutes: 15,
    timezone: "America/Toronto",
  };

  return (
    <div className="space-y-8">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Launch control
        </p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em]">
          Booking readiness
        </h1>
        <p className="mt-3 max-w-3xl text-lh-muted">
          A provider is ready only when its operational profile, resource,
          offering, weekly schedule, and booking calendar are all active.
        </p>
      </header>

      <AdminActionFeedback error={feedback.error} notice={feedback.notice} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <AdminCard
          label="Ready providers"
          value={`${readiness.counts.readyProviders}/${readiness.counts.providers}`}
        />
        <AdminCard
          label="Active resources"
          value={readiness.counts.activeResources}
        />
        <AdminCard
          label="Active services"
          value={readiness.counts.activeServices}
        />
        <AdminCard
          label="Active offerings"
          value={readiness.counts.activeOfferings}
        />
        <AdminCard
          label="Settings"
          value={
            <StatusPill tone={readiness.settings ? "success" : "attention"}>
              {readiness.settings ? "Configured" : "Defaults only"}
            </StatusPill>
          }
        />
      </div>

      <section className="space-y-4">
        <h2 className="font-heading text-4xl uppercase tracking-[0.08em]">
          Provider checks
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {readiness.providerReadiness.map((provider) => (
            <article
              key={provider.id}
              className="rounded-2xl border border-lh-line bg-white p-5"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold">
                    {provider.displayName}
                  </h3>
                  <p className="mt-1 text-sm text-lh-muted">
                    {provider.resourceName}
                  </p>
                </div>
                <StatusPill tone={provider.ready ? "success" : "attention"}>
                  {provider.ready ? "Ready" : "Needs setup"}
                </StatusPill>
              </div>
              {provider.blockers.length > 0 ? (
                <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-lh-muted">
                  {provider.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-sm text-lh-muted">
                  Online booking dependencies are active.
                </p>
              )}
              {!provider.ready ? (
                <nav
                  aria-label={`Setup links for ${provider.displayName}`}
                  className="mt-4 flex flex-wrap gap-2 text-xs font-semibold"
                >
                  <Link className={setupLinkClass} href="/admin/staff">
                    Provider profile
                  </Link>
                  <Link className={setupLinkClass} href="/admin/offerings">
                    Services & offerings
                  </Link>
                  <Link className={setupLinkClass} href="/admin/schedules">
                    Weekly schedule
                  </Link>
                  <Link
                    className={setupLinkClass}
                    href="/admin/calendar-connections"
                  >
                    Booking calendar
                  </Link>
                </nav>
              ) : null}
            </article>
          ))}
          {readiness.providerReadiness.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-lh-line bg-white p-6 text-lh-muted">
              Add a provider resource from Staff & resources to begin setup.
            </p>
          ) : null}
        </div>
      </section>

      <section className="rounded-2xl border border-lh-line bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-heading text-4xl uppercase tracking-[0.08em]">
              Required Square attribution
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-lh-muted">
              When enabled, active offerings and new operational holds require a
              verified active Square team-member mapping. Existing historical
              transactions keep their immutable snapshots.
            </p>
          </div>
          <StatusPill tone={squareReadiness.required ? "success" : "neutral"}>
            {squareReadiness.required ? "Required" : "Migration-safe off"}
          </StatusPill>
        </div>
        <div className="mt-5 grid gap-3 lg:grid-cols-2">
          {squareReadiness.providers.map((provider) => (
            <div
              className="flex items-center justify-between gap-3 rounded-xl border border-lh-line p-3 text-sm"
              key={provider.providerId}
            >
              <div>
                <p className="font-semibold">{provider.displayName}</p>
                <p className="text-xs text-lh-muted">
                  {provider.squareTeamMemberDisplayLabel ?? "No Square mapping"}
                </p>
              </div>
              <StatusPill tone={provider.ready ? "success" : "attention"}>
                {provider.ready
                  ? "Verified"
                  : (provider.squareTeamMemberStatus ?? "Missing")}
              </StatusPill>
            </div>
          ))}
        </div>
        {canManageSquare ? (
          <form action={setSquareAttributionRequirementAction} className="mt-5">
            <input
              name="required"
              type="hidden"
              value={squareReadiness.required ? "false" : "true"}
            />
            <button
              className={
                squareReadiness.required ? setupLinkClass : primaryButtonClass
              }
              disabled={
                !squareReadiness.required &&
                squareReadiness.providers.some((provider) => !provider.ready)
              }
              type="submit"
            >
              {squareReadiness.required
                ? "Disable required attribution"
                : "Enable required attribution"}
            </button>
          </form>
        ) : null}
      </section>

      {canManage ? (
        <form
          action={updateBookingSettingsAction}
          className="rounded-2xl border border-lh-line bg-white p-6"
        >
          <h2 className="font-heading text-4xl uppercase tracking-[0.08em]">
            Business booking defaults
          </h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Timezone">
              <input
                className={inputClass}
                name="timezone"
                defaultValue={settings.timezone}
                required
              />
            </Field>
            <Field label="Booking horizon (days)">
              <input
                className={inputClass}
                name="bookingHorizonDays"
                type="number"
                min="1"
                defaultValue={settings.bookingHorizonDays}
                required
              />
            </Field>
            <Field label="Minimum lead time (hours)">
              <input
                className={inputClass}
                name="minimumLeadTimeHours"
                type="number"
                min="0"
                defaultValue={settings.minimumLeadTimeHours}
                required
              />
            </Field>
            <Field label="Slot interval (minutes)">
              <input
                className={inputClass}
                name="slotIntervalMinutes"
                type="number"
                min="1"
                defaultValue={settings.slotIntervalMinutes}
                required
              />
            </Field>
            <Field label="Default buffer before">
              <input
                className={inputClass}
                name="defaultBufferBeforeMinutes"
                type="number"
                min="0"
                defaultValue={settings.defaultBufferBeforeMinutes}
                required
              />
            </Field>
            <Field label="Default buffer after">
              <input
                className={inputClass}
                name="defaultBufferAfterMinutes"
                type="number"
                min="0"
                defaultValue={settings.defaultBufferAfterMinutes}
                required
              />
            </Field>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Field label="Client intake questions (JSON)">
              <textarea
                className={`${inputClass} min-h-52 font-mono`}
                name="intakeQuestions"
                defaultValue={JSON.stringify(settings.intakeQuestions, null, 2)}
                spellCheck={false}
                required
              />
              <span className="mt-2 block text-xs font-normal text-lh-muted">
                Use an array of objects with id, label, inputType, required, and
                options for select questions.
              </span>
            </Field>
            <Field label="Marketing opt-in label">
              <textarea
                className={`${inputClass} min-h-28`}
                name="marketingOptInLabel"
                defaultValue={settings.marketingOptInLabel}
                required
              />
            </Field>
          </div>
          <button
            className="mt-5 rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-white"
            type="submit"
          >
            Save defaults
          </button>
        </form>
      ) : null}
    </div>
  );
}

function Field({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <label className="block text-sm font-semibold">
      <span className="mb-2 block">{label}</span>
      {children}
    </label>
  );
}
const inputClass =
  "w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm";
const primaryButtonClass =
  "rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-white disabled:cursor-not-allowed disabled:opacity-50";
const setupLinkClass =
  "rounded-full border border-lh-line px-3 py-2 hover:bg-lh-neutral-2";
