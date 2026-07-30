"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { formatCad } from "@/lib/commerce/money";
import type {
  PublicProviderServiceCatalog,
  PublicProviderServiceCatalogGroup,
} from "@/lib/booking/operations/public-service-catalog";

interface ProviderServiceTabsProps {
  catalog: PublicProviderServiceCatalog;
  initialProviderSlug: string;
}

export function ProviderServiceTabs({
  catalog,
  initialProviderSlug,
}: ProviderServiceTabsProps) {
  const pathname = usePathname();
  const router = useRouter();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [selection, setSelection] = useState(() => ({
    initialProviderSlug,
    selectedProviderSlug: initialProviderSlug,
  }));
  const selectedProviderSlug =
    selection.initialProviderSlug === initialProviderSlug
      ? selection.selectedProviderSlug
      : initialProviderSlug;

  const selectedProvider =
    catalog.providers.find(
      (provider) => provider.providerSlug === selectedProviderSlug,
    ) ?? catalog.providers[0];

  if (!selectedProvider) {
    return null;
  }

  const selectProvider = (providerSlug: string, focus = false) => {
    setSelection({
      initialProviderSlug,
      selectedProviderSlug: providerSlug,
    });

    if (focus) {
      const index = catalog.providers.findIndex(
        (provider) => provider.providerSlug === providerSlug,
      );
      tabRefs.current[index]?.focus();
    }

    const params = new URLSearchParams(window.location.search);
    params.set("provider", providerSlug);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const lastIndex = catalog.providers.length - 1;
    let nextIndex: number | null = null;

    if (event.key === "ArrowRight") {
      nextIndex = index === lastIndex ? 0 : index + 1;
    } else if (event.key === "ArrowLeft") {
      nextIndex = index === 0 ? lastIndex : index - 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = lastIndex;
    }

    if (nextIndex === null) {
      return;
    }

    event.preventDefault();
    const provider = catalog.providers[nextIndex];
    if (provider) {
      selectProvider(provider.providerSlug, true);
    }
  };

  return (
    <>
      <div
        aria-label="Select a service provider"
        className="mb-8 flex gap-2 overflow-x-auto border-b border-lh-line pb-3"
        role="tablist"
      >
        {catalog.providers.map((provider, index) => {
          const isSelected =
            provider.providerSlug === selectedProvider.providerSlug;

          return (
            <button
              aria-controls={getPanelId(provider)}
              aria-selected={isSelected}
              className={`shrink-0 rounded-full border px-5 py-2.5 font-body text-sm font-bold transition-colors ${
                isSelected
                  ? "border-lh-primary bg-lh-primary text-white"
                  : "border-lh-line bg-white text-black hover:border-lh-primary"
              }`}
              id={getTabId(provider)}
              key={provider.providerSlug}
              onClick={() => selectProvider(provider.providerSlug)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              role="tab"
              tabIndex={isSelected ? 0 : -1}
              type="button"
            >
              {provider.displayName}
            </button>
          );
        })}
      </div>

      {catalog.providers.map((provider) => {
        const isSelected =
          provider.providerSlug === selectedProvider.providerSlug;

        return (
          <section
            aria-labelledby={getTabId(provider)}
            hidden={!isSelected}
            id={getPanelId(provider)}
            key={provider.providerSlug}
            role="tabpanel"
            tabIndex={isSelected ? 0 : -1}
          >
            <h2 className="sr-only">Services with {provider.displayName}</h2>
            <div className="space-y-3">
              {provider.services.map((service) => (
                <article
                  className="editorial-card items-start gap-4 p-5 text-left md:p-6"
                  key={service.offeringId}
                >
                  <div className="w-full">
                    <h3 className="section-subheading mb-1 text-lg md:text-lg lg:text-lg">
                      {service.title}
                    </h3>
                    <p className="mb-2 text-sm text-lh-muted">
                      {service.durationMinutes} min
                    </p>
                    {service.summary ? (
                      <p className="max-w-3xl text-sm font-light leading-relaxed text-black">
                        {service.summary}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex w-full flex-col items-start gap-3">
                    <span className="font-medium text-black">
                      {formatCad(service.fullPriceCents / 100)}
                    </span>
                    <div
                      className={`grid w-full gap-3 ${
                        service.detailHref ? "grid-cols-2" : "grid-cols-1"
                      }`}
                    >
                      <Button
                        asChild
                        className="w-full rounded-full px-5 text-sm sm:min-w-28 sm:px-7"
                        size="lg"
                      >
                        <Link href={service.bookingHref}>Book</Link>
                      </Button>
                      {service.detailHref ? (
                        <Button
                          asChild
                          className="w-full rounded-full px-5 text-sm sm:min-w-36 sm:px-7"
                          size="lg"
                          variant="outline"
                        >
                          <Link href={service.detailHref}>View details</Link>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

function getPanelId(provider: PublicProviderServiceCatalogGroup): string {
  return `provider-panel-${provider.providerSlug}`;
}

function getTabId(provider: PublicProviderServiceCatalogGroup): string {
  return `provider-tab-${provider.providerSlug}`;
}
