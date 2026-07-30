import { notFound, permanentRedirect } from "next/navigation";
import { loadPublicOperationalOfferings } from "@/lib/booking/operations/public-offerings";
import { resolveBookingShim } from "./booking-shim";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function BookingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolution = await resolveBookingShim(await searchParams, {
    hasBookableServiceSlug: async (slug) => {
      const offerings = await loadPublicOperationalOfferings({
        mode: "operational",
        servicePublicSlug: slug,
      });

      return Boolean(offerings?.length);
    },
  });

  if (resolution.kind === "notFound") {
    notFound();
  }

  permanentRedirect(resolution.href);
}
