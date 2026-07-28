import { AdminTable } from "@/components/admin/admin-table";
import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";
import { StatusPill } from "@/components/admin/status-pill";
import { canAdmin } from "@/lib/admin/permissions";
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

export default async function AdminStaffPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    notice?: string | string[];
    squareTeam?: string | string[];
  }>;
}) {
  const feedback = await searchParams;
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
  if (canManage && feedback.squareTeam === "1") {
    try {
      squareTeamMembers = await listSquareTeamMemberOptions();
    } catch {
      squareTeamDiscoveryError =
        "Square team members could not be loaded. Existing mappings were preserved.";
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
          Team access
        </p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em]">
          Staff & resources
        </h1>
        <p className="mt-3 max-w-3xl text-lh-muted">
          Staff sign in with a verified Google identity. Roles, account status,
          and employee resource access are controlled here.
        </p>
      </header>

      <AdminActionFeedback error={feedback.error} notice={feedback.notice} />

      {canManage ? (
        <section className="rounded-2xl border border-lh-line bg-white p-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-heading text-4xl uppercase tracking-[0.08em]">
                Square team attribution
              </h2>
              <p className="mt-2 max-w-3xl text-sm text-lh-muted">
                Refresh on demand, then map each booking provider to one active
                Square team member. Mappings are revalidated with Square when
                saved.
              </p>
            </div>
            <form action={refreshSquareTeamMappingsAction}>
              <button className={secondaryButtonClass} type="submit">
                Refresh Square team members
              </button>
            </form>
          </div>
          {squareTeamDiscoveryError ? (
            <p className="mt-4 text-sm text-red-700">
              {squareTeamDiscoveryError}
            </p>
          ) : null}
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            {data.providers.map((provider) => {
              const options = [...squareTeamMembers];
              const currentOption = provider.squareTeamMemberId
                ? createCurrentSquareTeamMemberSelectionOption({
                    displayLabel:
                      provider.squareTeamMemberDisplayLabel ??
                      "Previously mapped Square team member",
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
              return (
                <form
                  action={setProviderSquareTeamMemberAction}
                  className="rounded-xl border border-lh-line p-4"
                  key={provider.id}
                >
                  <input name="providerId" type="hidden" value={provider.id} />
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">{provider.displayName}</h3>
                      <p className="mt-1 text-xs text-lh-muted">
                        {provider.squareTeamMemberDisplayLabel ?? "Not mapped"}
                      </p>
                    </div>
                    <StatusPill
                      tone={
                        provider.squareTeamMemberStatus === "active"
                          ? "success"
                          : provider.squareTeamMemberStatus
                            ? "attention"
                            : "neutral"
                      }
                    >
                      {provider.squareTeamMemberStatus ?? "unmapped"}
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
                          confirmation="Remove this Square team-member mapping? Active offerings may need to be disabled first."
                        >
                          Remove mapping
                        </ConfirmSubmitButton>
                      </>
                    ) : (
                      <>
                        <select
                          className={inputClass}
                          defaultValue={currentOption?.selectionHandle ?? ""}
                          name="squareTeamMemberSelectionHandle"
                        >
                          <option value="">No Square mapping</option>
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
                          confirmation="Save and revalidate this Square team-member mapping?"
                        >
                          Save mapping
                        </ConfirmSubmitButton>
                      </>
                    )}
                  </div>
                  {provider.squareTeamMemberId !== null &&
                  currentOption === null ? (
                    <p className="mt-2 text-xs text-red-700">
                      Square service booking is disabled. This mapping can only
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
        </section>
      ) : null}

      {canManage ? (
        <div className="grid gap-6 xl:grid-cols-2">
          <form
            action={createStaffUserAction}
            className="rounded-2xl border border-lh-line bg-white p-6"
          >
            <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">
              Add staff member
            </h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
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
              <Field label="Role">
                <select
                  className={inputClass}
                  name="role"
                  defaultValue="employee"
                >
                  <option value="employee">Employee</option>
                  <option value="admin">Administrator</option>
                </select>
              </Field>
            </div>
            <SubmitButton>Add staff member</SubmitButton>
          </form>

          <form
            action={createBookingResourceAction}
            className="rounded-2xl border border-lh-line bg-white p-6"
          >
            <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">
              Add booking resource
            </h2>
            <p className="mt-2 text-sm text-lh-muted">
              Provider resources also create the operational provider record
              used by offerings.
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
              <Field label="Key">
                <input
                  className={inputClass}
                  name="resourceKey"
                  required
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  placeholder="nataliea"
                />
              </Field>
              <Field label="Kind">
                <select
                  className={inputClass}
                  name="kind"
                  defaultValue="provider"
                >
                  <option value="provider">Provider</option>
                  <option value="room">Room</option>
                  <option value="equipment">Equipment</option>
                </select>
              </Field>
              <Field label="Timezone">
                <input
                  className={inputClass}
                  name="timezone"
                  defaultValue="America/Toronto"
                  required
                />
              </Field>
              <Field label="Public slug (provider)">
                <input className={inputClass} name="publicSlug" />
              </Field>
              <Field label="Sanity document ID (provider)">
                <input className={inputClass} name="sanityDocumentId" />
              </Field>
            </div>
            <SubmitButton>Add as draft</SubmitButton>
          </form>
        </div>
      ) : null}

      <section className="space-y-4">
        <h2 className="font-heading text-4xl uppercase tracking-[0.08em]">
          Staff
        </h2>
        <AdminTable caption="Administrative staff accounts">
          <thead className={theadClass}>
            <tr>
              <th className={cellClass}>Staff</th>
              <th className={cellClass}>Role</th>
              <th className={cellClass}>Resources</th>
              <th className={cellClass}>Status</th>
              <th className={cellClass}>Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-lh-line">
            {data.users.map((user) => {
              const assignments = data.assignments.filter(
                (row) => row.adminUserId === user.id,
              );
              return (
                <tr key={user.id}>
                  <td className={cellClass}>
                    <p className="font-semibold">
                      {user.displayName ?? "Unnamed staff"}
                    </p>
                    <p className="text-xs text-lh-muted">{user.email}</p>
                  </td>
                  <td className={cellClass}>{user.role}</td>
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
                            {resourceById.get(assignment.bookingResourceId)
                              ?.name ?? "Unknown"}
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
                                  confirmation="Remove this resource assignment from the staff member?"
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
                        <input type="hidden" name="userId" value={user.id} />
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
                        <button className={secondaryButtonClass} type="submit">
                          Assign
                        </button>
                      </form>
                    ) : null}
                  </td>
                  <td className={cellClass}>
                    <StatusPill
                      tone={user.status === "active" ? "success" : "attention"}
                    >
                      {user.status}
                    </StatusPill>
                  </td>
                  <td className={cellClass}>
                    {canManage ? (
                      <form action={setStaffStatusAction}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input
                          type="hidden"
                          name="status"
                          value={
                            user.status === "active" ? "disabled" : "active"
                          }
                        />
                        <ConfirmSubmitButton
                          className={secondaryButtonClass}
                          confirmation={
                            user.status === "active"
                              ? "Disable this staff account?"
                              : "Activate this staff account?"
                          }
                        >
                          {user.status === "active" ? "Disable" : "Activate"}
                        </ConfirmSubmitButton>
                      </form>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </AdminTable>
      </section>

      <section className="space-y-4">
        <h2 className="font-heading text-4xl uppercase tracking-[0.08em]">
          Booking resources
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {data.resources.map((resource) => {
            const provider = providerByResourceId.get(resource.id);
            return (
              <article
                key={resource.id}
                className="rounded-2xl border border-lh-line bg-white p-5"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-semibold">{resource.name}</h3>
                    <p className="mt-1 text-sm text-lh-muted">
                      {resource.kind} · {resource.resourceKey} ·{" "}
                      {resource.timezone}
                    </p>
                  </div>
                  <StatusPill
                    tone={resource.status === "active" ? "success" : "neutral"}
                  >
                    {resource.status}
                  </StatusPill>
                </div>
                {canManage ? (
                  <form
                    action={updateBookingResourceProfileAction}
                    className="mt-5 grid gap-3 sm:grid-cols-2"
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
                    <Field label="Timezone">
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
                        <Field label="Sanity provider ID">
                          <input
                            className={inputClass}
                            name="providerSanityDocumentId"
                            defaultValue={provider?.sanityDocumentId ?? ""}
                          />
                        </Field>
                      </>
                    ) : null}
                    <button
                      className={`${secondaryButtonClass} sm:col-span-2 sm:justify-self-start`}
                      type="submit"
                    >
                      Save profile
                    </button>
                  </form>
                ) : null}
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
                      confirmation="Apply this resource status change? Disabling a resource can make its offerings unavailable."
                    >
                      Save status
                    </ConfirmSubmitButton>
                  </form>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
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

function SubmitButton({ children }: { children: React.ReactNode }) {
  return (
    <button
      className="mt-5 rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-white"
      type="submit"
    >
      {children}
    </button>
  );
}

const inputClass =
  "w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm";
const secondaryButtonClass =
  "rounded-full border border-lh-line px-3 py-2 text-xs font-semibold";
const theadClass =
  "bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted";
const cellClass = "px-4 py-3 align-top";
