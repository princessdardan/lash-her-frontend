import type { ReactNode } from "react";

interface AdminCardProps {
  children?: ReactNode;
  label: string;
  value: ReactNode;
}

export function AdminCard({ children, label, value }: AdminCardProps) {
  return (
    <section className="rounded-2xl border border-lh-line bg-white p-5 shadow-sm">
      <p className="font-smallcaps text-sm uppercase tracking-[0.18em] text-lh-muted">
        {label}
      </p>
      <div className="mt-2 text-3xl font-semibold text-lh-shadow">{value}</div>
      {children ? <div className="mt-3 text-sm text-lh-muted">{children}</div> : null}
    </section>
  );
}
