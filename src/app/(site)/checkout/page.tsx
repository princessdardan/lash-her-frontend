import type { Metadata } from "next";
import { loaders } from "@/data/loaders";
import CheckoutPageClient from "./checkout-page-client";
import { isChitChatsCheckoutEnabled } from "@/lib/shipping/config";
import { loadManualProductCheckoutPolicy } from "@/lib/commerce/product-manual-checkout-config";

export const metadata: Metadata = {
  title: "Checkout | Lash Her by Nataliea",
  description: "Complete your purchase securely.",
};

export default async function CheckoutPage() {
  const products = await loaders.getProducts();
  const manualCheckoutPolicy = await loadManualProductCheckoutPolicy();

  return (
    <CheckoutPageClient
      products={products}
      shippingEnabled={isChitChatsCheckoutEnabled()}
      manualCheckoutPolicy={manualCheckoutPolicy}
    />
  );
}
