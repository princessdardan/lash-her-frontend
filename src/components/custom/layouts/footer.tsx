import Link from "next/link";
import type { TFooter } from "@/types";
import { Logo } from "@/components/ui/logo";
import { SiInstagram } from "@icons-pack/react-simple-icons";

function selectSocialIcon(url: string) {
  if (url.includes("instagram")) return <SiInstagram className="h-6 w-6 text-brand-pink" aria-hidden="true" />;
  return null;
}

interface IFooterProps {
  data?: TFooter | null;
}

export function Footer({ data }: IFooterProps) {
  if (!data) return null;
  const { logoText, socialLink, text } = data;
  return (
    <footer className="bg-brand-dark-red text-brand-more-pink pt-8 pb-4" role="contentinfo">
      <div className="content-container md:px-6 flex flex-col md:flex-row items-center justify-between">
        <Logo data={logoText} />
        <p className="mt-4 md:mt-0 text-sm text-brand-more-pink">{text}</p>
        <nav aria-label="Social media links">
          <div className="flex items-center space-x-4">
            {socialLink.map((link) => {
              return (
                <Link
                  className="text-brand-more-pink hover:text-brand-red transition-colors"
                  href={link.href}
                  key={link.id}
                >
                  {selectSocialIcon(link.href)}
                  <span className="sr-only">Visit us at {link.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      </div>
      <p className="text-brand-more-pink font-sans text-sm text-center mt-2">
        Designed by{" "}
        <Link href="https://dardandemiri.com" className="hover:text-brand-more-pink transition-colors" target="_blank" rel="noopener noreferrer">
          Dardan Demiri
        </Link>
      </p>
    </footer>
  );
}
