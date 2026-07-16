import { auth } from "@/auth";
import { signInWithGoogleAction } from "@/app/admin/auth-actions";
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

  const hasError = typeof params.error === "string" || Array.isArray(params.error);

  return (
    <main className="flex min-h-screen items-center justify-center bg-lh-neutral-2 px-6 py-12">
      <section className="w-full max-w-lg rounded-3xl border border-lh-line bg-white p-8 shadow-sm">
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Private operations
        </p>
        <h1 className="mt-3 font-heading text-5xl uppercase tracking-[0.08em] text-lh-shadow">
          Admin sign in
        </h1>
        <p className="mt-4 text-lh-muted">
          Continue with the verified Google account assigned to your Lash Her staff profile.
        </p>
        {hasError ? (
          <p className="mt-5 rounded-2xl border border-lh-accent-soft bg-lh-light-soft p-4 text-sm text-lh-accent" role="alert">
            Google could not verify this sign-in. Use the approved account or contact the owner.
          </p>
        ) : null}
        <form action={signInWithGoogleAction} className="mt-7">
          <input type="hidden" name="returnTo" value={returnTo} />
          <button
            type="submit"
            className="inline-flex w-full items-center justify-center rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-lh-shadow"
          >
            Continue with Google
          </button>
        </form>
        <p className="mt-5 text-xs leading-5 text-lh-muted">
          This sign-in requests identity information only. Booking-calendar authorization is managed separately by the owner.
        </p>
      </section>
    </main>
  );
}
