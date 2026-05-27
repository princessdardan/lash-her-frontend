import Link from "next/link";
import { type ReactElement } from "react";
import { cn } from "@/lib/utils";
import type { TProductCollection, TProductFilterAttribute } from "@/types";

export interface ProductCatalogQueryState {
  collection?: string;
  attributes: string[];
  sort?: string;
  page?: string;
}

interface ProductFiltersProps {
  collections: TProductCollection[];
  filterAttributes: TProductFilterAttribute[];
  query: ProductCatalogQueryState;
}

function buildCatalogUrl(query: ProductCatalogQueryState): string {
  const params = new URLSearchParams();

  if (query.collection) params.set("collection", query.collection);
  query.attributes.forEach((attribute) => params.append("attribute", attribute));
  if (query.sort && query.sort !== "default") params.set("sort", query.sort);
  if (query.page) params.set("page", query.page);

  const search = params.toString();
  return search ? `/products?${search}` : "/products";
}

function getCollectionUrl(query: ProductCatalogQueryState, collection?: string): string {
  return buildCatalogUrl({
    ...query,
    collection,
    page: undefined,
  });
}

function getAttributeUrl(query: ProductCatalogQueryState, value: string): string {
  const attributes = query.attributes.includes(value)
    ? query.attributes.filter((attribute) => attribute !== value)
    : [...query.attributes, value];

  return buildCatalogUrl({
    ...query,
    attributes,
    page: undefined,
  });
}

function getGroupedAttributes(filterAttributes: TProductFilterAttribute[]): Array<[string, string[]]> {
  const grouped = filterAttributes.reduce<Record<string, Set<string>>>((acc, attribute) => {
    if (!attribute.label || !attribute.value) return acc;

    acc[attribute.label] ??= new Set<string>();
    acc[attribute.label].add(attribute.value);
    return acc;
  }, {});

  return Object.entries(grouped).map(([label, values]) => [label, Array.from(values).sort((a, b) => a.localeCompare(b))]);
}

export function ProductFilters({ collections, filterAttributes, query }: ProductFiltersProps): ReactElement {
  const groupedAttributes = getGroupedAttributes(filterAttributes);

  return (
    <aside role="complementary" className="w-full shrink-0 lg:w-72" aria-label="Catalog filters">
      <div className="soft-panel sticky top-28 space-y-10 bg-lh-white/82 p-6 backdrop-blur md:p-7">
        <div>
          <p className="eyebrow-label mb-4">Catalog filters</p>
          <p className="font-body text-sm font-bold leading-6 text-lh-muted">
            Refine the edit by collection, finish, and professional-use details.
          </p>
        </div>

        {collections.length > 0 && (
          <section aria-labelledby="catalog-collections-heading">
            <h2 id="catalog-collections-heading" className="mb-4 font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-shadow">
              Collections
            </h2>
            <ul className="space-y-2">
              <li>
                <Link
                  href={getCollectionUrl(query)}
                  aria-current={!query.collection ? "page" : undefined}
                  className={cn(
                    "flex rounded-full border px-4 py-2 font-body text-sm font-bold transition-colors",
                    !query.collection
                      ? "border-lh-primary bg-lh-primary-soft text-lh-primary"
                      : "border-lh-line text-lh-shadow hover:border-lh-light hover:bg-lh-neutral-2",
                  )}
                >
                  All Products
                </Link>
              </li>
              {collections.map((collection) => {
                const isCurrent = query.collection === collection.slug;

                return (
                  <li key={collection._id}>
                    <Link
                      href={getCollectionUrl(query, collection.slug)}
                      aria-current={isCurrent ? "page" : undefined}
                      className={cn(
                        "flex rounded-full border px-4 py-2 font-body text-sm font-bold transition-colors",
                        isCurrent
                          ? "border-lh-primary bg-lh-primary-soft text-lh-primary"
                          : "border-lh-line text-lh-shadow hover:border-lh-light hover:bg-lh-neutral-2",
                      )}
                    >
                      {collection.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {groupedAttributes.length > 0 && (
          <section aria-labelledby="catalog-attributes-heading">
            <h2 id="catalog-attributes-heading" className="mb-4 font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-shadow">
              Refine By
            </h2>
            <div className="space-y-6">
              {groupedAttributes.map(([label, values]) => (
                <div key={label}>
                  <p className="mb-3 font-heading text-[11px] font-normal uppercase tracking-[0.28em] text-lh-muted">
                    {label}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {values.map((value) => {
                      const isSelected = query.attributes.includes(value);

                      return (
                        <Link
                          key={value}
                          href={getAttributeUrl(query, value)}
                          aria-current={isSelected ? "true" : undefined}
                          className={cn(
                            "rounded-full border px-3 py-1.5 font-body text-xs font-bold transition-colors",
                            isSelected
                              ? "border-lh-accent bg-lh-accent-soft text-lh-accent"
                              : "border-lh-line text-lh-shadow hover:border-lh-light hover:bg-lh-neutral-2",
                          )}
                        >
                          {value}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}
