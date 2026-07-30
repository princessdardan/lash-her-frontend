import { auth } from "@/auth";
import { signInWithGoogleAction } from "@/app/admin/auth-actions";
import { AdminSubmitButton } from "@/components/admin/admin-submit-button";
import { getSafeAdminReturnTo } from "@/lib/admin/redirects";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

interface AdminSignInPageProps {
  searchParams: Promise<{
    error?: string | string[];
    returnTo?: string | string[];
  }>;
}

export default async function AdminSignInPage({
  searchParams,
}: AdminSignInPageProps) {
  const [session, params] = await Promise.all([auth(), searchParams]);
  const returnTo = getSafeAdminReturnTo(
    Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo,
  );

  if (session?.user) {
    redirect(returnTo);
  }

  const hasError =
    typeof params.error === "string" || Array.isArray(params.error);

  return (
    <main className="flex min-h-screen items-center justify-center bg-lh-neutral-2 px-6 py-12">
      <section className="w-full max-w-lg rounded-3xl border border-lh-line bg-white p-8 shadow-sm">
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Staff access
        </p>
        <h1 className="mt-3 font-heading text-4xl uppercase leading-none tracking-[0.08em] text-lh-shadow sm:text-5xl">
          Staff sign in
        </h1>
        <p className="mt-4 text-lh-muted">
          Continue with your Lash Her Google account.
        </p>
        {hasError ? (
          <p
            className="mt-5 rounded-2xl border border-lh-accent-soft bg-lh-light-soft p-4 text-sm text-lh-accent"
            role="alert"
          >
            We could not sign you in. Try again with your Lash Her Google
            account. If you still cannot access the admin, contact the business
            owner.
          </p>
        ) : null}
        <form action={signInWithGoogleAction} className="mt-7">
          <input type="hidden" name="returnTo" value={returnTo} />
          <AdminSubmitButton
            className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-lh-primary px-5 py-3 text-center text-sm font-semibold text-white transition hover:bg-lh-shadow disabled:cursor-wait disabled:opacity-60"
            pendingLabel="Signing in…"
          >
            Continue with your Lash Her Google account
          </AdminSubmitButton>
        </form>
      </section>
    </main>
  );
}
