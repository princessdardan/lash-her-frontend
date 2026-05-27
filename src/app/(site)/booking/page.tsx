import { notFound, permanentRedirect } from "next/navigation";
import { loaders } from "@/data/loaders";
import { BookingFlow } from "@/components/booking/booking-flow";
import { resolveBookingShim } from "./booking-shim";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function BookingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolution = await resolveBookingShim(await searchParams, {
    getBookableServiceBySlug: async (slug) => loaders.getBookableServiceBySlug(slug),
  });

  if (resolution.kind === "notFound") {
    notFound();
  }

  if (resolution.kind === "redirect") {
    permanentRedirect(resolution.href);
  }

  const [settings, services] = await Promise.all([
    loaders.getBookingSettings(),
    loaders.getBookableServices(),
  ]);

  if (!settings) {
    notFound();
  }

  return (
    <section className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24" aria-label="Service booking">
      <div className="content-container max-w-5xl mx-auto">
        <BookingFlow
          settings={settings}
          services={services}
        />
      </div>
    </section>
  );
}
