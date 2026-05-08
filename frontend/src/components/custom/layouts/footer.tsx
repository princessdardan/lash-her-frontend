import Link from "next/link";
import type { TFooter } from "@/types";
import { Logo } from "@/components/ui/logo";
import { SiInstagram } from "@icons-pack/react-simple-icons";

function selectSocialIcon(url: string) {
  if (url.includes("instagram")) return <SiInstagram className="h-5 w-5 text-lh-neutral" aria-hidden="true" />;
  return null;
}

interface IFooterProps {
  data?: TFooter | null;
}

export function Footer({ data }: IFooterProps) {
  if (!data) return null;
  const { logoText, socialLink, text } = data;
  return (
    <footer className="bg-lh-shadow text-lh-neutral pt-16 pb-8" role="contentinfo">
      <div className="content-container md:px-6 flex flex-col md:flex-row items-center justify-between gap-8">
        <div className="flex-shrink-0">
          <Logo data={logoText} />
        </div>
        <p className="text-sm text-lh-neutral/80 max-w-md text-center md:text-left">{text}</p>
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
