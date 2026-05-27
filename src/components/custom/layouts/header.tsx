"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShoppingBag } from "lucide-react";
import type { THeader } from "@/types";
import type { IMainMenuItems } from "@/app/main-menu";

import { Logo } from "@/components/ui/logo";
import { MainMenu } from "@/app/main-menu";
import { MobileNavigation } from "@/components/ui/mobile-navigation";
import { Button } from "@/components/ui/button";
import { HeaderWrapper, useHeaderContext } from "@/components/custom/layouts/header-wrapper";
import { NavigationMenu, NavigationMenuList } from "@/components/ui/navigation-menu";
import { cn } from "@/lib/utils";
import { useProductCart } from "@/components/commerce/product-cart-provider";

interface IHeaderProps {
  data?: THeader | null;
  menuItems?: IMainMenuItems[];
}

function HeaderButton({ href, label, isPrimary }: { href: string; label: string; isPrimary?: boolean }) {
  const { isActive } = useHeaderContext();
  
  if (isPrimary) {
    return (
      <Button asChild variant="primary" className={cn(
          "font-sans font-bold text-sm px-6 py-2 transition-all duration-300",
          isActive ? "border border-lh-primary shadow-[0_4px_14px_-2px_rgba(102,57,118,0.3)] hover:bg-lh-primary/90 hover:shadow-[0_6px_20px_-2px_rgba(102,57,118,0.4)]" : "border border-transparent"
        )}>
        <Link href={href}>
          {label}
        </Link>
      </Button>
    );
  }

  return (
    <Button asChild variant="ghost" className={cn(
        "font-sans font-bold text-sm px-4 py-2 transition-all duration-300",
        isActive ? "bg-lh-neutral/50 border border-lh-line text-lh-shadow hover:bg-lh-neutral hover:border-lh-light hover:text-lh-primary shadow-sm" : "border border-transparent text-lh-white hover:text-lh-light hover:bg-white/10"
      )}>
      <Link href={href}>
        {label}
      </Link>
    </Button>
  );
}

function CartButton() {
  const { isActive } = useHeaderContext();
  const { items, openCart } = useProductCart();
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <button
      type="button"
      onClick={openCart}
      className={cn(
        "relative inline-flex items-center gap-2 rounded-md font-sans font-bold text-sm px-4 py-2 transition-all duration-300",
        isActive
          ? "bg-lh-neutral/50 border border-lh-line text-lh-shadow hover:bg-lh-neutral hover:border-lh-light hover:text-lh-primary shadow-sm"
          : "border border-transparent text-lh-white hover:text-lh-light hover:bg-white/10",
      )}
      aria-label={itemCount > 0 ? `Open cart with ${itemCount} items` : "Open cart"}
    >
      <ShoppingBag className="h-4 w-4" aria-hidden="true" />
      <span>Cart</span>
      {itemCount > 0 ? (
        <span className="absolute -right-1 -top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-lh-primary px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
          {itemCount}
        </span>
      ) : null}
    </button>
  );
}

function HeaderContent({ data, menuItems }: IHeaderProps) {
  const { isActive } = useHeaderContext();
  const pathname = usePathname();
  
  if (!data) return null;

  const { logoText, ctaButton } = data;
  const primaryCta = ctaButton[0]; // Use first CTA button for mobile
  const showCartButton = pathname !== "/products";
  
  return (
    <>
      <div className="w-full relative flex items-center justify-center">
        {/* Mobile hamburger - top left */}
        <div className="absolute left-4 md:hidden">
          <MobileNavigation ctaButton={primaryCta} menuItems={menuItems} showCartButton={showCartButton} />
        </div>

        {/* Desktop navigation - left */}
        <nav className="hidden md:flex absolute left-4 items-center gap-4" aria-label="Main navigation">
          <NavigationMenu>
            <NavigationMenuList>
              {menuItems && menuItems.length > 0 && (
                <MainMenu data={menuItems} isHeaderActive={isActive} />
              )}
            </NavigationMenuList>
          </NavigationMenu>
        </nav>
        
        {/* Desktop CTA buttons - right, hidden on mobile */}
        <div className="hidden md:flex absolute right-4 gap-2">
          {ctaButton.map((button, index) => (
            <HeaderButton key={index} href={button.href} label={button.label} isPrimary={index === 0} />
          ))}
          {showCartButton ? <CartButton /> : null}
        </div>
        
        {/* Logo - centered */}
        <Logo data={logoText} />
      </div>
    </>
  );
}

export function Header({ data, menuItems }: IHeaderProps) {
  return (
    <HeaderWrapper>
      <HeaderContent data={data} menuItems={menuItems} />
    </HeaderWrapper>
  );
}
