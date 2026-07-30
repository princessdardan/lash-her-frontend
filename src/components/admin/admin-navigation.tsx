"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export interface AdminNavigationItem {
  activePaths?: string[];
  href: string;
  label: string;
}

export interface AdminNavigationGroup {
  items: AdminNavigationItem[];
  label: string;
}

interface AdminNavigationProps {
  groups: AdminNavigationGroup[];
}

export function AdminDesktopNavigation({ groups }: AdminNavigationProps) {
  const pathname = usePathname();

  return (
    <nav className="mt-10 space-y-7" aria-label="Admin navigation">
      <NavigationGroups
        groups={groups}
        idPrefix="desktop"
        pathname={pathname}
      />
    </nav>
  );
}

export function AdminMobileNavigation({ groups }: AdminNavigationProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          aria-label="Open admin menu"
          className="inline-flex size-11 items-center justify-center rounded-full border border-lh-line bg-white text-lh-shadow transition hover:bg-lh-neutral-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2 lg:hidden"
          type="button"
        >
          <Menu aria-hidden="true" className="size-5" />
        </button>
      </SheetTrigger>
      <SheetContent
        className="w-[min(22rem,calc(100vw-2rem))] gap-0 overflow-y-auto p-0"
        side="left"
      >
        <SheetHeader className="border-b border-lh-line px-5 py-6 pr-14 text-left">
          <SheetTitle className="text-3xl uppercase tracking-[0.08em] text-lh-primary">
            Lash Her Admin
          </SheetTitle>
          <SheetDescription>Choose an admin workspace.</SheetDescription>
        </SheetHeader>
        <nav
          className="space-y-7 px-4 py-6"
          aria-label="Mobile admin navigation"
        >
          <NavigationGroups
            groups={groups}
            idPrefix="mobile"
            pathname={pathname}
            onNavigate={() => setOpen(false)}
          />
        </nav>
      </SheetContent>
    </Sheet>
  );
}

function NavigationGroups({
  groups,
  idPrefix,
  onNavigate,
  pathname,
}: AdminNavigationProps & {
  idPrefix: string;
  onNavigate?: () => void;
  pathname: string;
}) {
  return groups.map((group, groupIndex) => {
    const headingId = `${idPrefix}-admin-navigation-group-${groupIndex}`;

    return (
      <section aria-labelledby={headingId} key={group.label}>
        <h2
          className="px-3 text-xs font-semibold uppercase tracking-[0.16em] text-lh-muted"
          id={headingId}
        >
          {group.label}
        </h2>
        <ul className="mt-2 space-y-1">
          {group.items.map((item) => {
            const active = [item.href, ...(item.activePaths ?? [])].some(
              (activePath) => isActiveAdminPath(pathname, activePath),
            );

            return (
              <li key={item.href}>
                <Link
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-11 items-center rounded-xl border-l-4 px-3 py-2 text-sm font-medium transition",
                    active
                      ? "border-lh-primary bg-lh-primary-soft text-lh-primary"
                      : "border-transparent text-lh-shadow hover:bg-lh-neutral-2",
                  )}
                  href={item.href}
                  onClick={onNavigate}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    );
  });
}

export function isActiveAdminPath(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
