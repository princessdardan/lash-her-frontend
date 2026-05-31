import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { notFound } from "next/navigation";
import Link from "next/link";
import { loaders } from "@/data/loaders";
import { resolveTrainingIntroCallEligibility } from "@/lib/booking/paid-training-context";
import { findPendingTrainingEnrollmentByToken } from "@/lib/commerce/training-enrollment-store";
import { GoogleAppointmentSchedulePopupButton } from "./google-appointment-schedule-popup-button";

export const revalidate = 0;
export const dynamic = "force-dynamic";

const DEFAULT_SCHEDULING_INSTRUCTIONS = "Choose the intro-call time that feels most spacious for you. Google Calendar will send the confirmation and meeting details after you reserve your appointment.";

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
  noStore();

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

  const appointmentScheduleUrl = getGoogleAppointmentScheduleUrl(program.introCallAppointmentScheduleUrl);

  if (!appointmentScheduleUrl) {
    return <SafeErrorShell programTitle={program.title} />;
  }

  const embedMode = program.introCallAppointmentScheduleEmbedMode === "embed" ? "embed" : "link";
  const appointmentScheduleEmbedUrl = getGoogleAppointmentScheduleEmbedUrl(appointmentScheduleUrl);

  return (
    <section className="flex flex-col min-h-screen bg-lh-neutral-2">
      <section className="section-shell py-16 md:py-24">
        <div className="content-container mx-auto">
          <header className="mb-12 text-center">
            <h1 className="section-heading mb-2">Schedule Training Call</h1>
            <h2 className="section-subheading">{program.title}</h2>
          </header>
          
          <AppointmentScheduleCard
            embedUrl={appointmentScheduleEmbedUrl}
            mode={embedMode}
            programTitle={program.title}
            scheduleUrl={appointmentScheduleUrl}
            instructions={program.introCallSchedulingInstructions}
          />
        </div>
      </section>
    </section>
  );
}

function AppointmentScheduleCard({
  embedUrl,
  instructions,
  mode,
  programTitle,
  scheduleUrl,
}: {
  embedUrl: string;
  instructions?: string;
  mode: "link" | "embed";
  programTitle: string;
  scheduleUrl: string;
}) {
  return (
    <article className="soft-panel overflow-hidden rounded-2xl bg-white shadow-sm">
      <div className="space-y-6 p-8 text-center md:p-12">
        <p className="eyebrow-text">Verified enrollment</p>
        <h3 className="section-subheading text-lh-shadow">Reserve your private intro call</h3>
        <p className="mx-auto max-w-2xl text-lg leading-8 text-lh-shadow/80">
          {instructions?.trim() || DEFAULT_SCHEDULING_INSTRUCTIONS}
        </p>
        <p className="text-sm uppercase tracking-[0.24em] text-lh-shadow/55">
          Your booking is confirmed by Google Calendar after you select a time.
        </p>
      </div>

      {mode === "embed" ? (
        <>
          <div className="border-t border-lh-neutral/20 bg-lh-neutral-2/60 p-6 text-center md:hidden">
            <p className="mx-auto mb-6 max-w-md text-base leading-7 text-lh-shadow/75">
              Google Calendar is easier to use from a mobile popup. Tap below to choose your intro-call time without pinching through an embedded calendar.
            </p>
            <GoogleAppointmentSchedulePopupButton
              scheduleUrl={scheduleUrl}
              label="Reserve intro call"
            />
          </div>
          <div className="hidden border-t border-lh-neutral/20 bg-lh-neutral-2/60 p-6 md:block lg:p-8">
            <iframe
              src={embedUrl}
              title={`Google Appointment Schedule for ${programTitle}`}
              className="h-[980px] w-full rounded-2xl border border-lh-neutral/20 bg-white shadow-sm lg:h-[1080px]"
            />
          </div>
        </>
      ) : (
        <div className="border-t border-lh-neutral/20 bg-lh-neutral-2/60 p-8 text-center md:p-10">
          <a
            href={scheduleUrl}
            className="inline-flex items-center justify-center rounded-full bg-lh-primary px-7 py-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-white transition-colors hover:bg-lh-accent"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Google Appointment Schedule
          </a>
        </div>
      )}
    </article>
  );
}

function getGoogleAppointmentScheduleEmbedUrl(value: string): string {
  const url = new URL(value);
  url.searchParams.set("gv", "true");
  return url.toString();
}

function getGoogleAppointmentScheduleUrl(value: string | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (
      url.protocol === "https:"
      && url.hostname === "calendar.google.com"
      && url.pathname.startsWith("/calendar/appointments/schedules/")
    ) {
      return url.toString();
    }
  } catch {
    return null;
  }

  return null;
}

function SafeErrorShell({ programTitle }: { programTitle: string }) {
  return (
    <section className="flex flex-col min-h-screen bg-lh-neutral-2">
      <section className="section-shell py-16 md:py-24">
        <div className="content-container max-w-2xl mx-auto">
          <article className="soft-panel p-8 md:p-12 rounded-2xl bg-white shadow-sm text-center">
            <h1 className="section-heading mb-2">Scheduling Unavailable</h1>
            <h2 className="section-subheading mb-6">{programTitle}</h2>

            <div className="space-y-6 text-lh-shadow/80 text-lg mb-8">
              <p>
                We could not verify this training scheduling link. It may be invalid, expired, or already used.
              </p>
              <p>
                If you have already scheduled your call, please check your email for the calendar invitation.
              </p>
            </div>

            <div className="border-t border-lh-neutral/20 pt-8">
              <h3 className="section-subheading mb-4">Need Help?</h3>

              <div className="space-y-6">
                <p className="text-lh-shadow/80">
                  If you believe this is an error or need assistance scheduling your training call, please contact our support team.
                </p>
                <Link
                  href="/contact"
                  className="inline-flex items-center justify-center rounded-full bg-lh-primary px-7 py-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-white transition-colors hover:bg-lh-accent"
                >
                  Contact Support
                </Link>
              </div>
            </div>
          </article>
        </div>
      </section>
    </section>
  );
}
