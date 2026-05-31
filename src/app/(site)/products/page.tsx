import type { ReactElement } from "react";
import { ProductCatalogShell } from "@/components/commerce/product-catalog-shell";
import { loaders, type ProductSort } from "@/data/loaders";
import { JsonLd, buildProductCollectionJsonLd } from "@/lib/structured-data";

export const revalidate = 300;

type ProductsSearchParams = Promise<{
  sort?: string | string[];
}>;

interface ProductsPageProps {
  searchParams: ProductsSearchParams;
}

const SORT_VALUES = new Set<ProductSort>(["default", "titleAsc", "priceAsc", "priceDesc"]);

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function getSort(value: string | string[] | undefined): ProductSort {
  const sort = firstParam(value)?.trim();
  return sort && SORT_VALUES.has(sort as ProductSort) ? (sort as ProductSort) : "default";
}

export default async function ProductsPage({ searchParams }: ProductsPageProps): Promise<ReactElement> {
  const params = await searchParams;
  const sort = getSort(params.sort);

  const [pageData, products] = await Promise.all([
    loaders.getProductsPageData(),
    loaders.getProducts(sort),
  ]);
  const productCollectionJsonLd = buildProductCollectionJsonLd(products);

  return (
    <>
      {productCollectionJsonLd && (
        <JsonLd id="lash-her-product-list-json-ld" data={productCollectionJsonLd} />
      )}
      <ProductCatalogShell
        pageData={pageData}
        products={products}
        sort={sort}
      />
    </>
  );
}
