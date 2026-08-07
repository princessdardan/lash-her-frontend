import { AcademyState } from "@/components/academy/academy-state";
import { getAcademyConfig } from "@/lib/academy/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function AcademyDashboardPage() {
  const config = getAcademyConfig();

  return (
    <div>
      <div className="mb-8 max-w-3xl">
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-primary">
          Your learning
        </p>
        <h1 className="mt-3 font-heading text-5xl uppercase leading-none tracking-[0.07em] sm:text-6xl">
          Academy
        </h1>
      </div>
      <AcademyState kind={config.enabled ? "empty" : "disabled"} />
    </div>
  );
}
