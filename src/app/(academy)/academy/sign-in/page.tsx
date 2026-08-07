import { notFound, redirect } from "next/navigation";

import { auth } from "@/auth";
import { getAcademyPrincipal } from "@/lib/academy/auth";
import { getAcademyConfig } from "@/lib/academy/config";
import { getSafeAcademyReturnTo } from "@/lib/academy/urls";
import { isActiveCustomerUser } from "@/lib/customer-identity/status";
import { signInToAcademyAction } from "./actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AcademySignInPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    returnTo?: string | string[];
  }>;
}) {
  if (!getAcademyConfig().enabled) notFound();
  const [session, params] = await Promise.all([auth(), searchParams]);
  const returnTo = getSafeAcademyReturnTo(params.returnTo);
  const principal = getAcademyPrincipal(session);
  const isActive =
    principal !== null && (await isActiveCustomerUser(principal.userId));
  if (isActive) redirect(returnTo);

  const hasError = params.error !== undefined || principal !== null;
  return (
    <section className="mx-auto max-w-lg rounded-3xl border border-lh-line bg-white p-8 shadow-sm sm:p-10">
      <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-primary">
        Student access
      </p>
      <h1 className="mt-3 font-heading text-5xl uppercase leading-none tracking-[0.07em]">
        Sign in to learn
      </h1>
      <p className="mt-5 leading-7 text-lh-muted">
        Continue with the verified email address associated with your student
        account.
      </p>
      {hasError ? (
        <p
          className="mt-5 rounded-2xl border border-lh-accent-soft bg-lh-light-soft p-4 text-sm text-lh-accent"
          role="alert"
        >
          Sign-in could not be completed. Use a verified account and try again.
        </p>
      ) : null}
      <form action={signInToAcademyAction} className="mt-7">
        <input name="returnTo" type="hidden" value={returnTo} />
        <button
          className="min-h-11 w-full rounded-full bg-lh-primary px-6 py-3 text-sm font-semibold text-white transition hover:bg-lh-shadow"
          type="submit"
        >
          Continue with Google
        </button>
      </form>
    </section>
  );
}
