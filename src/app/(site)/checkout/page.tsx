import type { Metadata } from "next";
import { loaders } from "@/data/loaders";
import CheckoutPageClient from "./checkout-page-client";
import { isChitChatsCheckoutEnabled } from "@/lib/shipping/config";

export const metadata: Metadata = {
  title: "Checkout | Lash Her by Nataliea",
  description: "Complete your purchase securely.",
};

export default async function CheckoutPage() {
  const products = await loaders.getProducts();

  return (
    <CheckoutPageClient
      products={products}
      shippingEnabled={isChitChatsCheckoutEnabled()}
    />
  );
}
