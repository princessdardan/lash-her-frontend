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
