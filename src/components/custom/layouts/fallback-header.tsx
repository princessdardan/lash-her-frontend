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
    <header className={styles.header}>
      <Logo data={logoText} />
      <div className={styles.actions}>
        {ctaButton.map((button, index) => (
          <Button key={index} asChild variant={index === 0 ? "primary" : "outline"}>
            <a href={button.href}>{button.label}</a>
          </Button>
        ))}
      </div>
    </header>
  );
}
