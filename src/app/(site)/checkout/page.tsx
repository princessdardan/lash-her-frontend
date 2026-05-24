import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import CheckoutPageClient from "./checkout-page-client";

export const metadata: Metadata = {
  title: "Checkout | Lash Her by Nataliea",
  description: "Complete your purchase securely.",
};

export default async function CheckoutPage() {
  const products = await loaders.getProducts();

  if (!products || products.length === 0) {
    notFound();
  }

  return <CheckoutPageClient products={products} />;
}
