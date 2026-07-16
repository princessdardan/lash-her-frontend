import { auth } from "@/auth";
import { signOutAdminAction } from "@/app/admin/auth-actions";
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
          Admin access
        </p>
        <h1 className="mt-3 font-heading text-5xl uppercase tracking-[0.08em] text-lh-shadow">
          Not authorized
        </h1>
        <p className="mt-4 text-lh-muted">
          This verified Google identity does not have an active Lash Her admin profile or the required permission.
        </p>
        <form action={signOutAdminAction} className="mt-7">
          <button
            type="submit"
            className="rounded-full border border-lh-line px-5 py-3 text-sm font-semibold uppercase tracking-[0.14em] text-lh-shadow transition hover:bg-lh-neutral-2"
          >
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}
