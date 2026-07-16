import type { ReactNode } from "react";

interface AdminTableProps {
  caption: string;
  children: ReactNode;
}

export function AdminTable({ caption, children }: AdminTableProps) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-lh-line bg-white">
      <table className="w-full min-w-[760px] border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}
