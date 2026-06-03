import Link from "next/link";
import type { ReactNode } from "react";

import type { AdminActor } from "@/lib/admin/types";

const navItems = [
  { href: "/admin", label: "Command Center" },
  { href: "/admin/revenue", label: "Revenue" },
  { href: "/admin/orders", label: "Products / Orders" },
  { href: "/admin/bookings", label: "Services / Bookings" },
  { href: "/admin/training", label: "Training" },
  { href: "/admin/marketing", label: "Marketing" },
  { href: "/admin/privacy", label: "Privacy Requests" },
  { href: "/admin/audit", label: "Audit Log", ownerOnly: true },
];

interface AdminShellProps {
  actor: AdminActor;
  children: ReactNode;
  environmentLabel: string;
}

export function AdminShell({ actor, children, environmentLabel }: AdminShellProps) {
  const visibleNavItems = navItems.filter((item) => !item.ownerOnly || actor.user.role === "owner");

  return (
    <div className="min-h-screen bg-lh-neutral-2 text-lh-shadow">
      <div className="mx-auto flex min-h-screen max-w-[1500px]">
        <aside className="hidden w-72 shrink-0 border-r border-lh-line bg-white px-6 py-8 lg:block">
          <Link
            href="/admin"
            className="font-heading text-4xl uppercase tracking-[0.08em] text-lh-primary"
          >
            Lash Her Admin
          </Link>
          <nav className="mt-10 space-y-1" aria-label="Admin navigation">
            {visibleNavItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="block rounded-xl px-3 py-2 text-sm font-medium text-lh-shadow transition hover:bg-lh-neutral-2"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-lh-line bg-white px-5 py-4 md:px-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm text-lh-muted">{environmentLabel}</p>
                <p className="font-semibold">{actor.user.email}</p>
              </div>
              <div className="rounded-full border border-lh-line px-4 py-2 text-sm uppercase tracking-[0.14em] text-lh-muted">
                {actor.user.role}
              </div>
            </div>
            <nav
              className="mt-4 flex gap-2 overflow-x-auto pb-1 lg:hidden"
              aria-label="Admin navigation"
            >
              {visibleNavItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="shrink-0 rounded-full border border-lh-line px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted transition hover:bg-lh-neutral-2 hover:text-lh-shadow"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </header>
          <main className="flex-1 px-5 py-8 md:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
