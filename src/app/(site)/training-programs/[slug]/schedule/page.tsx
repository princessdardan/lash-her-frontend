import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { loaders } from "@/data/loaders";
import { resolveTrainingIntroCallEligibility } from "@/lib/booking/paid-training-context";
import { findPendingTrainingEnrollmentByToken } from "@/lib/commerce/training-enrollment-store";
import { BookingFlow } from "@/components/booking/booking-flow";

export const revalidate = 0;
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const data = await loaders.getTrainingProgramBySlug(slug);

  const title = `Schedule: ${data?.title || "Training"}`;
  const description = `Schedule your initial training call for ${data?.title || "our training program"}.`;

  return {
    title,
    description,
    robots: { index: false, follow: false },
  };
}

interface SchedulePageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TrainingSchedulePage({
  params,
  searchParams,
}: SchedulePageProps) {
  const { slug } = await params;
  const resolvedSearchParams = await searchParams;
  const keys = Object.keys(resolvedSearchParams);

  if (keys.length > 1 || (keys.length === 1 && keys[0] !== "token")) {
    notFound();
  }

  const token = typeof resolvedSearchParams.token === "string" ? resolvedSearchParams.token.trim() : "";

  const program = await loaders.getTrainingProgramBySlug(slug);

  if (!program) {
    notFound();
  }

  if (!token) {
    return <SafeErrorShell programTitle={program.title} />;
  }

  const eligibility = await resolveTrainingIntroCallEligibility(
    {
      programSlug: slug,
      schedulingToken: token,
    },
    async (input) => findPendingTrainingEnrollmentByToken({ schedulingToken: input.schedulingToken })
  );

  if (!eligibility.ok) {
    return <SafeErrorShell programTitle={program.title} />;
  }

  const settings = await loaders.getBookingSettings();

  if (!settings) {
    notFound();
  }

  return (
    <div className="flex flex-col min-h-screen bg-lh-neutral-2">
      <section className="section-shell py-16 md:py-24">
        <div className="content-container max-w-4xl mx-auto">
          <div className="mb-12 text-center">
            <h1 className="section-heading mb-2">Schedule Training Call</h1>
            <h2 className="text-2xl font-serif text-lh-shadow">{program.title}</h2>
          </div>
          
          <BookingFlow 
            settings={settings} 
            initialBookingType="training-call"
            paidSchedulingToken={token}
            paidTrainingSlug={slug}
          />
        </div>
      </section>
    </div>
  );
}

function SafeErrorShell({ programTitle }: { programTitle: string }) {
  return (
    <div className="flex flex-col min-h-screen bg-lh-neutral-2">
      <section className="section-shell py-16 md:py-24">
        <div className="content-container max-w-2xl mx-auto">
          <div className="soft-panel p-8 md:p-12 rounded-2xl bg-white shadow-sm text-center">
            <h1 className="section-heading mb-2">Scheduling Unavailable</h1>
            <h2 className="text-2xl font-serif text-lh-shadow mb-6">{programTitle}</h2>

            <div className="space-y-6 text-lh-shadow/80 text-lg mb-8">
              <p>
                We could not verify this training scheduling link. It may be invalid, expired, or already used.
              </p>
              <p>
                If you have already scheduled your call, please check your email for the calendar invitation.
              </p>
            </div>

            <div className="border-t border-lh-neutral/20 pt-8">
              <h3 className="font-medium text-xl mb-4">Need Help?</h3>

              <div className="space-y-6">
                <p className="text-lh-shadow/80">
                  If you believe this is an error or need assistance scheduling your training call, please contact our support team.
                </p>
                <Link
                  href="/contact"
                  className="btn-primary-red inline-block"
                >
                  Contact Support
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
