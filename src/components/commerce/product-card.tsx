"use client";

import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { SanityImage } from "@/components/ui/sanity-image";
import { formatCad } from "@/lib/commerce/money";
import type { TSellableProduct } from "@/types";

interface ProductCardProps {
  product: TSellableProduct;
  onAdd: (product: TSellableProduct) => void;
}

export function ProductCard({ product, onAdd }: ProductCardProps): ReactElement {
  return (
    <div className="card-white flex flex-col h-full">
      {product.image && (
        <div className="relative w-full aspect-square mb-4 overflow-hidden rounded-md bg-brand-cream">
          <SanityImage
            image={product.image}
            alt={product.title}
            fill
            className="object-cover"
          />
        </div>
      )}
      <div className="flex-1 flex flex-col">
        <div className="text-xs font-bold uppercase tracking-wider text-brand-red mb-1">
          {product.kind}
        </div>
        <h3 className="card-heading-red text-xl mb-2">{product.title}</h3>
        <p className="text-sm text-black font-light mb-4 flex-1">
          {product.description}
        </p>
        <div className="flex items-center justify-between mt-auto pt-4 border-t border-brand-pink">
          <span className="font-bold text-lg text-black">
            {formatCad(product.price)}
          </span>
          <Button
            onClick={() => onAdd(product)}
            disabled={!product.isAvailable}
            className="btn-primary-red w-auto px-6"
          >
            {product.isAvailable ? "Add to Cart" : "Sold Out"}
          </Button>
        </div>
      </div>
    </div>
  );
}
