"use client";

import { useId, useRef, useState } from "react";

import { createServiceIdentifier } from "@/lib/admin/service-identifier";

interface ProviderOption {
  displayName: string;
  id: string;
}

interface PublishedServiceOption {
  _id: string;
  slug: string;
  title: string;
}

interface CreateBookingServiceFieldsProps {
  editorialServicesAvailable: boolean;
  providers: ProviderOption[];
  publishedServices: PublishedServiceOption[];
}

const inputClass =
  "min-h-11 w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm";
const advancedDetailsClass =
  "mt-3 rounded-2xl border border-lh-line bg-lh-neutral-2 p-4";
const advancedSummaryClass =
  "min-h-11 cursor-pointer list-none py-2 text-sm font-semibold text-lh-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden";

export function CreateBookingServiceFields({
  editorialServicesAvailable,
  providers,
  publishedServices,
}: CreateBookingServiceFieldsProps) {
  const [displayTitle, setDisplayTitle] = useState("");
  const [serviceKey, setServiceKey] = useState("");
  const [publicSlug, setPublicSlug] = useState("");
  const serviceKeyCustomizedRef = useRef(false);
  const publicSlugCustomizedRef = useRef(false);
  const generatedDescriptionId = useId();
  const serviceKeyDescriptionId = useId();
  const publicSlugDescriptionId = useId();

  function updateDisplayTitle(nextDisplayTitle: string) {
    const nextGeneratedIdentifier = createServiceIdentifier(nextDisplayTitle);

    setDisplayTitle(nextDisplayTitle);
    if (!serviceKeyCustomizedRef.current) {
      setServiceKey(nextGeneratedIdentifier);
    }
    if (!publicSlugCustomizedRef.current) {
      setPublicSlug(nextGeneratedIdentifier);
    }
  }

  function updateSanityServiceLink(encodedLink: string) {
    if (!encodedLink) return;

    try {
      const link = JSON.parse(encodedLink) as { publicSlug?: unknown };
      if (typeof link.publicSlug === "string") {
        publicSlugCustomizedRef.current = true;
        setPublicSlug(link.publicSlug);
      }
    } catch {
      // The server action validates the selected option before persisting it.
    }
  }

  return (
    <>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field
          description="The internal key and public booking URL are generated automatically."
          descriptionId={generatedDescriptionId}
          label="Display title"
        >
          <input
            aria-describedby={generatedDescriptionId}
            className={inputClass}
            name="displayTitle"
            onChange={(event) => updateDisplayTitle(event.target.value)}
            required
            value={displayTitle}
          />
        </Field>
        <Field label="Provider">
          <select className={inputClass} name="ownerProviderId" required>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.displayName}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="mt-6 border-t border-lh-line pt-6">
        <h3 className="font-heading text-2xl uppercase tracking-[0.08em]">
          Pricing, timing &amp; availability
        </h3>
        <p className="mt-2 max-w-2xl text-sm text-lh-muted">
          Availability follows the selected provider&apos;s working hours and
          connected booking calendar.
        </p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Public summary">
            <textarea
              className={inputClass}
              name="publicSummary"
              rows={3}
              required
            />
          </Field>
          <Field label="Duration (minutes)">
            <input
              className={inputClass}
              defaultValue="90"
              min="1"
              name="durationMinutes"
              required
              type="number"
            />
          </Field>
          <Field label="Slot interval (minutes)">
            <input
              className={inputClass}
              defaultValue="15"
              min="1"
              name="slotIntervalMinutes"
              required
              type="number"
            />
          </Field>
          <Field label="Buffer before (minutes)">
            <input
              className={inputClass}
              defaultValue="15"
              min="0"
              name="bufferBeforeMinutes"
              required
              type="number"
            />
          </Field>
          <Field label="Buffer after (minutes)">
            <input
              className={inputClass}
              defaultValue="15"
              min="0"
              name="bufferAfterMinutes"
              required
              type="number"
            />
          </Field>
          <Field label="Full price (CAD)">
            <input
              className={inputClass}
              inputMode="decimal"
              name="fullPrice"
              pattern="[0-9]+(?:\.[0-9]{1,2})?"
              required
            />
          </Field>
          <Field label="Deposit (CAD)">
            <input
              className={inputClass}
              inputMode="decimal"
              name="depositAmount"
              pattern="[0-9]+(?:\.[0-9]{1,2})?"
              required
            />
          </Field>
        </div>
      </div>
      <details className={advancedDetailsClass}>
        <summary className={advancedSummaryClass}>
          Advanced — identifiers are set automatically
        </summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            description="Used internally and must be unique for this provider. Keep it stable after creation."
            descriptionId={serviceKeyDescriptionId}
            label="Service key"
          >
            <input
              aria-describedby={serviceKeyDescriptionId}
              className={inputClass}
              name="serviceKey"
              onChange={(event) => {
                serviceKeyCustomizedRef.current = true;
                setServiceKey(event.target.value);
              }}
              placeholder="classic-fill"
              value={serviceKey}
            />
          </Field>
          <Field
            description="For example, classic-fill maps to lashher.com/services/classic-fill. It may be shared by different providers."
            descriptionId={publicSlugDescriptionId}
            label="Public booking slug"
          >
            <input
              aria-describedby={publicSlugDescriptionId}
              className={inputClass}
              name="publicSlug"
              onChange={(event) => {
                publicSlugCustomizedRef.current = true;
                setPublicSlug(event.target.value);
              }}
              placeholder="classic-fill"
              value={publicSlug}
            />
          </Field>
          <Field label="Website content page (optional)">
            <select
              className={inputClass}
              defaultValue=""
              disabled={!editorialServicesAvailable}
              name="sanityServiceLink"
              onChange={(event) => updateSanityServiceLink(event.target.value)}
            >
              <option value="">No website content page</option>
              {publishedServices.map((service) => (
                <option
                  key={service._id}
                  value={encodeSanityServiceLink(service)}
                >
                  {service.title}
                </option>
              ))}
            </select>
          </Field>
          <Field
            description="Used internally and generated from the service and provider when left blank."
            label="Offering key (optional override)"
          >
            <input
              className={inputClass}
              name="offeringKey"
              placeholder="classic-fill-provider"
            />
          </Field>
        </div>
      </details>
    </>
  );
}

function Field({
  children,
  description,
  descriptionId,
  label,
}: {
  children: React.ReactNode;
  description?: string;
  descriptionId?: string;
  label: string;
}) {
  return (
    <label className="block text-sm font-semibold">
      <span className="mb-2 block">{label}</span>
      {children}
      {description ? (
        <span
          className="mt-2 block text-xs font-normal leading-5 text-lh-muted"
          id={descriptionId}
        >
          {description}
        </span>
      ) : null}
    </label>
  );
}

function encodeSanityServiceLink(service: { _id: string; slug: string }) {
  return JSON.stringify({
    publicSlug: service.slug,
    sanityDocumentId: service._id,
  });
}
