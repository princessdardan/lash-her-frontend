import type { Metadata } from "next";
import Link from "next/link";
import { CustomerSignInForm } from "@/components/customer-auth/sign-in-form";
import { resolveCustomerAuthConfiguration, safeCustomerReturn } from "@/lib/customer-auth/policy";

export const metadata: Metadata = { title: "Sign in | LASH HER", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function CustomerSignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const configuration = resolveCustomerAuthConfiguration();
  const returnTo = typeof query.callbackUrl === "string" && configuration ? safeCustomerReturn(query.callbackUrl, configuration.origin) : "/academy";
  return <main className="mx-auto max-w-md px-6 py-24">
    <h1 className="mb-8 font-serif text-4xl">Sign in</h1>
    {!configuration ? <p>Customer sign-in is not available yet.</p> : <>
      {query["check-email"] === "1" && <p role="status" className="mb-6">If the address can receive a sign-in link, check your inbox. You may need to wait before requesting another link.</p>}
      {query.error && <p role="alert" className="mb-6">The sign-in could not be completed. Try a new email link. To link Google to an existing account, first sign in by email, then open your sign-in methods.</p>}
      <CustomerSignInForm returnTo={returnTo} />
      <p className="mt-8 text-sm"><Link href="/account/sign-in-methods" className="underline underline-offset-4">Manage sign-in methods</Link></p>
    </>}
  </main>;
}
