import Link from "next/link";
import type { THeader } from "@/types";

import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";

interface IFallbackHeaderProps {
  header?: THeader | null;
}

const styles = {
  header:
    "flex items-center justify-between px-4 py-8 bg-lh-white text-lh-shadow border-b border-lh-line shadow-sm",
  actions: "flex items-center gap-4",
};

export function FallbackHeader({ header }: IFallbackHeaderProps) {
  if (!header) return null;

  const { logoText, ctaButton } = header;
  return (
    <div className={styles.header}>
      <Logo data={logoText} />
      <div className={styles.actions}>
        {ctaButton.map((button, index) => (
          <Link key={index} href={button.href}>
            <Button variant={index === 0 ? "primary" : "outline"}>{button.label}</Button>
          </Link>
        ))}
      </div>
    </div>
  );
}