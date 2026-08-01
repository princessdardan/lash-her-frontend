import type { ComponentProps, ReactNode } from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";

interface AdminTabLinkProps {
  active: boolean;
  children: ReactNode;
  className?: string;
  href: ComponentProps<typeof Link>["href"];
}

export function AdminTabLink({
  active,
  children,
  className,
  href,
}: AdminTabLinkProps) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={adminTabLinkClassName(active, className)}
      href={href}
    >
      {children}
    </Link>
  );
}

export function adminTabLinkClassName(
  active: boolean,
  className?: string,
): string {
  return cn(
    "inline-flex min-h-11 items-center rounded-full border px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2",
    active
      ? "border-lh-primary bg-lh-primary-soft text-lh-primary shadow-sm"
      : "border-lh-line bg-white text-lh-shadow hover:border-lh-primary hover:bg-lh-neutral-2",
    className,
  );
}
