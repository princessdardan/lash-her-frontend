"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useHeaderContext } from "../custom/layouts/header-wrapper";

interface NavLink {
  href: string;
  label: string;
}

const navLinks: NavLink[] = [
  { href: "/homepage", label: "Home" },
  { href: "/training", label: "Training" },
  { href: "/gallery", label: "Gallery" },
  { href: "/contact", label: "Contact" },
];

export function Navigation() {
  const pathname = usePathname();
  const { isActive: isHeaderActive } = useHeaderContext();

  return (
    <nav className="flex items-center gap-6">
      {navLinks.map((link) => {
        const isActive = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "text-md font-light transition-colors",
              isActive ? "font-semibold" : "",
              isHeaderActive 
                ? "text-brand-red hover:text-brand-red/70" 
                : "text-brand-pink hover:text-brand-red"
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
