import { type ReactElement } from "react";
import type { ProductSort as ProductSortValue } from "@/data/loaders";

interface ProductSortProps {
  sort: ProductSortValue;
}

const SORT_OPTIONS = [
  { value: "default", label: "Featured" },
  { value: "titleAsc", label: "Alphabetical, A-Z" },
  { value: "priceAsc", label: "Price, low to high" },
  { value: "priceDesc", label: "Price, high to low" },
] as const;

export function ProductSort({ sort }: ProductSortProps): ReactElement {
  return (
    <form action="/products" className="flex flex-col gap-3 sm:flex-row sm:items-center" aria-label="Sort products">
      <label htmlFor="product-sort" className="font-heading text-[11px] font-normal uppercase tracking-[0.28em] text-lh-muted">
        Sort By
      </label>
      <div className="flex items-center gap-2">
        <select id="product-sort" name="sort" defaultValue={sort} className="form-input h-10 min-w-48 rounded-full bg-lh-white pr-9 text-sm">
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-full border border-lh-line px-4 py-2 font-body text-xs font-bold uppercase tracking-[0.12em] text-lh-shadow transition-colors hover:border-lh-primary hover:text-lh-primary"
        >
          Apply
        </button>
      </div>
    </form>
  );
}
