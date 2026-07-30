import { auth } from "@/auth";
import { signOutAdminAction } from "@/app/admin/auth-actions";
import { AdminSubmitButton } from "@/components/admin/admin-submit-button";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AdminNotAuthorizedPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/admin/sign-in");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-lh-neutral-2 px-6 py-12">
      <section className="w-full max-w-xl rounded-3xl border border-lh-line bg-white p-8 text-center shadow-sm">
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Staff access
        </p>
        <h1 className="mt-3 font-heading text-4xl uppercase leading-none tracking-[0.08em] text-lh-shadow sm:text-5xl">
          This account does not have access
        </h1>
        <p className="mt-4 text-lh-muted">
          Ask the business owner to add or restore your staff access.
        </p>
        {session.user.email ? (
          <p className="mt-3 break-all text-sm text-lh-muted">
            Signed in as {session.user.email}
          </p>
        ) : null}
        <form action={signOutAdminAction} className="mx-auto mt-7 max-w-xs">
          <AdminSubmitButton
            className="inline-flex min-h-11 w-full items-center justify-center rounded-full border border-lh-line px-5 py-3 text-sm font-semibold text-lh-shadow transition hover:bg-lh-neutral-2 disabled:cursor-wait disabled:opacity-60"
            pendingLabel="Signing out…"
          >
            Sign out and try another account
          </AdminSubmitButton>
        </form>
      </section>
    </main>
  );
}
