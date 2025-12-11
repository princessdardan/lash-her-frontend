import Link from "next/link";
import type { TFooter } from "@/types";
import { Logo } from "@/components/ui/logo";
import { SiInstagram } from "@icons-pack/react-simple-icons";

function selectSocialIcon(url: string) {
  if (url.includes("instagram")) return <SiInstagram className="h-6 w-6 text-brand-pink" />;
  return null;
}

interface IFooterProps {
  data?: TFooter | null;
}

export function Footer({ data }: IFooterProps) {
  if (!data) return null;
  const { logoText, socialLink, text } = data;
  return (
    <div className="bg-brand-dark-red text-brand-more-pink py-8">
      <div className="content-container md:px-6 flex flex-col md:flex-row items-center justify-between">
        <Logo data={logoText} />
        <p className="mt-4 md:mt-0 text-sm text-brand-more-pink">{text}</p>
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
      </div>
    </div>
  );
}
