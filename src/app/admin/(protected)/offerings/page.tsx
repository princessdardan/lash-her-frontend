import { AdminTable } from "@/components/admin/admin-table";
import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";
import { StatusPill } from "@/components/admin/status-pill";
import { loaders } from "@/data/loaders";
import { listAdminOfferings } from "@/lib/admin/operations-read";
import { canAdmin } from "@/lib/admin/permissions";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

import {
  assignOfferingResourceAction,
  createBookingServiceAction,
  createOfferingAddOnAction,
  createServiceOfferingAction,
  removeOfferingResourceAction,
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
  searchParams: Promise<{ error?: string | string[]; notice?: string | string[] }>;
}) {
  const feedback = await searchParams;
  const actor = await requireAdminPagePermission("offerings:view");
  const [data, publishedServices] = await Promise.all([
    listAdminOfferings(),
    loaders.getBookableServices({ mode: "published", stega: false }),
  ]);
  const canManage = canAdmin({
    action: "offerings:manage",
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  });
  const canManageOfferingResources = actor.user.role === "owner";
  const providerById = new Map(data.providers.map((row) => [row.id, row]));

  return (
    <div className="space-y-8">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">Booking catalogue</p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em]">Services & offerings</h1>
        <p className="mt-3 max-w-3xl text-lh-muted">Services link public editorial content to provider-specific duration, pricing, deposits, buffers, and slot rules.</p>
      </header>

      <AdminActionFeedback error={feedback.error} notice={feedback.notice} />

      {canManage ? (
        <div className="grid gap-6 xl:grid-cols-3">
          <form action={createBookingServiceAction} className={panelClass}>
            <h2 className={headingClass}>Add service</h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Field label="Display title"><input className={inputClass} name="displayTitle" required /></Field>
              <Field label="Stable key"><input className={inputClass} name="serviceKey" required placeholder="classic-fill" /></Field>
              <Field label="Published Sanity service">
                <select className={inputClass} name="sanityServiceLink" defaultValue="">
                  <option value="">Unlinked draft</option>
                  {publishedServices.map((service) => (
                    <option key={service._id} value={encodeSanityServiceLink(service)}>
                      {service.title} · {service.slug}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <SubmitButton>Add as draft</SubmitButton>
          </form>

          <form action={createServiceOfferingAction} className={panelClass}>
            <h2 className={headingClass}>Assign service to provider</h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Field label="Offering key"><input className={inputClass} name="offeringKey" required placeholder="classic-fill-nataliea" /></Field>
              <Field label="Service"><select className={inputClass} name="serviceId">{data.services.map((row) => <option key={row.id} value={row.id}>{row.displayTitle}</option>)}</select></Field>
              <Field label="Provider"><select className={inputClass} name="providerId">{data.providers.map((row) => <option key={row.id} value={row.id}>{row.displayName}</option>)}</select></Field>
              <Field label="Duration (minutes)"><input className={inputClass} name="durationMinutes" type="number" min="1" defaultValue="90" required /></Field>
              <Field label="Slot interval (minutes)"><input className={inputClass} name="slotIntervalMinutes" type="number" min="1" defaultValue="15" required /></Field>
              <Field label="Buffer before (minutes)"><input className={inputClass} name="bufferBeforeMinutes" type="number" min="0" defaultValue="15" required /></Field>
              <Field label="Buffer after (minutes)"><input className={inputClass} name="bufferAfterMinutes" type="number" min="0" defaultValue="15" required /></Field>
              <Field label="Full price (CAD)"><input className={inputClass} name="fullPrice" inputMode="decimal" pattern="\d+(?:\.\d{1,2})?" required /></Field>
              <Field label="Deposit (CAD)"><input className={inputClass} name="depositAmount" inputMode="decimal" pattern="\d+(?:\.\d{1,2})?" required /></Field>
            </div>
            <SubmitButton>Create draft offering</SubmitButton>
          </form>

          <form action={createOfferingAddOnAction} className={panelClass}>
            <h2 className={headingClass}>Add offering add-on</h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Field label="Offering"><select className={inputClass} name="offeringId">{data.offerings.map((row) => <option key={row.id} value={row.id}>{row.serviceTitle} · {row.offeringKey}</option>)}</select></Field>
              <Field label="Name"><input className={inputClass} name="name" required /></Field>
              <Field label="Stable key"><input className={inputClass} name="addOnKey" required placeholder="foreign-removal" /></Field>
              <Field label="Price (CAD)"><input className={inputClass} name="price" inputMode="decimal" pattern="[0-9]+(?:\.[0-9]{1,2})?" required /></Field>
              <Field label="Extra minutes"><input className={inputClass} name="durationDeltaMinutes" type="number" min="0" defaultValue="0" required /></Field>
              <Field label="Description"><input className={inputClass} name="description" required /></Field>
            </div>
            <SubmitButton>Add add-on</SubmitButton>
          </form>
        </div>
      ) : null}

      <section className="space-y-4">
        <h2 className={sectionHeadingClass}>Services</h2>
        <AdminTable caption="Operational services">
          <thead className={theadClass}><tr><th className={cellClass}>Service</th><th className={cellClass}>Public link</th><th className={cellClass}>Status</th><th className={cellClass}>Action</th></tr></thead>
          <tbody className="divide-y divide-lh-line">
            {data.services.map((service) => (
              <tr key={service.id}>
                <td className={cellClass}><p className="font-semibold">{service.displayTitle}</p><p className="text-xs text-lh-muted">{service.serviceKey}</p></td>
                <td className={cellClass}>
                  {canManage ? (
                    <form action={updateBookingServiceProfileAction} className="grid min-w-64 gap-2">
                      <input type="hidden" name="serviceId" value={service.id} />
                      <Field label="Display title"><input className={inputClass} name="displayTitle" defaultValue={service.displayTitle} required /></Field>
                      <Field label="Published Sanity service">
                        <select
                          className={inputClass}
                          name="sanityServiceLink"
                          defaultValue={getSanityServiceLinkValue(
                            publishedServices,
                            service,
                          )}
                        >
                          <option value="">Unlinked draft</option>
                          {publishedServices.map((publishedService) => (
                            <option
                              key={publishedService._id}
                              value={encodeSanityServiceLink(publishedService)}
                            >
                              {publishedService.title} · {publishedService.slug}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <button className={`${secondaryButtonClass} justify-self-start`} type="submit">Save details</button>
                    </form>
                  ) : (
                    <><p>{service.publicSlug ?? "No public slug"}</p><p className="text-xs text-lh-muted">{service.sanityDocumentId ?? "No Sanity document"}</p></>
                  )}
                </td>
                <td className={cellClass}><StatusPill tone={service.status === "active" ? "success" : "neutral"}>{service.status}</StatusPill></td>
                <td className={cellClass}>{canManage ? <StatusForm action={setBookingServiceStatusAction} idName="serviceId" id={service.id} status={service.status} /> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      </section>

      <section className="space-y-4">
        <h2 className={sectionHeadingClass}>Provider offerings</h2>
        <div className="grid gap-4 xl:grid-cols-2">
          {data.offerings.map((offering) => (
            <article key={offering.id} className={panelClass}>
              <div className="flex items-start justify-between gap-4">
                <div><h3 className="text-xl font-semibold">{offering.serviceTitle}</h3><p className="mt-1 text-sm text-lh-muted">{providerById.get(offering.providerId)?.displayName ?? "Unknown provider"} · {offering.resourceName}</p><p className="mt-1 text-xs text-lh-muted">{offering.offeringKey} · v{offering.version}</p></div>
                <StatusPill tone={offering.status === "active" ? "success" : "neutral"}>{offering.status}</StatusPill>
              </div>
              <dl className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                <Metric label="Duration" value={`${offering.durationMinutes} min`} />
                <Metric label="Price" value={money(offering.fullPriceCents)} />
                <Metric label="Deposit" value={money(offering.depositAmountCents)} />
                <Metric label="Buffers" value={`${offering.bufferBeforeMinutes}/${offering.bufferAfterMinutes} min`} />
              </dl>
              {canManage ? (
                <form action={updateServiceOfferingAction} className="mt-5 grid gap-3 rounded-2xl bg-lh-neutral-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
                  <input type="hidden" name="offeringId" value={offering.id} />
                  <input type="hidden" name="expectedVersion" value={offering.version} />
                  <Field label="Duration (minutes)"><input className={inputClass} name="durationMinutes" type="number" min="1" defaultValue={offering.durationMinutes} required /></Field>
                  <Field label="Slot interval"><input className={inputClass} name="slotIntervalMinutes" type="number" min="1" defaultValue={offering.slotIntervalMinutes} required /></Field>
                  <Field label="Buffer before"><input className={inputClass} name="bufferBeforeMinutes" type="number" min="0" defaultValue={offering.bufferBeforeMinutes} required /></Field>
                  <Field label="Buffer after"><input className={inputClass} name="bufferAfterMinutes" type="number" min="0" defaultValue={offering.bufferAfterMinutes} required /></Field>
                  <Field label="Full price (CAD)"><input className={inputClass} name="fullPrice" inputMode="decimal" pattern="[0-9]+(?:\.[0-9]{1,2})?" defaultValue={moneyInput(offering.fullPriceCents)} required /></Field>
                  <Field label="Deposit (CAD)"><input className={inputClass} name="depositAmount" inputMode="decimal" pattern="[0-9]+(?:\.[0-9]{1,2})?" defaultValue={moneyInput(offering.depositAmountCents)} required /></Field>
                  <button className={`${secondaryButtonClass} sm:col-span-2 sm:justify-self-start lg:col-span-3`} type="submit">Save offering details</button>
                </form>
              ) : null}
              <div className="mt-5 space-y-3">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted">Required resources</h4>
                  <p className="mt-1 text-xs text-lh-muted">Changes apply to future holds. Existing hold and appointment snapshots keep their reservation rows.</p>
                </div>
                {data.offeringResources.filter((relationship) => relationship.offeringId === offering.id).length === 0 ? (
                  <p className="text-sm text-lh-muted">No secondary resources assigned.</p>
                ) : (
                  data.offeringResources.filter((relationship) => relationship.offeringId === offering.id).map((relationship) => (
                    <div key={relationship.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-lh-line px-3 py-2 text-sm">
                      <span><strong>{relationship.resourceName}</strong> · {relationship.resourceKind} · {relationship.isRequired ? "required" : "optional"} · {relationship.resourceStatus}</span>
                      {canManageOfferingResources ? (
                        <form action={removeOfferingResourceAction}>
                          <input type="hidden" name="offeringId" value={offering.id} />
                          <input type="hidden" name="resourceId" value={relationship.resourceId} />
                          <ConfirmSubmitButton className={secondaryButtonClass} confirmation="Remove this resource from future holds? Existing reservations remain unchanged.">Remove</ConfirmSubmitButton>
                        </form>
                      ) : null}
                    </div>
                  ))
                )}
                {canManageOfferingResources ? (
                  <form action={assignOfferingResourceAction} className="grid gap-3 rounded-2xl bg-lh-neutral-2 p-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
                    <input type="hidden" name="offeringId" value={offering.id} />
                    <Field label="Secondary resource">
                      <select className={inputClass} name="resourceId" required defaultValue="">
                        <option value="" disabled>Select room or equipment</option>
                        {data.resources.filter((resource) =>
                          resource.id !== offering.primaryResourceId &&
                          !data.offeringResources.some((relationship) => relationship.offeringId === offering.id && relationship.resourceId === resource.id)
                        ).map((resource) => (
                          <option key={resource.id} value={resource.id}>{resource.name} · {resource.kind} · {resource.status}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Requirement">
                      <select className={inputClass} name="isRequired" defaultValue="true">
                        <option value="true">Required</option>
                        <option value="false">Optional</option>
                      </select>
                    </Field>
                    <button className={secondaryButtonClass} type="submit">Assign resource</button>
                  </form>
                ) : null}
              </div>
              <div className="mt-5 space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted">Add-ons</h4>
                {data.addOns.filter((addOn) => addOn.offeringId === offering.id).map((addOn) => (
                  <div key={addOn.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-lh-line px-3 py-2 text-sm">
                    <span><strong>{addOn.name}</strong> · {money(addOn.priceCents)} · +{addOn.durationDeltaMinutes} min</span>
                    <div className="flex items-center gap-2"><StatusPill tone={addOn.status === "active" ? "success" : "neutral"}>{addOn.status}</StatusPill>{canManage ? <form action={setOfferingAddOnStatusAction}><input type="hidden" name="addOnId" value={addOn.id} /><input type="hidden" name="status" value={addOn.status === "active" ? "disabled" : "active"} /><ConfirmSubmitButton className={secondaryButtonClass} confirmation={addOn.status === "active" ? "Disable this add-on?" : "Activate this add-on?"}>{addOn.status === "active" ? "Disable" : "Activate"}</ConfirmSubmitButton></form> : null}</div>
                  </div>
                ))}
              </div>
              {canManage ? <div className="mt-5"><StatusForm action={setServiceOfferingStatusAction} idName="offeringId" id={offering.id} status={offering.status} /></div> : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function StatusForm({ action, id, idName, status }: { action: (formData: FormData) => Promise<void>; id: string; idName: string; status: string }) {
  return <form action={action} className="flex gap-2"><input type="hidden" name={idName} value={id} /><select className={inputClass} name="status" defaultValue={status === "archived" ? "disabled" : status}><option value="draft">Draft</option><option value="active">Active</option><option value="disabled">Disabled</option></select><ConfirmSubmitButton className={secondaryButtonClass} confirmation="Apply this status change? Activating publishes the configuration to booking; disabling can make it unavailable.">Save</ConfirmSubmitButton></form>;
}

function Field({ children, label }: { children: React.ReactNode; label: string }) { return <label className="block text-sm font-semibold"><span className="mb-2 block">{label}</span>{children}</label>; }
function SubmitButton({ children }: { children: React.ReactNode }) { return <button className="mt-5 rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-white disabled:opacity-50" type="submit">{children}</button>; }
function Metric({ label, value }: { label: string; value: string }) { return <div><dt className="text-xs uppercase tracking-[0.12em] text-lh-muted">{label}</dt><dd className="mt-1 font-semibold">{value}</dd></div>; }
function money(cents: number) { return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(cents / 100); }
function moneyInput(cents: number) { return (cents / 100).toFixed(2); }
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

const panelClass = "rounded-2xl border border-lh-line bg-white p-6";
const headingClass = "font-heading text-3xl uppercase tracking-[0.08em]";
const sectionHeadingClass = "font-heading text-4xl uppercase tracking-[0.08em]";
const inputClass = "w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm";
const secondaryButtonClass = "rounded-full border border-lh-line px-3 py-2 text-xs font-semibold";
const theadClass = "bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted";
const cellClass = "px-4 py-3 align-top";
