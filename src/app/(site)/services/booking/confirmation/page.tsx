import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { getServiceBookingConfirmationRedirect } from "@/lib/booking-confirmation";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Booking Confirmation",
  description: "Your appointment booking confirmation.",
  robots: { index: false, follow: false },
};

interface ServiceBookingConfirmationResolverPageProps {
  searchParams: Promise<{ order?: string }>;
}

export default async function ServiceBookingConfirmationResolverPage({
  searchParams,
}: ServiceBookingConfirmationResolverPageProps): Promise<never> {
  noStore();

  const { order } = await searchParams;
  const redirectUrl = await getServiceBookingConfirmationRedirect({
    orderId: order,
  });

  if (redirectUrl === null) {
    notFound();
  }

  redirect(redirectUrl);
}
