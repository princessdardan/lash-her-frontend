import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface AdminCardProps {
  children?: ReactNode;
  className?: string;
  href?: string;
  label: string;
  value: ReactNode;
  valueClassName?: string;
}

export function AdminCard({
  children,
  className,
  href,
  label,
  value,
  valueClassName,
}: AdminCardProps) {
  const content = (
    <>
      <p className="font-smallcaps text-sm uppercase tracking-[0.18em] text-lh-muted">
        {label}
      </p>
      <div
        className={cn(
          "mt-2 text-2xl font-semibold text-lh-shadow sm:text-3xl",
          valueClassName,
        )}
      >
        {value}
      </div>
      {children ? (
        <div className="mt-3 text-sm text-lh-muted">{children}</div>
      ) : null}
    </>
  );

  if (href) {
    return (
      <Link
        className={cn(
          "group block h-full rounded-2xl border border-lh-line bg-white p-5 shadow-sm transition hover:border-lh-primary hover:bg-lh-neutral-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2",
          className,
        )}
        href={href}
      >
        {content}
        <span className="mt-4 inline-flex text-sm font-semibold text-lh-primary underline-offset-4 group-hover:underline">
          View records
        </span>
      </Link>
    );
  }

  return (
    <div
      className={cn(
        "rounded-2xl border border-lh-line bg-white p-5 shadow-sm",
        className,
      )}
    >
      {content}
    </div>
  );
}
