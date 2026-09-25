import type { FormActionResult } from "@/app/actions/form";
import type { TShortCourseSummary } from "@/types";
import type { RecordCourseSignupInput } from "@/lib/marketing-contact/marketing-contact-store";
import type { CourseAccessGrant, CourseSignupInput } from "./contract";
import {
  createCourseAccessToken,
  verifyCourseAccessToken,
} from "./access-token";

export type CourseSignupStage =
  | "configuration"
  | "access"
  | "rate_limit"
  | "course"
  | "persistence"
  | "cookie";

export interface CourseSignupDependencies {
  getCourse(id: string): Promise<TShortCourseSummary | null>;
  getSecret(): string;
  getToken(id: string): Promise<string | undefined>;
  checkRateLimit(email: string): Promise<boolean>;
  recordSignup(input: RecordCourseSignupInput): Promise<unknown>;
  setCookie(id: string, token: string, grant: CourseAccessGrant): Promise<void>;
  now(): number;
  logError(details: { stage: CourseSignupStage; code?: string }): void;
}

export async function signupForCourse(
  input: CourseSignupInput,
  dependencies: CourseSignupDependencies,
): Promise<FormActionResult> {
  if (
    !input ||
    typeof input.courseId !== "string" ||
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(input.courseId)
  )
    return { success: false, error: "This course is unavailable." };
  if (input.company)
    return { success: false, error: "Unable to complete signup." };
  let stage: CourseSignupStage = "configuration";
  try {
    // Check configuration before writes; returning access never renews consent.
    const secret = dependencies.getSecret();
    const now = dependencies.now();
    stage = "access";
    const existing = verifyCourseAccessToken(
      await dependencies.getToken(input.courseId),
      input.courseId,
      secret,
      now,
    );
    if (existing) return { success: true };
    const fieldErrors: Record<string, string> = {};
    const email = typeof input.email === "string" ? input.email.trim() : "";
    const phone = typeof input.phone === "string" ? input.phone.trim() : "";
    const instagram =
      typeof input.instagram === "string" ? input.instagram.trim() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      fieldErrors.email = "Enter a valid email address.";
    if (
      phone.length > 40 ||
      !/^\+?[0-9\s().-]+$/.test(phone) ||
      !/^[0-9]{7,15}$/.test(phone.replace(/\D/g, ""))
    )
      fieldErrors.phone = "Enter a valid phone number.";
    if (
      (input.instagram !== undefined && typeof input.instagram !== "string") ||
      (instagram && !/^@?[a-zA-Z0-9._]{1,30}$/.test(instagram))
    )
      fieldErrors.instagram =
        "Enter a valid Instagram handle or leave it blank.";
    if (input.marketingConsent !== true)
      fieldErrors.marketingConsent =
        "Agree to marketing emails to access the course.";
    if (Object.keys(fieldErrors).length) return { success: false, fieldErrors };
    stage = "rate_limit";
    if (!(await dependencies.checkRateLimit(email.toLowerCase())))
      return {
        success: false,
        error: "Too many signup attempts. Please try again later.",
      };
    stage = "course";
    const course = await dependencies.getCourse(input.courseId);
    if (
      !course?.modules?.length ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(course.slug)
    )
      return { success: false, error: "This course is unavailable." };
    const { token, grant } = createCourseAccessToken(course._id, secret, now);
    stage = "persistence";
    await dependencies.recordSignup({
      email,
      phone,
      instagram: instagram || undefined,
      courseId: course._id,
      courseTitle: course.title,
      sourcePath: `/courses/${course.slug}`,
      submittedAt: new Date(now),
    });
    stage = "cookie";
    await dependencies.setCookie(course._id, token, grant);
    return { success: true };
  } catch (error) {
    // Drizzle wraps database errors. Log only a SQLSTATE code and our own stage;
    // exception messages/queries may contain contact details or credentials.
    const cause = error instanceof Error ? error.cause : undefined;
    const databaseError = cause ?? error;
    const code =
      typeof databaseError === "object" &&
      databaseError !== null &&
      "code" in databaseError &&
      typeof databaseError.code === "string" &&
      /^[0-9A-Z]{5}$/.test(databaseError.code)
        ? databaseError.code
        : undefined;
    dependencies.logError({ stage, code });
    return {
      success: false,
      error: "We could not complete your signup. Please try again.",
    };
  }
}
