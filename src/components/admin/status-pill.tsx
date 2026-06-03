import type { ReactNode } from "react";

interface StatusPillProps {
  tone?: "attention" | "neutral" | "success";
  children: ReactNode;
}

const tones = {
  attention: "border-lh-accent-soft bg-lh-light-soft text-lh-accent",
  neutral: "border-lh-line bg-lh-neutral-2 text-lh-muted",
  success: "border-lh-primary-soft bg-lh-primary-soft text-lh-primary",
};

export function StatusPill({ children, tone = "neutral" }: StatusPillProps) {
  return (
    <span
      className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
