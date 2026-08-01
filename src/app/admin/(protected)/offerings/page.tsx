import { AdminTable } from "@/components/admin/admin-table";
import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { AdminSubmitButton } from "@/components/admin/admin-submit-button";
import { AdminTabLink } from "@/components/admin/admin-tab-link";
import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";
import { CreateBookingServiceFields } from "@/components/admin/create-booking-service-fields";
import { SortableServiceList } from "@/components/admin/sortable-service-list";
import { StatusPill } from "@/components/admin/status-pill";
import { loaders } from "@/data/loaders";
import { resolveOptionalEditorialServiceOptions } from "@/lib/admin/editorial-service-options";
import { listAdminOfferings } from "@/lib/admin/operations-read";
import { canAdmin } from "@/lib/admin/permissions";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import { getBookingConfigurationStatusPresentation } from "@/lib/admin/presentation";
import type { BookingConfigurationStatus } from "@/lib/private-db/schema";

import {
  createBookingServiceAction,
  createOfferingAddOnAction,
  reorderServiceOfferingsAction,
  setBookingServiceStatusAction,
  setOfferingAddOnStatusAction,
  setServiceOfferingStatusAction,
  updateBookingServiceProfileAction,
  updateServiceOfferingAction,
} from "../actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminOfferingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    notice?: string | string[];
    tab?: string | string[];
  }>;
}) {
  const feedback = await searchParams;
  const activeTab = parseOfferingsTab(feedback.tab);
  const actor = await requireAdminPagePermission("offerings:view");
  const [data, editorialServiceOptions] = await Promise.all([
    listAdminOfferings(),
    resolveOptionalEditorialServiceOptions(() =>
      loaders.getServices({ mode: "published", stega: false }),
    ),
  ]);
  const publishedServices = editorialServiceOptions.services;
  const canManage = canAdmin({
    action: "offerings:manage",
    bookingProviderResourceIds: actor.bookingProviderResourceIds,
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  });
  const providerById = new Map(data.providers.map((row) => [row.id, row]));
  const serviceById = new Map(data.services.map((row) => [row.id, row]));
  const offeringById = new Map(data.offerings.map((row) => [row.id, row]));
  const canManageAllServices =
    actor.user.role === "owner" || actor.user.role === "admin";
  const canManageService = (service: (typeof data.services)[number]) =>
    canManage &&
    (canManageAllServices ||
      (service.ownerProviderId !== null &&
        providerById.has(service.ownerProviderId)));

  return (
    <div className="flex flex-col gap-8">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Manage business
        </p>
        <h1 className="mt-2 font-heading text-4xl uppercase leading-none tracking-[0.08em] sm:text-5xl lg:text-6xl">
          Services &amp; pricing
        </h1>
        <p className="mt-3 max-w-3xl text-lh-muted">
          Manage what clients can book, who provides each service, how long it
          takes, and what the client pays.
        </p>
      </header>

      <AdminActionFeedback error={feedback.error} notice={feedback.notice} />

      <nav
        aria-label="Services and pricing sections"
        className="flex gap-2 overflow-x-auto pb-1"
      >
        {offeringsTabs.map((tab) => (
          <AdminTabLink
            active={activeTab === tab.value}
            className="shrink-0"
            key={tab.value}
            href={`/admin/offerings?tab=${tab.value}`}
          >
            {tab.label}
          </AdminTabLink>
        ))}
      </nav>

      {activeTab === "services" && !editorialServiceOptions.isAvailable ? (
        <div
          className="rounded-2xl border border-lh-accent-soft bg-lh-light-soft p-4 text-sm text-lh-accent"
          role="status"
        >
          Website content is temporarily unavailable. Services and pricing
          remain manageable; website content links cannot be changed right now.
        </div>
      ) : null}

      {canManage && activeTab === "services" && data.providers.length > 0 ? (
        <details className={panelClass}>
          <summary className={createSummaryClass}>
            Create and configure a service
          </summary>
          <form action={createBookingServiceAction} className="mt-5">
            <CreateBookingServiceFields
              editorialServicesAvailable={editorialServiceOptions.isAvailable}
              providers={data.providers.map((provider) => ({
                displayName: provider.displayName,
                id: provider.id,
              }))}
              publishedServices={publishedServices.map((service) => ({
                _id: service._id,
                slug: service.slug,
                title: service.title,
              }))}
            />
            <AdminSubmitButton
              className={primaryButtonClass}
              pendingLabel="Creating service…"
            >
              Create service as draft
            </AdminSubmitButton>
          </form>
        </details>
      ) : null}

      {canManage && activeTab === "add-ons" && data.offerings.length > 0 ? (
        <details className={`${panelClass} order-last`}>
          <summary className={createSummaryClass}>Add a service add-on</summary>
          <form action={createOfferingAddOnAction} className="mt-5">
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Field label="Service and provider">
                <select className={inputClass} name="offeringId">
                  {data.offerings.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.publicTitle ?? row.serviceTitle} ·{" "}
                      {providerById.get(row.providerId)?.displayName ??
                        "Unknown provider"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Name">
                <input className={inputClass} name="name" required />
              </Field>
              <Field label="Price (CAD)">
                <input
                  className={inputClass}
                  name="price"
                  inputMode="decimal"
                  pattern="[0-9]+(?:\.[0-9]{1,2})?"
                  required
                />
              </Field>
              <Field label="Extra minutes">
                <input
                  className={inputClass}
                  name="durationDeltaMinutes"
                  type="number"
                  min="0"
                  defaultValue="0"
                  required
                />
              </Field>
              <Field label="Description">
                <input className={inputClass} name="description" required />
              </Field>
            </div>
            <details className={advancedDetailsClass}>
              <summary className={advancedSummaryClass}>
                Advanced — add-on key is set automatically
              </summary>
              <div className="mt-4">
                <Field label="Add-on key (optional override)">
                  <input
                    className={inputClass}
                    name="addOnKey"
                    placeholder="Generated from the add-on name"
                  />
                  <span className="mt-2 block text-xs font-normal leading-5 text-lh-muted">
                    Used internally and must be unique for this offering. Leave
                    blank to generate it from the add-on name.
                  </span>
                </Field>
              </div>
            </details>
            <AdminSubmitButton
              className={primaryButtonClass}
              pendingLabel="Adding add-on…"
            >
              Add add-on
            </AdminSubmitButton>
          </form>
        </details>
      ) : null}

      {activeTab === "services" ? (
        <section className="order-last space-y-4">
          <h2 className={sectionHeadingClass}>Service profile details</h2>
          {data.services.length === 0 ? (
            <EmptyState
              title="No services yet"
              description={
                data.providers.length > 0
                  ? "Add the first service to make it available for provider pricing and online booking."
                  : "Add a bookable provider in Team before creating the first service."
              }
            />
          ) : (
            <AdminTable caption="Services">
              <thead className={theadClass}>
                <tr>
                  <th scope="col" className={cellClass}>
                    Service
                  </th>
                  <th scope="col" className={cellClass}>
                    Public link
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
                {data.services.map((service) => (
                  <tr key={service.id}>
                    <td className={cellClass}>
                      <p className="font-semibold">{service.displayTitle}</p>
                      <p className="text-xs text-lh-muted">
                        {service.ownerProviderId
                          ? (providerById.get(service.ownerProviderId)
                              ?.displayName ?? "Unknown provider")
                          : "Shared service"}
                      </p>
                      <details className="mt-2">
                        <summary className={recordAdvancedSummaryClass}>
                          Advanced
                        </summary>
                        <p className="mt-1 break-all text-xs text-lh-muted">
                          Service key: {service.serviceKey}
                        </p>
                      </details>
                    </td>
                    <td className={cellClass}>
                      {canManageService(service) ? (
                        <form
                          action={updateBookingServiceProfileAction}
                          className="grid min-w-64 gap-2"
                        >
                          <input
                            type="hidden"
                            name="serviceId"
                            value={service.id}
                          />
                          <Field label="Display title">
                            <input
                              className={inputClass}
                              name="displayTitle"
                              defaultValue={service.displayTitle}
                              required
                            />
                          </Field>
                          <p className="text-sm text-lh-muted">
                            {service.sanityDocumentId
                              ? "Website content linked"
                              : "No website content page"}
                          </p>
                          <details className={advancedDetailsClass}>
                            <summary className={advancedSummaryClass}>
                              Advanced
                            </summary>
                            <div className="mt-4 grid gap-3">
                              <Field label="Public booking slug">
                                <input
                                  className={inputClass}
                                  disabled={
                                    !editorialServiceOptions.isAvailable &&
                                    service.sanityDocumentId !== null &&
                                    service.publicSlug !== null
                                  }
                                  name="publicSlug"
                                  defaultValue={service.publicSlug ?? ""}
                                  required
                                />
                              </Field>
                              <Field label="Website content page (optional)">
                                {editorialServiceOptions.isAvailable ? (
                                  <select
                                    className={inputClass}
                                    name="sanityServiceLink"
                                    defaultValue={getSanityServiceLinkValue(
                                      publishedServices,
                                      service,
                                    )}
                                  >
                                    <option value="">
                                      No website content page
                                    </option>
                                    {publishedServices.map(
                                      (publishedService) => (
                                        <option
                                          key={publishedService._id}
                                          value={encodeSanityServiceLink(
                                            publishedService,
                                          )}
                                        >
                                          {publishedService.title}
                                        </option>
                                      ),
                                    )}
                                  </select>
                                ) : (
                                  <>
                                    {service.sanityDocumentId &&
                                    service.publicSlug ? (
                                      <input
                                        name="sanityServiceLink"
                                        type="hidden"
                                        value={encodeSanityServiceLink({
                                          _id: service.sanityDocumentId,
                                          slug: service.publicSlug,
                                        })}
                                      />
                                    ) : null}
                                    <p className="rounded-xl border border-lh-line bg-white px-3 py-2 text-sm text-lh-muted">
                                      Existing website content link preserved.
                                    </p>
                                  </>
                                )}
                              </Field>
                            </div>
                          </details>
                          <AdminSubmitButton
                            className={`${secondaryButtonClass} justify-self-start`}
                            pendingLabel="Saving…"
                          >
                            Save details
                          </AdminSubmitButton>
                        </form>
                      ) : (
                        <>
                          <p>
                            {service.sanityDocumentId
                              ? "Website content linked"
                              : "No website content page"}
                          </p>
                          <details className="mt-2">
                            <summary className={recordAdvancedSummaryClass}>
                              Advanced
                            </summary>
                            <p className="mt-1 break-all text-xs text-lh-muted">
                              Public slug: {service.publicSlug ?? "Not set"}
                            </p>
                            <p className="mt-1 break-all text-xs text-lh-muted">
                              Website content ID:{" "}
                              {service.sanityDocumentId ?? "Not linked"}
                            </p>
                          </details>
                        </>
                      )}
                    </td>
                    <td className={cellClass}>
                      <StatusPill
                        tone={
                          getBookingConfigurationStatusPresentation(
                            service.status,
                          ).tone
                        }
                      >
                        {
                          getBookingConfigurationStatusPresentation(
                            service.status,
                          ).label
                        }
                      </StatusPill>
                    </td>
                    <td className={cellClass}>
                      {canManageService(service) ? (
                        <StatusForm
                          action={setBookingServiceStatusAction}
                          idName="serviceId"
                          id={service.id}
                          status={service.status}
                        />
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          )}
        </section>
      ) : null}

      {activeTab === "services" ? (
        <section className="space-y-4">
          <div>
            <h2 className={sectionHeadingClass}>Services</h2>
            <p className="mt-2 max-w-3xl text-sm text-lh-muted">
              Edit pricing and timing, manage status, and set the client-facing
              order. Availability follows the provider&apos;s working hours and
              connected booking calendar.
            </p>
          </div>
          {data.offerings.length === 0 ? (
            <EmptyState
              title="No provider pricing yet"
              description={
                data.services.length > 0 && data.providers.length > 0
                  ? "Assign a service to a provider to set its price, duration, availability, and required resources."
                  : "Create a service and a bookable provider before setting provider pricing."
              }
            />
          ) : (
            <SortableServiceList
              action={reorderServiceOfferingsAction}
              items={data.offerings.map((offering) => {
                const offeringStatus =
                  getBookingConfigurationStatusPresentation(offering.status);
                const service = serviceById.get(offering.serviceId);
                const serviceStatus = service
                  ? getBookingConfigurationStatusPresentation(service.status)
                  : null;

                return {
                  content: (
                    <article className={`${panelClass} pt-16`}>
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h3 className="text-xl font-semibold">
                            {offering.publicTitle ?? offering.serviceTitle}
                          </h3>
                          {offering.publicSummary ? (
                            <p className="mt-1 max-w-xl text-sm text-lh-muted">
                              {offering.publicSummary}
                            </p>
                          ) : null}
                          <p className="mt-1 text-sm text-lh-muted">
                            {providerById.get(offering.providerId)
                              ?.displayName ?? "Unknown provider"}{" "}
                            · {offering.resourceName}
                          </p>
                          <details className="mt-2">
                            <summary className={recordAdvancedSummaryClass}>
                              Advanced
                            </summary>
                            <dl className="mt-2 grid gap-1 text-xs text-lh-muted">
                              <div>
                                <dt className="inline font-semibold">
                                  Offering key:{" "}
                                </dt>
                                <dd className="inline break-all">
                                  {offering.offeringKey}
                                </dd>
                              </div>
                              <div>
                                <dt className="inline font-semibold">
                                  Configuration version:{" "}
                                </dt>
                                <dd className="inline">{offering.version}</dd>
                              </div>
                            </dl>
                          </details>
                        </div>
                        <div className="flex flex-wrap justify-end gap-2">
                          {serviceStatus ? (
                            <StatusPill tone={serviceStatus.tone}>
                              Service: {serviceStatus.label}
                            </StatusPill>
                          ) : null}
                          <StatusPill tone={offeringStatus.tone}>
                            Booking: {offeringStatus.label}
                          </StatusPill>
                        </div>
                      </div>
                      <dl className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                        <Metric
                          label="Duration"
                          value={`${offering.durationMinutes} min`}
                        />
                        <Metric
                          label="Price"
                          value={money(offering.fullPriceCents)}
                        />
                        <Metric
                          label="Deposit"
                          value={money(offering.depositAmountCents)}
                        />
                        <Metric
                          label="Buffers"
                          value={`${offering.bufferBeforeMinutes}/${offering.bufferAfterMinutes} min`}
                        />
                      </dl>
                      {canManage ? (
                        <form
                          action={updateServiceOfferingAction}
                          className="mt-5 grid gap-3 rounded-2xl bg-lh-neutral-2 p-4 sm:grid-cols-2 lg:grid-cols-3"
                        >
                          <input
                            type="hidden"
                            name="offeringId"
                            value={offering.id}
                          />
                          <input
                            type="hidden"
                            name="expectedVersion"
                            value={offering.version}
                          />
                          <Field label="Public title">
                            <input
                              className={inputClass}
                              name="publicTitle"
                              defaultValue={
                                offering.publicTitle ?? offering.serviceTitle
                              }
                              required
                            />
                          </Field>
                          <Field label="Public summary">
                            <textarea
                              className={inputClass}
                              name="publicSummary"
                              defaultValue={offering.publicSummary ?? ""}
                              rows={3}
                              required
                            />
                          </Field>
                          <Field label="Duration (minutes)">
                            <input
                              className={inputClass}
                              name="durationMinutes"
                              type="number"
                              min="1"
                              defaultValue={offering.durationMinutes}
                              required
                            />
                          </Field>
                          <Field label="Slot interval">
                            <input
                              className={inputClass}
                              name="slotIntervalMinutes"
                              type="number"
                              min="1"
                              defaultValue={offering.slotIntervalMinutes}
                              required
                            />
                          </Field>
                          <Field label="Buffer before">
                            <input
                              className={inputClass}
                              name="bufferBeforeMinutes"
                              type="number"
                              min="0"
                              defaultValue={offering.bufferBeforeMinutes}
                              required
                            />
                          </Field>
                          <Field label="Buffer after">
                            <input
                              className={inputClass}
                              name="bufferAfterMinutes"
                              type="number"
                              min="0"
                              defaultValue={offering.bufferAfterMinutes}
                              required
                            />
                          </Field>
                          <Field label="Full price (CAD)">
                            <input
                              className={inputClass}
                              name="fullPrice"
                              inputMode="decimal"
                              pattern="[0-9]+(?:\.[0-9]{1,2})?"
                              defaultValue={moneyInput(offering.fullPriceCents)}
                              required
                            />
                          </Field>
                          <Field label="Deposit (CAD)">
                            <input
                              className={inputClass}
                              name="depositAmount"
                              inputMode="decimal"
                              pattern="[0-9]+(?:\.[0-9]{1,2})?"
                              defaultValue={moneyInput(
                                offering.depositAmountCents,
                              )}
                              required
                            />
                          </Field>
                          <AdminSubmitButton
                            className={`${secondaryButtonClass} sm:col-span-2 sm:justify-self-start lg:col-span-3`}
                            pendingLabel="Saving…"
                          >
                            Save offering details
                          </AdminSubmitButton>
                        </form>
                      ) : null}
                      {canManage || (service && canManageService(service)) ? (
                        <div className="mt-5 grid gap-4 sm:grid-cols-2">
                          {service && canManageService(service) ? (
                            <div>
                              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted">
                                Service status
                              </p>
                              <StatusForm
                                action={setBookingServiceStatusAction}
                                idName="serviceId"
                                id={service.id}
                                status={service.status}
                              />
                            </div>
                          ) : null}
                          {canManage ? (
                            <div>
                              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted">
                                Booking availability
                              </p>
                              <StatusForm
                                action={setServiceOfferingStatusAction}
                                idName="offeringId"
                                id={offering.id}
                                status={offering.status}
                              />
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  ),
                  id: offering.id,
                  label: offering.publicTitle ?? offering.serviceTitle,
                };
              })}
            />
          )}
        </section>
      ) : null}

      {activeTab === "add-ons" ? (
        <section className="space-y-4">
          <div>
            <h2 className={sectionHeadingClass}>Add-ons</h2>
            <p className="mt-2 max-w-3xl text-sm text-lh-muted">
              Manage optional upgrades clients can select with a service.
            </p>
          </div>
          {data.addOns.length === 0 ? (
            <EmptyState
              title="No add-ons yet"
              description="Add an upgrade to an existing provider service to set its price and extra time."
            />
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {data.addOns.map((addOn) => {
                const addOnStatus = getBookingConfigurationStatusPresentation(
                  addOn.status,
                );
                const offering = offeringById.get(addOn.offeringId);
                const provider = offering
                  ? providerById.get(offering.providerId)
                  : undefined;

                return (
                  <article key={addOn.id} className={panelClass}>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <h3 className="text-xl font-semibold">{addOn.name}</h3>
                        <p className="mt-1 text-sm text-lh-muted">
                          {offering?.publicTitle ??
                            offering?.serviceTitle ??
                            "Unavailable service"}
                          {provider ? ` · ${provider.displayName}` : ""}
                        </p>
                      </div>
                      <StatusPill tone={addOnStatus.tone}>
                        {addOnStatus.label}
                      </StatusPill>
                    </div>
                    {addOn.description ? (
                      <p className="mt-4 text-sm text-lh-muted">
                        {addOn.description}
                      </p>
                    ) : null}
                    <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
                      <Metric label="Price" value={money(addOn.priceCents)} />
                      <Metric
                        label="Extra time"
                        value={`${addOn.durationDeltaMinutes} min`}
                      />
                    </dl>
                    <details className="mt-3">
                      <summary className={advancedSummaryClass}>
                        Advanced
                      </summary>
                      <p className="mt-1 break-all text-xs text-lh-muted">
                        Add-on key: {addOn.addOnKey}
                      </p>
                    </details>
                    {canManage ? (
                      <form
                        action={setOfferingAddOnStatusAction}
                        className="mt-5"
                      >
                        <input type="hidden" name="addOnId" value={addOn.id} />
                        <input
                          type="hidden"
                          name="status"
                          value={
                            addOn.status === "active" ? "disabled" : "active"
                          }
                        />
                        <ConfirmSubmitButton
                          className={secondaryButtonClass}
                          confirmation={
                            addOn.status === "active"
                              ? `Disable ${addOn.name}? Clients will no longer be able to add it to new bookings.`
                              : `Activate ${addOn.name}? Clients will be able to add it to eligible new bookings.`
                          }
                        >
                          {addOn.status === "active" ? "Disable" : "Activate"}
                        </ConfirmSubmitButton>
                      </form>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

function EmptyState({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-lh-line bg-lh-neutral-2 p-6">
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-2 max-w-2xl text-sm text-lh-muted">{description}</p>
    </div>
  );
}

function StatusForm({
  action,
  id,
  idName,
  status,
}: {
  action: (formData: FormData) => Promise<void>;
  id: string;
  idName: string;
  status: BookingConfigurationStatus;
}) {
  return (
    <form action={action} className="flex gap-2">
      <input type="hidden" name={idName} value={id} />
      <select
        className={inputClass}
        name="status"
        defaultValue={status === "archived" ? "disabled" : status}
      >
        <option value="draft">Draft</option>
        <option value="active">Active</option>
        <option value="disabled">Disabled</option>
      </select>
      <ConfirmSubmitButton
        className={secondaryButtonClass}
        confirmation="Apply this status change? Activating makes the service bookable; disabling can remove it from online booking."
      >
        Save
      </ConfirmSubmitButton>
    </form>
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
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.12em] text-lh-muted">
        {label}
      </dt>
      <dd className="mt-1 font-semibold">{value}</dd>
    </div>
  );
}
function money(cents: number) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
  }).format(cents / 100);
}
function moneyInput(cents: number) {
  return (cents / 100).toFixed(2);
}
function encodeSanityServiceLink(service: { _id: string; slug: string }) {
  return JSON.stringify({
    publicSlug: service.slug,
    sanityDocumentId: service._id,
  });
}
function getSanityServiceLinkValue(
  publishedServices: Array<{ _id: string; slug: string }>,
  service: { publicSlug: string | null; sanityDocumentId: string | null },
) {
  const publishedService = publishedServices.find(
    (candidate) =>
      candidate._id === service.sanityDocumentId &&
      candidate.slug === service.publicSlug,
  );
  return publishedService ? encodeSanityServiceLink(publishedService) : "";
}

const offeringsTabs = [
  { label: "Services", value: "services" },
  { label: "Add-ons", value: "add-ons" },
] as const;

type OfferingsTab = (typeof offeringsTabs)[number]["value"];

function parseOfferingsTab(value: string | string[] | undefined): OfferingsTab {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === "add-ons") return candidate;
  return "services";
}

const panelClass = "rounded-2xl border border-lh-line bg-white p-6";
const sectionHeadingClass = "font-heading text-4xl uppercase tracking-[0.08em]";
const inputClass =
  "min-h-11 w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm";
const primaryButtonClass =
  "mt-5 min-h-11 rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-white disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButtonClass =
  "min-h-11 rounded-full border border-lh-line px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50";
const theadClass =
  "bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted";
const cellClass = "px-4 py-3 align-top";
const createSummaryClass =
  "min-h-11 cursor-pointer list-none py-2 font-heading text-2xl uppercase tracking-[0.08em] text-lh-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden";
const advancedDetailsClass =
  "mt-3 rounded-2xl border border-lh-line bg-lh-neutral-2 p-4";
const advancedSummaryClass =
  "min-h-11 cursor-pointer list-none py-2 text-sm font-semibold text-lh-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden";
const recordAdvancedSummaryClass =
  "min-h-11 cursor-pointer py-3 text-xs font-semibold text-lh-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2";
