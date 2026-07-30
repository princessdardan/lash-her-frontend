import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface AdminTableProps {
  caption: string;
  children: ReactNode;
  className?: string;
  minimumWidth?: "content" | "financial" | "none" | "standard";
  showCaption?: boolean;
  stickyFirstColumn?: boolean;
  tableClassName?: string;
}

const minimumWidthClasses = {
  content: "min-w-max",
  financial: "min-w-[1040px]",
  none: "min-w-full",
  standard: "min-w-[760px]",
} satisfies Record<NonNullable<AdminTableProps["minimumWidth"]>, string>;

export function AdminTable({
  caption,
  children,
  className,
  minimumWidth = "none",
  showCaption = false,
  stickyFirstColumn = false,
  tableClassName,
}: AdminTableProps) {
  return (
    <div
      aria-label={caption}
      className={cn(
        "overflow-x-auto rounded-2xl border border-lh-line bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2",
        className,
      )}
      role="region"
      tabIndex={0}
    >
      <table
        className={cn(
          "w-full border-collapse text-left text-sm",
          minimumWidthClasses[minimumWidth],
          stickyFirstColumn &&
            "[&_tr>*:first-child]:sticky [&_tr>*:first-child]:left-0 [&_tr>*:first-child]:z-10 [&_thead_tr>*:first-child]:bg-lh-neutral-2 [&_tbody_tr>*:first-child]:bg-white",
          tableClassName,
        )}
      >
        <caption
          className={
            showCaption
              ? "caption-top border-b border-lh-line px-4 py-3 text-left font-semibold text-lh-shadow"
              : "sr-only"
          }
        >
          {caption}
        </caption>
        {children}
      </table>
    </div>
  );
}
