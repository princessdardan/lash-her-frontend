import { createSupplementalPaymentOfferLinkHandlers } from "@/lib/commerce/supplemental-payment-offer-link-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createSupplementalPaymentOfferLinkHandlers();

export const GET = handlers.GET;
export const POST = handlers.POST;
