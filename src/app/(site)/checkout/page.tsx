import type { Metadata } from "next";
import { loaders } from "@/data/loaders";
import CheckoutPageClient from "./checkout-page-client";
import { isChitChatsCheckoutEnabled } from "@/lib/shipping/config";
import { loadManualProductCheckoutPolicy } from "@/lib/commerce/product-manual-checkout-config";
import { getProductCheckoutTermsRequirement } from "@/lib/commerce/product-checkout-terms";
import { getShippedRefundPolicyRequirement } from "@/lib/commerce/product-shipped-refund-policy";
import {
  calculateProductTax,
  STUDIO_PICKUP_TAX_JURISDICTION,
} from "@/lib/commerce/product-tax-policy";

export const metadata: Metadata = {
  title: "Checkout | Lash Her by Nataliea",
  description: "Complete your purchase securely.",
};

export default async function CheckoutPage() {
  const products = await loaders.getProducts();
  const manualCheckoutPolicy = await loadManualProductCheckoutPolicy();
  const termsRequirement = getProductCheckoutTermsRequirement();
  const shippedRefundPolicy = getShippedRefundPolicyRequirement();
  // In-studio pickup is fulfilled from Ontario, so the pickup tax is fixed by
  // the studio's place of supply. The server owns the rate; the client applies
  // it to the merchandise total for the summary.
  const pickupTaxQuote = calculateProductTax({
    destinationCountry: STUDIO_PICKUP_TAX_JURISDICTION.country,
    destinationRegionCode: STUDIO_PICKUP_TAX_JURISDICTION.region,
    taxableAmountCents: 0,
  });

  return (
    <CheckoutPageClient
      products={products}
      shippingEnabled={isChitChatsCheckoutEnabled()}
      manualCheckoutPolicy={manualCheckoutPolicy}
      termsRequirement={termsRequirement}
      shippedRefundPolicy={shippedRefundPolicy}
      pickupTax={{
        rate: pickupTaxQuote.taxRate,
        name: pickupTaxQuote.taxName,
      }}
    />
  );
}
