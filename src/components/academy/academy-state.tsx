export type AcademyStateKind =
  | "access-revoked"
  | "api-unavailable"
  | "archived-unsupported"
  | "course-empty"
  | "disabled"
  | "empty"
  | "payment-access-processing"
  | "video-processing";

const copy: Record<AcademyStateKind, { description: string; title: string }> = {
  "access-revoked": {
    title: "Course access unavailable",
    description:
      "Your access to this course is no longer active. No course content has been loaded.",
  },
  "api-unavailable": {
    title: "Academy temporarily unavailable",
    description:
      "The secure course service could not be reached. Your account and progress have not been changed.",
  },
  "archived-unsupported": {
    title: "Archived course unavailable",
    description:
      "This course uses an archived content contract that the academy does not currently support.",
  },
  "course-empty": {
    title: "No lessons available",
    description:
      "This course does not currently contain any available lessons.",
  },
  disabled: {
    title: "Academy access is not enabled",
    description:
      "The student academy is being prepared and is not available in this environment.",
  },
  empty: {
    title: "Course library connection pending",
    description:
      "The Course API does not yet provide an authoritative student course collection contract. Purchases and orders are not being treated as proof of course ownership.",
  },
  "payment-access-processing": {
    title: "Course access is processing",
    description:
      "Payment or enrollment processing is still in progress. This status does not confirm course ownership yet.",
  },
  "video-processing": {
    title: "Video is processing",
    description:
      "This lesson is available, but its video is not ready for playback yet.",
  },
};

export function AcademyState({ kind }: { kind: AcademyStateKind }) {
  const state = copy[kind];
  return (
    <section
      className="rounded-3xl border border-lh-line bg-white p-7 shadow-sm sm:p-10"
      role={
        kind === "api-unavailable" || kind === "access-revoked"
          ? "alert"
          : "status"
      }
    >
      <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-primary">
        Student academy
      </p>
      <h1 className="mt-3 font-heading text-4xl uppercase leading-none tracking-[0.07em] sm:text-5xl">
        {state.title}
      </h1>
      <p className="mt-5 max-w-2xl leading-7 text-lh-muted">
        {state.description}
      </p>
    </section>
  );
}

export function academyStateForError(error: unknown): AcademyStateKind {
  if (error && typeof error === "object" && "code" in error) {
    switch ((error as { code?: unknown }).code) {
      case "ACCESS_REVOKED":
        return "access-revoked";
      case "ARCHIVED_UNSUPPORTED":
        return "archived-unsupported";
      case "PAYMENT_ACCESS_PROCESSING":
        return "payment-access-processing";
      case "VIDEO_PROCESSING":
        return "video-processing";
    }
  }
  return "api-unavailable";
}
