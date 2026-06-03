export default function AdminNotAuthorizedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-lh-neutral-2 px-6">
      <section className="max-w-xl rounded-3xl border border-lh-line bg-white p-8 text-center shadow-sm">
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Admin access
        </p>
        <h1 className="mt-3 font-heading text-5xl uppercase tracking-[0.08em] text-lh-shadow">
          Not authorized
        </h1>
        <p className="mt-4 text-lh-muted">
          This account is signed in but is not approved for Lash Her admin access. Ask the owner to
          review the admin allowlist.
        </p>
      </section>
    </main>
  );
}
