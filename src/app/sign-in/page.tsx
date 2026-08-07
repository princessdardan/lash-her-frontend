import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { follow: false, index: false },
};

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-lh-neutral-2 px-6 py-12 text-lh-shadow">
      <section className="w-full max-w-lg rounded-3xl border border-lh-line bg-white p-8 shadow-sm sm:p-10">
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-primary">
          Secure access
        </p>
        <h1 className="mt-3 font-heading text-5xl uppercase leading-none tracking-[0.07em]">
          Sign-in unavailable
        </h1>
        <p className="mt-5 leading-7 text-lh-muted">
          The sign-in attempt could not be completed. Return to the access area
          you intended to use and start again.
        </p>
        <div className="mt-7 grid gap-3 sm:grid-cols-2">
          <Link
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold text-white transition hover:bg-lh-shadow"
            href="/academy/sign-in"
          >
            Student academy
          </Link>
          <Link
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-lh-line px-5 py-3 text-sm font-semibold text-lh-shadow transition hover:border-lh-primary/40"
            href="/admin/sign-in"
          >
            Staff access
          </Link>
        </div>
      </section>
    </main>
  );
}
