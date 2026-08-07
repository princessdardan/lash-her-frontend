import Link from "next/link";
import type { ReactNode } from "react";

import { academyDashboardUrl } from "@/lib/academy/urls";

export function AcademyShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-lh-neutral-2 text-lh-shadow">
      <header className="border-b border-lh-line bg-white/95">
        <div className="mx-auto flex min-h-20 max-w-6xl items-center justify-between px-6 py-4 lg:px-8">
          <Link
            className="font-heading text-2xl uppercase tracking-[0.12em] text-lh-shadow"
            href={academyDashboardUrl()}
          >
            Lash Her Academy
          </Link>
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-lh-muted">
            Student learning space
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-6 py-10 lg:px-8 lg:py-14">
        {children}
      </main>
    </div>
  );
}
