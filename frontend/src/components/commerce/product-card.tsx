"use client";

import type { ReactElement } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SanityImage } from "@/components/ui/sanity-image";
import { formatCad } from "@/lib/commerce/money";
import type { TSellableProduct } from "@/types";

interface ProductCardProps {
  product: TSellableProduct;
  onAdd: (product: TSellableProduct) => void;
}

export function ProductCard({ product, onAdd }: ProductCardProps): ReactElement {
  const productHref = `/products/${product.slug}`;

  return (
    <article className="card-white flex flex-col h-full">
      {product.image && (
        <Link
          href={productHref}
          className="relative w-full aspect-square mb-4 overflow-hidden rounded-md bg-lh-neutral-2 block"
          aria-label={`View ${product.title}`}
        >
          <SanityImage
            image={product.image}
            alt={product.title}
            fill
            className="object-cover"
          />
        </Link>
      )}
      <div className="flex-1 flex flex-col">
        <div className="text-xs font-bold uppercase tracking-wider text-lh-primary mb-1">
          {product.kind}
        </div>
        <h3 className="card-heading-red text-xl mb-2">
          <Link href={productHref} className="hover:underline">
            {product.title}
          </Link>
        </h3>
        <p className="text-sm text-black font-light mb-4 flex-1">
          {product.shortDescription || product.description}
        </p>

        {product.availabilityLabel && product.isAvailable && (
          <p className="text-xs font-bold text-lh-primary mb-2">
            {product.availabilityLabel}
          </p>
        )}

        {product.fulfillmentNote && (
          <p className="text-xs text-lh-muted italic mb-4">
            {product.fulfillmentNote}
          </p>
        )}

        <div className="flex items-center justify-between mt-auto pt-4 border-t border-lh-line">
          <span className="font-bold text-lg text-black">
            {formatCad(product.price)}
          </span>
          <Button
            onClick={() => onAdd(product)}
            disabled={!product.isAvailable}
            className="btn-primary-red w-auto px-6"
          >
            {product.isAvailable ? "Add to Cart" : (product.availabilityLabel || "Sold Out")}
          </Button>
        </div>
      </div>
    </article>
  );
}
