import Link from "next/link";
import type { THeader } from "@/types";

import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";

interface IFallbackHeaderProps {
  header?: THeader | null;
}

const styles = {
  header:
    "flex items-center justify-between px-4 py-8 bg-black text-white shadow-md dark:bg-gray-800",
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
            <Button>{button.label}</Button>
          </Link>
        ))}
      </div>
    </div>
  );
}