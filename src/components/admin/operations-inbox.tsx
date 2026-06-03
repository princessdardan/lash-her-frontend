import Link from "next/link";

import type { OperationsInboxItem } from "@/lib/admin/read-models";

import { StatusPill } from "./status-pill";

interface OperationsInboxProps {
  items: OperationsInboxItem[];
}

export function OperationsInbox({ items }: OperationsInboxProps) {
  if (items.length === 0) {
    return (
      <section className="rounded-2xl border border-lh-line bg-white p-6">
        <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">
          Operations inbox
        </h2>
        <p className="mt-3 text-lh-muted">No urgent operational issues are currently flagged.</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-lh-line bg-white p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">
            Operations inbox
          </h2>
          <p className="mt-2 text-sm text-lh-muted">Urgent records with a clear next action.</p>
        </div>
        <StatusPill tone="attention">{items.length} active</StatusPill>
      </div>
      <div className="mt-6 divide-y divide-lh-line">
        {items.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            className="block py-4 transition hover:bg-lh-neutral-2/60"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-lh-shadow">{item.title}</p>
                <p className="mt-1 text-sm text-lh-muted">{item.reason}</p>
                <p className="mt-2 text-sm text-lh-shadow">{item.nextAction}</p>
              </div>
              <StatusPill tone={item.severity === "high" ? "attention" : "neutral"}>
                {item.domain}
              </StatusPill>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
