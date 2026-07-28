import Link from "next/link";
import type { ReactNode } from "react";

import { signOutAdminAction } from "@/app/admin/auth-actions";
import { canAdmin, type AdminPermissionAction } from "@/lib/admin/permissions";
import type { AdminActor } from "@/lib/admin/types";

const navItems: Array<{
  action: AdminPermissionAction;
  href: string;
  label: string;
  roles?: AdminActor["user"]["role"][];
}> = [
  { action: "admin:view", href: "/admin", label: "Overview" },
  { action: "offerings:view", href: "/admin/setup", label: "Setup" },
  { action: "staff:view", href: "/admin/staff", label: "Staff & resources" },
  { action: "offerings:view", href: "/admin/offerings", label: "Offerings" },
  { action: "schedules:view", href: "/admin/schedules", label: "Schedules" },
  {
    action: "calendar-connections:view",
    href: "/admin/calendar-connections",
    label: "Calendars",
  },
  {
    action: "calendar-connections:self-manage",
    href: "/admin/my-calendar",
    label: "My Calendar",
    roles: ["employee"],
  },
  {
    action: "bookings:view",
    href: "/admin/appointments",
    label: "Appointments",
  },
  { action: "marketing:view", href: "/admin/marketing", label: "Marketing" },
  { action: "analytics:view", href: "/admin/analytics", label: "Analytics" },
  { action: "audit:view", href: "/admin/audit", label: "Audit log" },
];

interface AdminShellProps {
  actor: AdminActor;
  children: ReactNode;
  environmentLabel: string;
}

export function AdminShell({
  actor,
  children,
  environmentLabel,
}: AdminShellProps) {
  const visibleNavItems = navItems.filter(
    (item) =>
      (item.roles === undefined || item.roles.includes(actor.user.role)) &&
      canAdmin({
        action: item.action,
        bookingProviderResourceIds: actor.bookingProviderResourceIds,
        bookingResourceIds: actor.bookingResourceIds,
        role: actor.user.role,
      }),
  );

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
                className="block rounded-xl px-3 py-2 text-sm font-medium transition hover:bg-lh-neutral-2"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-lh-line bg-white px-5 py-4 md:px-8">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm uppercase tracking-[0.14em] text-lh-muted">
                  {environmentLabel}
                </p>
                <p className="mt-1 font-semibold">{actor.user.email}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="rounded-full border border-lh-line px-4 py-2 text-sm uppercase tracking-[0.14em] text-lh-muted">
                  {actor.user.role}
                </span>
                <form action={signOutAdminAction}>
                  <button
                    type="submit"
                    className="rounded-full border border-lh-line px-4 py-2 text-sm font-semibold transition hover:bg-lh-neutral-2"
                  >
                    Sign out
                  </button>
                </form>
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
