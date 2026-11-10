import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CustomerSignInForm } from "@/components/customer-auth/sign-in-form";
import { getCustomerActor } from "@/lib/customer-auth/session";

export const metadata: Metadata = { title: "Sign-in methods | LASH HER", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function CustomerSignInMethodsPage() {
  const customer = await getCustomerActor();
  if (!customer) redirect("/sign-in?callbackUrl=%2Faccount%2Fsign-in-methods");
  return <main className="mx-auto max-w-md px-6 py-24">
    <h1 className="mb-6 font-serif text-4xl">Sign-in methods</h1>
    <p className="mb-8">Signed in as {customer.email}. Link Google by completing Google&apos;s verification while signed in to this account.</p>
    <CustomerSignInForm returnTo="/account/sign-in-methods" signedIn />
  </main>;
}
