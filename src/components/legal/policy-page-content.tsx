import { PortableTextRenderer } from "@/components/ui/portable-text-renderer";
import type { TPolicyPage, TPolicyPageType } from "@/types";

const PAGE_TYPE_LABELS: Record<TPolicyPageType, string> = {
  privacy: "Privacy",
  cookie: "Cookie Policy",
  booking: "Booking Policy",
  return: "Return Policy",
  refund: "Refund Policy",
  faq: "FAQ",
  terms: "Terms",
  general: "Policy",
};

interface PolicyPageContentProps {
  page: TPolicyPage;
}

export function PolicyPageContent({ page }: PolicyPageContentProps) {
  const updatedAt = page._updatedAt
    ? new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(new Date(page._updatedAt))
    : null;

  return (
    <section className="bg-lh-neutral-2 py-16 text-lh-shadow md:py-24">
      <article className="content-container max-w-4xl">
        <div className="rounded-[28px] border border-lh-line bg-lh-white px-6 py-10 shadow-[0_24px_70px_rgba(28,19,24,0.08)] md:px-12 md:py-14">
          <p className="eyebrow-label mb-4">{PAGE_TYPE_LABELS[page.pageType]}</p>
          <h1 className="section-heading mb-6">{page.title}</h1>
          {page.summary ? (
            <p className="mb-8 max-w-3xl font-body text-lg font-bold leading-8 text-lh-shadow/75">
              {page.summary}
            </p>
          ) : null}
          {updatedAt ? (
            <p className="mb-10 border-y border-lh-line py-3 font-body text-sm font-bold text-lh-muted">
              Last updated {updatedAt}
            </p>
          ) : null}
          <div className="prose prose-lg max-w-none prose-headings:font-heading prose-headings:font-normal prose-headings:text-lh-shadow prose-p:font-body prose-p:font-bold prose-p:leading-8 prose-p:text-lh-shadow/80 prose-a:text-lh-primary prose-a:underline prose-a:underline-offset-4">
            <PortableTextRenderer content={page.body} />
          </div>
        </div>
      </article>
    </section>
  );
}
