import type { FormActionResult } from "@/app/actions/form";
import type { TShortCourseSummary } from "@/types";
import type { RecordCourseSignupInput } from "@/lib/marketing-contact/marketing-contact-store";
import type { CourseAccessGrant, CourseSignupInput } from "./contract";
import {
  createCourseAccessToken,
  verifyCourseAccessToken,
} from "./access-token";

export interface CourseSignupDependencies {
  getCourse(id: string): Promise<TShortCourseSummary | null>;
  getSecret(): string;
  getToken(id: string): Promise<string | undefined>;
  checkRateLimit(email: string): Promise<boolean>;
  recordSignup(input: RecordCourseSignupInput): Promise<unknown>;
  setCookie(id: string, token: string, grant: CourseAccessGrant): Promise<void>;
  now(): number;
  logError(): void;
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
  try {
    // Check configuration before writes; returning access never renews consent.
    const secret = dependencies.getSecret();
    const now = dependencies.now();
    const existing = verifyCourseAccessToken(
      await dependencies.getToken(input.courseId),
      input.courseId,
      secret,
      now,
    );
    if (existing) return { success: true };
    const fieldErrors: Record<string, string> = {};
    const email = typeof input.email === "string" ? input.email.trim() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      fieldErrors.email = "Enter a valid email address.";
    if (input.marketingConsent !== true)
      fieldErrors.marketingConsent =
        "Agree to marketing emails to access the course.";
    if (Object.keys(fieldErrors).length) return { success: false, fieldErrors };
    if (!(await dependencies.checkRateLimit(email.toLowerCase())))
      return {
        success: false,
        error: "Too many signup attempts. Please try again later.",
      };
    const course = await dependencies.getCourse(input.courseId);
    if (
      !course?.modules?.length ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(course.slug)
    )
      return { success: false, error: "This course is unavailable." };
    const { token, grant } = createCourseAccessToken(course._id, secret, now);
    await dependencies.recordSignup({
      email,
      courseId: course._id,
      courseTitle: course.title,
      sourcePath: `/courses/${course.slug}`,
      submittedAt: new Date(now),
    });
    await dependencies.setCookie(course._id, token, grant);
    return { success: true };
  } catch {
    dependencies.logError();
    return {
      success: false,
      error: "We could not complete your signup. Please try again.",
    };
  }
}
