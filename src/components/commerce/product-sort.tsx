"use client";

import { type ReactElement } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

export function ProductSort(): ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  
  const currentSort = searchParams.get("sort") || "default";

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const params = new URLSearchParams(searchParams.toString());
    if (e.target.value === "default") {
      params.delete("sort");
    } else {
      params.set("sort", e.target.value);
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <div className="flex items-center gap-4">
      <label htmlFor="product-sort" className="font-label-caps text-[10px] text-lh-muted uppercase tracking-widest">
        Sort By:
      </label>
      <select 
        id="product-sort"
        value={currentSort}
        onChange={handleSortChange}
        className="bg-transparent border-none text-base font-semibold text-lh-shadow focus:ring-0 cursor-pointer p-0 pr-8"
      >
        <option value="default">Featured</option>
        <option value="titleAsc">Alphabetical, A-Z</option>
        <option value="priceAsc">Price, low to high</option>
        <option value="priceDesc">Price, high to low</option>
      </select>
    </div>
  );
}
