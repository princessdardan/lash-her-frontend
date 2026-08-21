"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { TSanityImage } from "@/types";

interface ProductGalleryContextValue {
  readonly activeVariantImage: TSanityImage | null;
  readonly setActiveVariantImage: (image: TSanityImage | null) => void;
}

const NOOP_CONTEXT: ProductGalleryContextValue = {
  activeVariantImage: null,
  setActiveVariantImage: () => {},
};

const ProductGalleryContext =
  createContext<ProductGalleryContextValue>(NOOP_CONTEXT);

/**
 * Shares the currently selected variant's image between the purchase controls
 * (which own variant selection) and the gallery hero (which renders it). Absent
 * a provider the hook degrades to a no-op so either consumer can render alone.
 */
export function ProductGalleryProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  const [activeVariantImage, setActiveVariantImage] =
    useState<TSanityImage | null>(null);
  const value = useMemo(
    () => ({ activeVariantImage, setActiveVariantImage }),
    [activeVariantImage],
  );

  return (
    <ProductGalleryContext.Provider value={value}>
      {children}
    </ProductGalleryContext.Provider>
  );
}

export function useProductGallery(): ProductGalleryContextValue {
  return useContext(ProductGalleryContext);
}
