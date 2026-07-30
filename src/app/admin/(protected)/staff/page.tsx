import Link from "next/link";

import { AdminTable } from "@/components/admin/admin-table";
import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { AdminSubmitButton } from "@/components/admin/admin-submit-button";
import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";
import { StatusPill } from "@/components/admin/status-pill";
import { canAdmin } from "@/lib/admin/permissions";
import {
  getAdminRoleLabel,
  getAdminUserStatusPresentation,
  getBookingConfigurationStatusPresentation,
  getBookingResourceKindLabel,
  getSquareMappingStatusPresentation,
  getTimezoneLabel,
} from "@/lib/admin/presentation";
import { listAdminStaffAndResources } from "@/lib/admin/operations-read";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import {
  createCurrentSquareTeamMemberSelectionOption,
  listSquareTeamMemberOptions,
} from "@/lib/admin/square-team-attribution";

import {
  assignStaffResourceAction,
  createBookingResourceAction,
  createStaffUserAction,
  refreshSquareTeamMappingsAction,
  setBookingResourceStatusAction,
  setStaffStatusAction,
  setProviderSquareTeamMemberAction,
  unassignStaffResourceAction,
  updateBookingResourceProfileAction,
} from "../actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type TeamTab = "people" | "resources" | "square";

export default async function AdminStaffPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    notice?: string | string[];
    squareTeam?: string | string[];
    tab?: string | string[];
  }>;
}) {
  const feedback = await searchParams;
  const tab = normalizeTab(
    firstString(feedback.tab),
    firstString(feedback.squareTeam),
  );
  const actor = await requireAdminPagePermission("staff:view");
  const data = await listAdminStaffAndResources();
  const canManage = canAdmin({
    action: "staff:manage",
    bookingProviderResourceIds: actor.bookingProviderResourceIds,
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  });
  let squareTeamMembers: Awaited<
    ReturnType<typeof listSquareTeamMemberOptions>
  > = [];
  let squareTeamDiscoveryError: string | null = null;
  if (canManage && tab === "square") {
    try {
      squareTeamMembers = await listSquareTeamMemberOptions();
    } catch {
      squareTeamDiscoveryError =
        "Square team members could not be loaded. Existing matches were preserved.";
    }
  }
  const resourceById = new Map(
    data.resources.map((resource) => [resource.id, resource]),
  );
  const providerByResourceId = new Map(
    data.providers.map((provider) => [provider.primaryResourceId, provider]),
  );

  return (
    <div className="space-y-8">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Manage business
        </p>
        <h1 className="mt-2 font-heading text-4xl uppercase leading-none tracking-[0.08em] sm:text-5xl lg:text-6xl">
          Team
        </h1>
        <p className="mt-3 max-w-3xl text-lh-muted">
          Manage who can access the admin and which people, rooms, or equipment
          they can work with.
        </p>
      </header>

      <AdminActionFeedback error={feedback.error} notice={feedback.notice} />

      <nav aria-label="Team sections" className="flex flex-wrap gap-2">
        {(
          [
            ["people", "People"],
            ["resources", "Bookable people, rooms & equipment"],
            ["square", "Square sales matching"],
          ] as const
        ).map(([value, label]) => (
          <Link
            aria-current={tab === value ? "page" : undefined}
            className={
              tab === value
                ? `${tabClass} border-lh-primary bg-lh-primary text-white`
                : tabClass
            }
            href={`/admin/staff?tab=${value}`}
            key={value}
          >
            {label}
          </Link>
        ))}
      </nav>

      {tab === "square" && canManage ? (
        <section className="rounded-2xl border border-lh-line bg-white p-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-heading text-4xl uppercase tracking-[0.08em]">
                Square sales matching
              </h2>
              <p className="mt-2 max-w-3xl text-sm text-lh-muted">
                Match each bookable team member to the person who receives
                credit for their sales in Square.
              </p>
            </div>
            <form action={refreshSquareTeamMappingsAction}>
              <AdminSubmitButton
                className={secondaryButtonClass}
                pendingLabel="Refreshing…"
              >
                Refresh Square team members
              </AdminSubmitButton>
            </form>
          </div>
          {squareTeamDiscoveryError ? (
            <p className="mt-4 text-sm text-red-700">
              {squareTeamDiscoveryError}
            </p>
          ) : null}
          {data.providers.length === 0 ? (
            <p className="mt-5 rounded-xl border border-lh-line p-4 text-sm text-lh-muted">
              No bookable team members are available for Square sales matching.
            </p>
          ) : (
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              {data.providers.map((provider) => {
                const options = [...squareTeamMembers];
                const currentOption = provider.squareTeamMemberId
                  ? createCurrentSquareTeamMemberSelectionOption({
                      displayLabel:
                        provider.squareTeamMemberDisplayLabel ??
                        "Previously matched Square team member",
                      id: provider.squareTeamMemberId,
                      status: provider.squareTeamMemberStatus ?? "missing",
                    })
                  : null;
                if (
                  currentOption &&
                  !options.some(
                    (member) =>
                      member.selectionHandle === currentOption.selectionHandle,
                  )
                ) {
                  options.push(currentOption);
                }
                const mappingStatus = provider.squareTeamMemberStatus
                  ? getSquareMappingStatusPresentation(
                      provider.squareTeamMemberStatus,
                    )
                  : { label: "No match", tone: "neutral" as const };
                return (
                  <form
                    action={setProviderSquareTeamMemberAction}
                    className="rounded-xl border border-lh-line p-4"
                    key={provider.id}
                  >
                    <input
                      name="providerId"
                      type="hidden"
                      value={provider.id}
                    />
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold">
                          {provider.displayName}
                        </h3>
                        <p className="mt-1 text-xs text-lh-muted">
                          {provider.squareTeamMemberDisplayLabel ?? "No match"}
                        </p>
                      </div>
                      <StatusPill tone={mappingStatus.tone}>
                        {mappingStatus.label}
                      </StatusPill>
                    </div>
                    <div className="mt-4 flex gap-2">
                      {provider.squareTeamMemberId !== null &&
                      currentOption === null ? (
                        <>
                          <input
                            name="squareTeamMemberSelectionHandle"
                            type="hidden"
                            value=""
                          />
                          <ConfirmSubmitButton
                            className={secondaryButtonClass}
                            confirmation="Remove this Square sales match? Active services may need to be disabled first."
                          >
                            Remove match
                          </ConfirmSubmitButton>
                        </>
                      ) : (
                        <>
                          <select
                            className={inputClass}
                            defaultValue={currentOption?.selectionHandle ?? ""}
                            name="squareTeamMemberSelectionHandle"
                          >
                            <option value="">No Square match</option>
                            {options.map((member) => (
                              <option
                                key={member.selectionHandle}
                                value={member.selectionHandle}
                              >
                                {member.displayLabel}
                              </option>
                            ))}
                          </select>
                          <ConfirmSubmitButton
                            className={secondaryButtonClass}
                            confirmation="Save and verify this Square sales match?"
                          >
                            Save match
                          </ConfirmSubmitButton>
                        </>
                      )}
                    </div>
                    {provider.squareTeamMemberId !== null &&
                    currentOption === null ? (
                      <p className="mt-2 text-xs text-red-700">
                        Square service booking is disabled. This match can only
                        be removed until Square is enabled again.
                      </p>
                    ) : null}
                    <p className="mt-2 text-xs text-lh-muted">
                      Last verified:{" "}
                      {provider.squareTeamMemberVerifiedAt
                        ? provider.squareTeamMemberVerifiedAt.toLocaleString(
                            "en-CA",
                          )
                        : "Never"}
                    </p>
                  </form>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {tab === "square" && !canManage ? (
        <section className="rounded-2xl border border-lh-line bg-white p-6">
          <h2 className="font-heading text-4xl uppercase tracking-[0.08em]">
            Square sales matching
          </h2>
          <p className="mt-2 max-w-3xl text-sm text-lh-muted">
            Only the business owner can change which Square team member receives
            credit for a provider&apos;s sales.
          </p>
        </section>
      ) : null}

      {tab === "people" ? (
        <>
          <section className="rounded-2xl border border-lh-line bg-lh-neutral-2 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-[0.12em]">
              Access levels
            </h2>
            <dl className="mt-3 grid gap-4 text-sm md:grid-cols-3">
              <div>
                <dt className="font-semibold">Owner</dt>
                <dd className="mt-1 text-lh-muted">
                  Full access, including team accounts, business settings, and
                  financial reports.
                </dd>
              </div>
              <div>
                <dt className="font-semibold">Administrator</dt>
                <dd className="mt-1 text-lh-muted">
                  Manages appointments, services, and availability and can view
                  reports, but cannot change team access.
                </dd>
              </div>
              <div>
                <dt className="font-semibold">Contractor</dt>
                <dd className="mt-1 text-lh-muted">
                  Works only with assigned people, rooms, or equipment and their
                  related appointments and availability.
                </dd>
              </div>
            </dl>
          </section>

          <section className="space-y-4">
            <h2 className="font-heading text-4xl uppercase tracking-[0.08em]">
              People
            </h2>
            <AdminTable caption="Team accounts">
              <thead className={theadClass}>
                <tr>
                  <th scope="col" className={cellClass}>
                    Staff
                  </th>
                  <th scope="col" className={cellClass}>
                    Access level
                  </th>
                  <th scope="col" className={cellClass}>
                    Assigned resources
                  </th>
                  <th scope="col" className={cellClass}>
                    Status
                  </th>
                  <th scope="col" className={cellClass}>
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-lh-line">
                {data.users.length === 0 ? (
                  <tr>
                    <td className={cellClass} colSpan={5}>
                      No team accounts have been added.
                    </td>
                  </tr>
                ) : (
                  data.users.map((user) => {
                    const assignments = data.assignments.filter(
                      (row) => row.adminUserId === user.id,
                    );
                    const userStatus = getAdminUserStatusPresentation(
                      user.status,
                    );
                    return (
                      <tr key={user.id}>
                        <td className={cellClass}>
                          <p className="font-semibold">
                            {user.displayName ?? "Unnamed staff"}
                          </p>
                          <p className="text-xs text-lh-muted">{user.email}</p>
                        </td>
                        <td className={cellClass}>
                          {getAdminRoleLabel(user.role)}
                        </td>
                        <td className={cellClass}>
                          <div className="flex flex-wrap gap-2">
                            {assignments.length === 0 ? (
                              <span className="text-lh-muted">None</span>
                            ) : (
                              assignments.map((assignment) => (
                                <span
                                  key={assignment.bookingResourceId}
                                  className="inline-flex items-center gap-2 rounded-full border border-lh-line px-3 py-1 text-xs"
                                >
                                  {resourceById.get(
                                    assignment.bookingResourceId,
                                  )?.name ?? "Unknown"}
                                  {canManage ? (
                                    <form action={unassignStaffResourceAction}>
                                      <input
                                        type="hidden"
                                        name="userId"
                                        value={user.id}
                                      />
                                      <input
                                        type="hidden"
                                        name="resourceId"
                                        value={assignment.bookingResourceId}
                                      />
                                      <ConfirmSubmitButton
                                        ariaLabel="Remove resource assignment"
                                        confirmation={`Remove ${resourceById.get(assignment.bookingResourceId)?.name ?? "this resource"} from ${user.displayName ?? user.email}?`}
                                      >
                                        ×
                                      </ConfirmSubmitButton>
                                    </form>
                                  ) : null}
                                </span>
                              ))
                            )}
                          </div>
                          {canManage && data.resources.length > 0 ? (
                            <form
                              action={assignStaffResourceAction}
                              className="mt-3 flex gap-2"
                            >
                              <input
                                type="hidden"
                                name="userId"
                                value={user.id}
                              />
                              <select
                                className={`${inputClass} min-w-40`}
                                name="resourceId"
                              >
                                {data.resources.map((resource) => (
                                  <option key={resource.id} value={resource.id}>
                                    {resource.name}
                                  </option>
                                ))}
                              </select>
                              <AdminSubmitButton
                                className={secondaryButtonClass}
                                pendingLabel="Assigning…"
                              >
                                Assign
                              </AdminSubmitButton>
                            </form>
                          ) : null}
                        </td>
                        <td className={cellClass}>
                          <StatusPill tone={userStatus.tone}>
                            {userStatus.label}
                          </StatusPill>
                        </td>
                        <td className={cellClass}>
                          {canManage ? (
                            <form action={setStaffStatusAction}>
                              <input
                                type="hidden"
                                name="userId"
                                value={user.id}
                              />
                              <input
                                type="hidden"
                                name="status"
                                value={
                                  user.status === "active"
                                    ? "disabled"
                                    : "active"
                                }
                              />
                              <ConfirmSubmitButton
                                className={secondaryButtonClass}
                                confirmation={
                                  user.status === "active"
                                    ? `Disable access for ${user.displayName ?? user.email}? They will be signed out and unable to view assigned work.`
                                    : `Activate access for ${user.displayName ?? user.email}?`
                                }
                              >
                                {user.status === "active"
                                  ? "Disable"
                                  : "Activate"}
                              </ConfirmSubmitButton>
                            </form>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </AdminTable>
          </section>

          {canManage ? (
            <details className={createDetailsClass}>
              <summary className={createSummaryClass}>Add staff member</summary>
              <form action={createStaffUserAction} className="mt-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Name">
                    <input
                      className={inputClass}
                      name="displayName"
                      maxLength={120}
                    />
                  </Field>
                  <Field label="Email">
                    <input
                      className={inputClass}
                      name="email"
                      type="email"
                      required
                    />
                  </Field>
                  <Field label="Access level">
                    <select
                      className={inputClass}
                      name="role"
                      defaultValue="employee"
                    >
                      <option value="employee">Contractor</option>
                      <option value="admin">Administrator</option>
                    </select>
                  </Field>
                </div>
                <AdminSubmitButton
                  className={primaryButtonClass}
                  pendingLabel="Adding staff member…"
                >
                  Add staff member
                </AdminSubmitButton>
              </form>
            </details>
          ) : null}
        </>
      ) : null}

      {tab === "resources" ? (
        <>
          <section className="space-y-4">
            <div>
              <h2 className="font-heading text-4xl uppercase tracking-[0.08em]">
                Bookable people, rooms &amp; equipment
              </h2>
              <p className="mt-2 max-w-3xl text-sm text-lh-muted">
                Bookable team members provide services. Rooms and equipment can
                be reserved with them when a service requires those resources.
              </p>
            </div>
            {data.resources.length === 0 ? (
              <p className="rounded-2xl border border-lh-line bg-white p-5 text-sm text-lh-muted">
                No bookable people, rooms, or equipment have been added.
              </p>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {data.resources.map((resource) => {
                  const provider = providerByResourceId.get(resource.id);
                  const resourceStatus =
                    getBookingConfigurationStatusPresentation(resource.status);
                  return (
                    <article
                      key={resource.id}
                      className="rounded-2xl border border-lh-line bg-white p-5"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h3 className="text-lg font-semibold">
                            {resource.name}
                          </h3>
                          <p className="mt-1 text-sm text-lh-muted">
                            {getBookingResourceKindLabel(resource.kind)}
                          </p>
                        </div>
                        <StatusPill tone={resourceStatus.tone}>
                          {resourceStatus.label}
                        </StatusPill>
                      </div>
                      {canManage ? (
                        <form
                          action={updateBookingResourceProfileAction}
                          className="mt-5"
                        >
                          <input
                            type="hidden"
                            name="resourceId"
                            value={resource.id}
                          />
                          <Field label="Display name">
                            <input
                              className={inputClass}
                              name="name"
                              defaultValue={resource.name}
                              required
                              maxLength={120}
                            />
                          </Field>
                          <details className={advancedDetailsClass}>
                            <summary className={advancedSummaryClass}>
                              Advanced
                            </summary>
                            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                              <div className="rounded-xl bg-lh-neutral-2 p-3 text-sm">
                                <span className="block text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted">
                                  Resource key
                                </span>
                                <span className="mt-1 block break-all">
                                  {resource.resourceKey}
                                </span>
                              </div>
                              <Field label="Timezone identifier">
                                <input
                                  className={inputClass}
                                  name="timezone"
                                  defaultValue={resource.timezone}
                                  required
                                />
                              </Field>
                              {resource.kind === "provider" ? (
                                <>
                                  <Field label="Public provider slug">
                                    <input
                                      className={inputClass}
                                      name="providerPublicSlug"
                                      defaultValue={provider?.publicSlug ?? ""}
                                    />
                                  </Field>
                                  <Field label="Website content provider ID">
                                    <input
                                      className={inputClass}
                                      name="providerSanityDocumentId"
                                      defaultValue={
                                        provider?.sanityDocumentId ?? ""
                                      }
                                    />
                                  </Field>
                                </>
                              ) : null}
                            </div>
                            <p className="mt-3 text-xs text-lh-muted">
                              Times are shown to staff as{" "}
                              {getTimezoneLabel(resource.timezone)}.
                            </p>
                          </details>
                          <AdminSubmitButton
                            className={`${secondaryButtonClass} mt-4`}
                            pendingLabel="Saving…"
                          >
                            Save profile
                          </AdminSubmitButton>
                        </form>
                      ) : (
                        <details className={advancedDetailsClass}>
                          <summary className={advancedSummaryClass}>
                            Advanced
                          </summary>
                          <dl className="mt-4 grid gap-3 text-sm">
                            <div>
                              <dt className="font-semibold text-lh-muted">
                                Resource key
                              </dt>
                              <dd className="break-all">
                                {resource.resourceKey}
                              </dd>
                            </div>
                            <div>
                              <dt className="font-semibold text-lh-muted">
                                Timezone identifier
                              </dt>
                              <dd className="break-all">{resource.timezone}</dd>
                            </div>
                            {provider?.sanityDocumentId ? (
                              <div>
                                <dt className="font-semibold text-lh-muted">
                                  Website content provider ID
                                </dt>
                                <dd className="break-all">
                                  {provider.sanityDocumentId}
                                </dd>
                              </div>
                            ) : null}
                          </dl>
                        </details>
                      )}
                      {canManage ? (
                        <form
                          action={setBookingResourceStatusAction}
                          className="mt-4 flex gap-2"
                        >
                          <input
                            type="hidden"
                            name="resourceId"
                            value={resource.id}
                          />
                          <select
                            className={inputClass}
                            name="status"
                            defaultValue={
                              resource.status === "archived"
                                ? "disabled"
                                : resource.status
                            }
                          >
                            <option value="draft">Draft</option>
                            <option value="active">Active</option>
                            <option value="disabled">Disabled</option>
                          </select>
                          <ConfirmSubmitButton
                            className={secondaryButtonClass}
                            confirmation={`Save the status change for ${resource.name}? Disabling it can stop services that require this resource from being booked online.`}
                          >
                            Save status
                          </ConfirmSubmitButton>
                        </form>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {canManage ? (
            <details className={createDetailsClass}>
              <summary className={createSummaryClass}>
                Add person, room or equipment
              </summary>
              <form action={createBookingResourceAction} className="mt-5">
                <p className="text-sm text-lh-muted">
                  New resources start as drafts and are not available for online
                  booking until their setup is complete.
                </p>
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <Field label="Name">
                    <input
                      className={inputClass}
                      name="name"
                      required
                      maxLength={120}
                    />
                  </Field>
                  <Field label="Resource type">
                    <select
                      className={inputClass}
                      name="kind"
                      defaultValue="provider"
                    >
                      <option value="provider">Bookable team member</option>
                      <option value="room">Room</option>
                      <option value="equipment">Equipment</option>
                    </select>
                  </Field>
                </div>
                <details className={advancedDetailsClass}>
                  <summary className={advancedSummaryClass}>Advanced</summary>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <Field label="Resource key">
                      <input
                        className={inputClass}
                        name="resourceKey"
                        required
                        pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                        placeholder="nataliea"
                      />
                    </Field>
                    <Field label="Timezone identifier">
                      <input
                        className={inputClass}
                        name="timezone"
                        defaultValue="America/Toronto"
                        required
                      />
                    </Field>
                    <Field label="Public provider slug">
                      <input className={inputClass} name="publicSlug" />
                    </Field>
                    <Field label="Website content provider ID">
                      <input className={inputClass} name="sanityDocumentId" />
                    </Field>
                  </div>
                </details>
                <AdminSubmitButton
                  className={primaryButtonClass}
                  pendingLabel="Adding resource…"
                >
                  Add as draft
                </AdminSubmitButton>
              </form>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeTab(
  requestedTab: string | undefined,
  legacySquareTeam: string | undefined,
): TeamTab {
  if (legacySquareTeam === "1") {
    return "square";
  }

  if (
    requestedTab === "people" ||
    requestedTab === "resources" ||
    requestedTab === "square"
  ) {
    return requestedTab;
  }

  return "people";
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
  "mt-5 rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-white disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButtonClass =
  "rounded-full border border-lh-line px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50";
const theadClass =
  "bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted";
const cellClass = "px-4 py-3 align-top";
const advancedDetailsClass =
  "mt-4 rounded-2xl border border-lh-line bg-lh-neutral-2 p-4";
const advancedSummaryClass =
  "min-h-11 cursor-pointer list-none py-2 text-sm font-semibold text-lh-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden";
const createDetailsClass = "rounded-2xl border border-lh-line bg-white p-6";
const createSummaryClass =
  "min-h-11 cursor-pointer list-none py-2 font-heading text-3xl uppercase tracking-[0.08em] text-lh-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden";
const tabClass =
  "inline-flex min-h-11 items-center rounded-full border border-lh-line px-4 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2";
