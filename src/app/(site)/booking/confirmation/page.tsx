import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { buildServiceBookingConfirmationResolverUrl } from "@/lib/training-checkout";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Booking Confirmation",
    description: "Your appointment booking confirmation.",
    robots: { index: false, follow: false },
  };
}

interface ConfirmationPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function BookingConfirmationPage({
  searchParams,
}: ConfirmationPageProps) {
  const resolvedSearchParams = await searchParams;
  const keys = Object.keys(resolvedSearchParams);

  if (keys.length !== 1 || keys[0] !== "order") {
    notFound();
  }

  const order = typeof resolvedSearchParams.order === "string" ? resolvedSearchParams.order.trim() : "";

  if (order.length === 0) {
    notFound();
  }

  noStore();
  return redirect(buildServiceBookingConfirmationResolverUrl({ orderId: order }));
}
