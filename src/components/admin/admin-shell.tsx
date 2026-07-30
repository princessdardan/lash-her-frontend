import Link from "next/link";
import type { ReactNode } from "react";

import { signOutAdminAction } from "@/app/admin/auth-actions";
import {
  AdminDesktopNavigation,
  AdminMobileNavigation,
  type AdminNavigationGroup,
} from "@/components/admin/admin-navigation";
import { AdminSubmitButton } from "@/components/admin/admin-submit-button";
import { canAdmin, type AdminPermissionAction } from "@/lib/admin/permissions";
import { getAdminRoleLabel } from "@/lib/admin/presentation";
import type { AdminActor } from "@/lib/admin/types";

interface AdminNavigationDefinition {
  action: AdminPermissionAction;
  activePaths?: readonly string[];
  href: string;
  label: string;
  roles?: readonly AdminActor["user"]["role"][];
}

const navGroups: Array<{
  items: AdminNavigationDefinition[];
  label: string;
}> = [
  {
    label: "Daily work",
    items: [
      { action: "admin:view", href: "/admin", label: "Today" },
      {
        action: "bookings:view",
        href: "/admin/appointments",
        label: "Appointments",
      },
      {
        action: "calendar-connections:self-manage",
        href: "/admin/my-calendar",
        label: "My availability",
        roles: ["employee"],
      },
      { action: "payments:view", href: "/admin/orders", label: "Orders" },
      { action: "payments:view", href: "/admin/training", label: "Training" },
      { action: "payments:view", href: "/admin/payments", label: "Payments" },
      {
        action: "payments:view",
        href: "/admin/booking-issues",
        label: "Booking issues",
      },
      {
        action: "marketing:view",
        href: "/admin/inquiries",
        label: "Inquiries",
      },
    ],
  },
  {
    label: "Manage business",
    items: [
      {
        action: "schedules:view",
        href: "/admin/schedules",
        label: "Availability",
      },
      {
        action: "offerings:view",
        href: "/admin/offerings",
        label: "Services & pricing",
      },
      {
        action: "service-promotions:view",
        href: "/admin/service-promotions",
        label: "Service promotions",
      },
      { action: "staff:view", href: "/admin/staff", label: "Team" },
    ],
  },
  {
    label: "Insights",
    items: [
      {
        action: "marketing:view",
        href: "/admin/marketing",
        label: "Marketing",
      },
      { action: "analytics:view", href: "/admin/analytics", label: "Reports" },
    ],
  },
  {
    label: "Settings",
    items: [
      { action: "setup:view", href: "/admin/setup", label: "Booking health" },
      {
        action: "setup:view",
        href: "/admin/booking-settings",
        label: "Booking settings",
      },
      {
        action: "calendar-connections:view",
        activePaths: ["/admin/calendar-connections"],
        href: "/admin/integrations",
        label: "Integrations",
      },
      {
        action: "audit:view",
        href: "/admin/audit",
        label: "Activity history",
      },
    ],
  },
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
  const permissionContext = {
    bookingProviderResourceIds: actor.bookingProviderResourceIds,
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  };
  const visibleNavGroups: AdminNavigationGroup[] = navGroups
    .map((group) => ({
      label: group.label,
      items: group.items
        .filter(
          (item) =>
            (item.roles === undefined ||
              item.roles.includes(actor.user.role)) &&
            canAdmin({ action: item.action, ...permissionContext }),
        )
        .map(({ activePaths, href, label }) => ({
          activePaths: activePaths ? [...activePaths] : undefined,
          href,
          label,
        })),
    }))
    .filter((group) => group.items.length > 0);
  const environmentWarning =
    environmentLabel === "production"
      ? null
      : environmentLabel === "unknown"
        ? "Site environment could not be verified. Confirm before making changes."
        : "Test site—changes do not affect the live site.";

  return (
    <div className="min-h-screen bg-lh-neutral-2 text-lh-shadow">
      <a
        className="fixed left-4 top-4 z-[100] -translate-y-24 rounded-full bg-lh-shadow px-5 py-3 text-sm font-semibold text-white shadow-lg transition-transform focus:translate-y-0"
        href="#admin-main"
      >
        Skip to main content
      </a>
      <div className="mx-auto flex min-h-screen max-w-[1500px]">
        <aside className="hidden w-72 shrink-0 border-r border-lh-line bg-white px-6 py-8 lg:block">
          <Link
            href="/admin"
            className="inline-flex min-h-11 items-center font-heading text-4xl uppercase tracking-[0.08em] text-lh-primary"
          >
            Lash Her Admin
          </Link>
          <AdminDesktopNavigation groups={visibleNavGroups} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          {environmentWarning ? (
            <div
              className="border-b border-lh-light bg-lh-light-soft px-5 py-2 text-center text-sm font-semibold text-lh-accent md:px-8"
              role="status"
            >
              {environmentWarning}
            </div>
          ) : null}
          <header className="sticky top-0 z-30 border-b border-lh-line bg-white/95 px-5 py-3 backdrop-blur md:px-8">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <AdminMobileNavigation groups={visibleNavGroups} />
                <Link
                  className="truncate font-heading text-2xl uppercase tracking-[0.08em] text-lh-primary lg:hidden"
                  href="/admin"
                >
                  Lash Her Admin
                </Link>
              </div>
              <details className="group relative">
                <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-full border border-lh-line px-4 py-2 text-sm font-semibold text-lh-shadow transition hover:bg-lh-neutral-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
                  Account
                  <span
                    aria-hidden="true"
                    className="ml-2 transition-transform group-open:rotate-180"
                  >
                    ↓
                  </span>
                </summary>
                <div className="absolute right-0 z-40 mt-2 w-[min(20rem,calc(100vw-2.5rem))] rounded-2xl border border-lh-line bg-white p-4 shadow-xl">
                  <p className="truncate font-semibold">
                    {actor.user.displayName ?? actor.user.email}
                  </p>
                  {actor.user.displayName ? (
                    <p className="mt-1 truncate text-sm text-lh-muted">
                      {actor.user.email}
                    </p>
                  ) : null}
                  <p className="mt-2 text-xs font-semibold uppercase tracking-[0.14em] text-lh-muted">
                    {getAdminRoleLabel(actor.user.role)}
                  </p>
                  <form action={signOutAdminAction} className="mt-4">
                    <AdminSubmitButton
                      className="inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-lh-line px-4 py-2 text-sm font-semibold text-lh-shadow transition hover:bg-lh-neutral-2 disabled:cursor-wait disabled:opacity-60"
                      pendingLabel="Signing out…"
                    >
                      Sign out
                    </AdminSubmitButton>
                  </form>
                </div>
              </details>
            </div>
          </header>
          <main
            className="flex-1 px-5 py-8 outline-none md:px-8"
            id="admin-main"
            tabIndex={-1}
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
