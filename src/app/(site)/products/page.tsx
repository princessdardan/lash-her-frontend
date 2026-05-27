import type { ReactElement } from "react";
import { ProductCatalogShell } from "@/components/commerce/product-catalog-shell";
import { loaders, type ProductSort } from "@/data/loaders";

export const revalidate = 300;

type ProductsSearchParams = Promise<{
  collection?: string | string[];
  attribute?: string | string[];
  sort?: string | string[];
  page?: string | string[];
}>;

interface ProductsPageProps {
  searchParams: ProductsSearchParams;
}

const SORT_VALUES = new Set<ProductSort>(["default", "titleAsc", "priceAsc", "priceDesc"]);

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function allParams(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((item) => item.trim()).filter(Boolean);
}

function getSort(value: string | string[] | undefined): ProductSort {
  const sort = firstParam(value)?.trim();
  return sort && SORT_VALUES.has(sort as ProductSort) ? (sort as ProductSort) : "default";
}

export default async function ProductsPage({ searchParams }: ProductsPageProps): Promise<ReactElement> {
  const params = await searchParams;
  const collection = firstParam(params.collection)?.trim() || undefined;
  const attributes = allParams(params.attribute);
  const sort = getSort(params.sort);
  const page = firstParam(params.page)?.trim() || undefined;

  const [pageData, collections, filterAttributes, products] = await Promise.all([
    loaders.getProductsPageData(),
    loaders.getProductsPageCollections(),
    loaders.getProductFilterAttributes(),
    loaders.getProducts({ collection, attributes, sort }),
  ]);

  return (
    <ProductCatalogShell
      pageData={pageData}
      collections={collections}
      filterAttributes={filterAttributes}
      products={products}
      query={{ collection, attributes, sort, page }}
    />
  );
}
