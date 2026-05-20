"use client";

import { type ReactElement } from "react";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import type { TProductCollection, TProductFilterAttribute } from "@/types";

interface ProductFiltersProps {
  collections: TProductCollection[];
  filterAttributes: TProductFilterAttribute[];
}

export function ProductFilters({ collections, filterAttributes }: ProductFiltersProps): ReactElement {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  
  const currentCollection = searchParams.get("collection");
  const currentAttributes = searchParams.getAll("attribute");

  const createUrl = (key: string, value: string | null, isArray = false) => {
    const params = new URLSearchParams(searchParams.toString());
    if (isArray) {
      if (value === null) {
        params.delete(key);
      } else {
        const existing = params.getAll(key);
        if (existing.includes(value)) {
          const newValues = existing.filter(v => v !== value);
          params.delete(key);
          newValues.forEach(v => params.append(key, v));
        } else {
          params.append(key, value);
        }
      }
    } else {
      if (value === null) {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }
    return `${pathname}?${params.toString()}`;
  };

  const groupedAttributes = filterAttributes.reduce<Record<string, Set<string>>>((acc, attr) => {
    if (!acc[attr.label]) {
      acc[attr.label] = new Set();
    }
    acc[attr.label].add(attr.value);
    return acc;
  }, {});

  return (
    <aside className="w-full md:w-64 flex-shrink-0" aria-label="Catalog filters">
      <div className="sticky top-32 flex flex-col gap-10">
        {collections.length > 0 && (
          <div>
            <h3 className="font-label-caps text-xs tracking-widest uppercase text-lh-shadow mb-6 border-b border-lh-line pb-2">
              Collections
            </h3>
            <ul className="flex flex-col gap-4">
              <li>
                <Link 
                  href={createUrl("collection", null)}
                  className={`font-body text-base transition-colors ${!currentCollection ? "text-lh-primary font-semibold" : "text-lh-muted hover:text-lh-primary"}`}
                >
                  All Products
                </Link>
              </li>
              {collections.map(collection => (
                <li key={collection._id}>
                  <Link 
                    href={createUrl("collection", collection.slug)}
                    className={`font-body text-base transition-colors ${currentCollection === collection.slug ? "text-lh-primary font-semibold" : "text-lh-muted hover:text-lh-primary"}`}
                  >
                    {collection.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {Object.keys(groupedAttributes).length > 0 && (
          <div>
            <h3 className="font-label-caps text-xs tracking-widest uppercase text-lh-shadow mb-6 border-b border-lh-line pb-2">
              Refine By
            </h3>
            <div className="flex flex-col gap-6">
              {Object.entries(groupedAttributes).map(([label, values]) => (
                <div key={label}>
                  <span className="font-label-caps text-[10px] text-lh-muted block mb-2 uppercase tracking-widest">
                    {label}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {Array.from(values).map(value => {
                      const isSelected = currentAttributes.includes(value);
                      return (
                        <Link
                          key={value}
                          href={createUrl("attribute", value, true)}
                          className={`px-3 py-1 border rounded-full text-[11px] font-semibold transition-all ${
                            isSelected 
                              ? "border-lh-primary text-lh-primary bg-lh-primary-soft" 
                              : "border-lh-line text-lh-shadow hover:border-lh-light hover:bg-lh-neutral-2"
                          }`}
                        >
                          {value}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
