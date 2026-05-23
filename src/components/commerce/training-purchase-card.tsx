import Link from "next/link";
import type { TTrainingProgram } from "@/types";
import { getTrainingCheckoutProduct, isTrainingPurchasable } from "@/lib/training-checkout";
import { formatCad } from "@/lib/commerce/money";
import { Button } from "@/components/ui/button";

interface TrainingPurchaseCardProps {
  program: TTrainingProgram;
  cta: {
    label: string;
    href: string;
  };
}

export function TrainingMobileTray({ program, cta }: TrainingPurchaseCardProps) {
  if (!isTrainingPurchasable(program)) {
    return null;
  }

  const product = getTrainingCheckoutProduct(program);

  if (!product) return null;

  const priceFormatted = formatCad(product.price);

  return (
    <div className="sticky bottom-0 w-full z-50 mt-auto bg-lh-white border-t border-lh-line p-4 shadow-[0_-4px_20px_rgba(0,0,0,0.05)] lg:hidden">
      <div className="flex items-center justify-between gap-4 max-w-md mx-auto">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-lh-shadow line-clamp-1">{product.title || program.title}</span>
          <span className="text-lg font-bold text-lh-primary">{priceFormatted}</span>
        </div>
        <Button asChild variant="dark" size="lg" className="shrink-0">
          <Link href={cta.href}>{cta.label}</Link>
        </Button>
      </div>
    </div>
  );
}

export function TrainingPurchaseCard({ program, cta }: TrainingPurchaseCardProps) {
  if (!isTrainingPurchasable(program)) {
    return null;
  }

  const product = getTrainingCheckoutProduct(program);

  if (!product) return null;

  const priceFormatted = formatCad(product.price);

  return (
    <div className="hidden lg:block w-full lg:w-[22rem] lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto bg-lh-white rounded-2xl p-8 shadow-xl border border-lh-line/50 pointer-events-auto">
        <h3 className="section-subheading mb-2">{product.title || program.title}</h3>
        <div className="text-3xl font-bold text-lh-primary mb-6">{priceFormatted}</div>

        <div className="space-y-4 mb-8">
          {product.availabilityLabel && (
            <div className="flex items-start gap-2 text-sm text-lh-shadow/80">
              <span className="text-lh-primary mt-0.5">•</span>
              <span>{product.availabilityLabel}</span>
            </div>
          )}
          {product.fulfillmentNote && (
            <div className="flex items-start gap-2 text-sm text-lh-shadow/80">
              <span className="text-lh-primary mt-0.5">•</span>
              <span>{product.fulfillmentNote}</span>
            </div>
          )}
          <div className="flex items-start gap-2 text-sm text-lh-shadow/80">
            <span className="text-lh-primary mt-0.5">•</span>
            <span>Secure checkout via Helcim</span>
          </div>
        </div>

        <Button asChild variant="dark" size="lg" className="w-full text-lg py-6">
          <Link href={cta.href}>{cta.label}</Link>
        </Button>

        <p className="text-xs text-center text-lh-shadow/60 mt-4">
          You will be redirected to our secure payment portal.
        </p>
      </div>
  );
}
