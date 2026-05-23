import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { notFound } from "next/navigation";
import Link from "next/link";
import { loaders } from "@/data/loaders";
import { getVerifiedTrainingConfirmation } from "@/lib/training-confirmation";
import { getOrIssueTrainingSchedulingTokenForPaidOrder } from "@/lib/commerce/training-enrollment-store";
import { buildTrainingScheduleUrl } from "@/lib/training-checkout";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const data = await loaders.getTrainingProgramBySlug(slug);

  const title = `Confirmation: ${data?.title || "Training"}`;
  const description = `Your enrollment in ${data?.title || "our training program"} is confirmed.`;

  return {
    title,
    description,
    robots: { index: false, follow: false },
  };
}

interface ConfirmationPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ order?: string; schedulingToken?: string; token?: string }>;
}

export default async function TrainingConfirmationPage({
  params,
  searchParams,
}: ConfirmationPageProps) {
  noStore();

  const { slug } = await params;
  const { order, schedulingToken, token } = await searchParams;

  if (token !== undefined) {
    notFound();
  }

  const program = await loaders.getTrainingProgramBySlug(slug);

  if (!program) {
    notFound();
  }

  const confirmation = await getVerifiedTrainingConfirmation({
    orderId: order,
    programSlug: slug,
  });

  if (!confirmation) {
    notFound();
  }

  const issuedSchedulingToken = schedulingToken
    ? null
    : await getOrIssueTrainingSchedulingTokenForPaidOrder(confirmation.orderId);
  const scheduleToken = schedulingToken ?? issuedSchedulingToken?.schedulingToken;

  if (!scheduleToken) {
    notFound();
  }

  const bookingHref = buildTrainingScheduleUrl({
    programSlug: slug,
    schedulingToken: scheduleToken,
  });

  return (
    <div className="flex flex-col min-h-screen bg-lh-neutral-2">
      <section className="section-shell py-16 md:py-24">
        <div className="content-container max-w-2xl mx-auto">
          <div className="soft-panel p-8 md:p-12 rounded-2xl bg-white shadow-sm text-center">
            <h1 className="section-heading mb-2">Enrollment Confirmed</h1>
            <h2 className="section-subheading mb-6">{program.title}</h2>

            <div className="space-y-6 text-lh-shadow/80 text-lg mb-8">
              <p>
                Thank you for your enrollment! Your payment has been successfully processed.
              </p>

              <div className="bg-lh-neutral/20 p-4 rounded-xl border border-lh-neutral/30 inline-block mx-auto">
                <p className="text-sm text-lh-shadow/70 mb-1">Order Reference</p>
                <p className="font-medium text-lh-shadow font-mono">{confirmation.orderId}</p>
              </div>

              <p>
                We have sent a confirmation email with your enrollment details.
              </p>
            </div>

            <div className="border-t border-lh-neutral/20 pt-8">
              <h3 className="section-subheading mb-4">Next Steps</h3>

              <div className="space-y-6">
                <p className="text-lh-shadow/80">
                  Please schedule your initial training call to coordinate dates and program details.
                </p>
                <Link
                  href={bookingHref}
                  className="btn-primary-red inline-block"
                >
                  Schedule Training Call
                </Link>
                <p className="text-sm text-lh-shadow/70 mt-4">
                  Use your secure scheduling link to select your training call time. If no slots are currently available, we will follow up manually to coordinate a time that works.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
