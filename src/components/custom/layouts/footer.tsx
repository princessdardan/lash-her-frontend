import Link from "next/link";
import type { TFooter, TFooterNavigationItem, TFooterNavigationMenu } from "@/types";
import { Logo } from "@/components/ui/logo";
import { SiInstagram } from "@icons-pack/react-simple-icons";

const footerNavigationLinkClass =
  "group inline-flex items-center justify-center gap-2 text-sm font-sans font-bold text-lh-neutral/75 transition-colors hover:text-lh-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-light/70 focus-visible:ring-offset-4 focus-visible:ring-offset-lh-shadow sm:justify-start";

type SafeFooterNavigationItem = TFooterNavigationItem & {
  linkType: "direct" | "external";
  url: string;
};

type SafeFooterNavigationMenu = Omit<TFooterNavigationMenu, "items"> & {
  items: SafeFooterNavigationItem[];
};

function getSafeFooterNavigationItem(item: TFooterNavigationItem | null | undefined): SafeFooterNavigationItem | null {
  if (!item) return null;
  const url = typeof item.url === "string" ? item.url.trim() : "";
  if (!url) return null;

  if (item.linkType === "external") {
    try {
      const parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) return null;
      return { ...item, linkType: "external", url };
    } catch {
      return null;
    }
  }

  if ((url.startsWith("/") && !url.startsWith("//")) || url.startsWith("#")) {
    return { ...item, linkType: "direct", url };
  }

  return null;
}

function getSafeFooterNavigationMenu(menu: TFooterNavigationMenu | null | undefined): SafeFooterNavigationMenu | null {
  if (!menu) return null;

  const items = (menu.items ?? []).map(getSafeFooterNavigationItem).filter((item) => item !== null);
  if (!items.length) return null;

  return { ...menu, items };
}

function selectSocialIcon(url: string) {
  if (url.includes("instagram")) return <SiInstagram className="h-5 w-5 text-lh-neutral" aria-hidden="true" />;
  return null;
}

function FooterNavigationLink({ item }: { item: SafeFooterNavigationItem }) {
  if (item.linkType === "external") {
    return (
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${item.title} - external link, leaves Lash Her and opens in a new tab`}
        className={footerNavigationLinkClass}
      >
        <span>{item.title}</span>
        <span
          className="rounded-full border border-lh-light/20 px-1.5 py-0.5 text-[0.55rem] uppercase leading-none tracking-[0.2em] text-lh-neutral/55 transition-colors group-hover:border-lh-light/45 group-hover:text-lh-light"
          aria-hidden="true"
        >
          External
        </span>
      </a>
    );
  }

  return (
    <Link href={item.url} className={footerNavigationLinkClass}>
      {item.title}
    </Link>
  );
}

interface IFooterProps {
  data?: TFooter | null;
}

export function Footer({ data }: IFooterProps) {
  if (!data) return null;
  const { logoText, navigationMenus, socialLink, text } = data;
  const footerNavigationMenus = (navigationMenus ?? []).map(getSafeFooterNavigationMenu).filter((menu) => menu !== null);

  return (
    <footer className="bg-lh-shadow text-lh-neutral pt-16 pb-8" role="contentinfo">
      <div className="content-container md:px-6">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] lg:items-start">
          <div className="flex flex-col items-center gap-6 text-center md:items-start md:text-left">
            <div className="flex-shrink-0">
              <Logo data={logoText} />
            </div>
            <p className="max-w-md text-sm text-lh-neutral/80">{text}</p>
            <nav aria-label="Social media links" className="flex-shrink-0">
              <div className="flex items-center space-x-6">
                {socialLink.map((link, index) => {
                  return (
                    <Link
                      className="text-lh-neutral hover:text-lh-light transition-colors"
                      href={link.href}
                      key={link._key || index}
                    >
                      {selectSocialIcon(link.href)}
                      <span className="sr-only">Visit us at {link.label}</span>
                    </Link>
                  );
                })}
              </div>
            </nav>
          </div>
          {footerNavigationMenus.length > 0 ? (
            <nav
              aria-label="Footer navigation"
              className="grid w-full grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3"
            >
              {footerNavigationMenus.map((menu) => (
                <div key={menu._key || menu.heading || "footer-menu"} className="space-y-4 text-center sm:text-left">
                  {menu.heading ? (
                    <h2 className="font-heading text-sm uppercase tracking-[0.28em] text-lh-light">
                      {menu.heading}
                    </h2>
                  ) : null}
                  <ul className="space-y-3">
                    {menu.items.map((item) => (
                      <li key={item._key || `${item.title}-${item.url}`}>
                        <FooterNavigationLink item={item} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          ) : null}
        </div>
      </div>
      <div className="content-container md:px-6 mt-12">
        <div className="border-t border-lh-light/20 pt-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-lh-neutral/60 font-sans text-xs">
            &copy; {new Date().getFullYear()} Lash Her by Nataliea. All rights reserved.
          </p>
          <p className="text-lh-neutral/60 font-sans text-xs">
            Designed by{" "}
            <Link href="https://dardandemiri.com" className="hover:text-lh-light transition-colors" target="_blank" rel="noopener noreferrer">
              Dardan Demiri
            </Link>
          </p>
        </div>
      </div>
    </footer>
  );
}
