import { createHash } from "node:crypto";

import { PRODUCT_SHIPPED_REFUND_POLICY } from "@/lib/shipping/product-shipping-config";

/**
 * The shipped-order (automated_shipping) cancellation/refund policy the checkout
 * must present and order creation must re-validate, in the same shape as the
 * Terms requirement in `product-checkout-terms.ts`. Manual pickup uses its own
 * policy (see `product-manual-checkout-config.ts`); this is the counterpart for
 * shipped orders so every product checkout path presents a versioned, provable
 * refund policy (Ontario Reg. 17/05 / consumer-protection disclosure).
 *
 * The hash is computed from the trimmed `text` so the client can echo it without
 * ever authoring the canonical value.
 */
export interface ShippedRefundPolicyRequirement {
  version: string;
  text: string;
  textHash: string;
}

export function getShippedRefundPolicyRequirement(): ShippedRefundPolicyRequirement {
  const text = PRODUCT_SHIPPED_REFUND_POLICY.text.trim();
  return {
    version: PRODUCT_SHIPPED_REFUND_POLICY.version,
    text,
    textHash: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}
