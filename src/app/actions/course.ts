"use server";

import { cookies, headers } from "next/headers";
import { loaders } from "@/data/loaders";
import { recordCourseSignupSubmission } from "@/lib/marketing-contact/marketing-contact-store";
import { getCourseAccessSecret, readCourseAccess } from "@/lib/courses/access";
import { courseCookieName } from "@/lib/courses/access-token";
import {
  COURSE_ACCESS_SECONDS,
  type CourseSignupInput,
} from "@/lib/courses/contract";
import { checkCourseSignupRateLimit } from "@/lib/courses/rate-limit";
import { signupForCourse } from "@/lib/courses/signup";

export async function submitCourseSignup(input: CourseSignupInput) {
  return signupForCourse(input, {
    getCourse: loaders.getShortCourseSignupDetails,
    getSecret: getCourseAccessSecret,
    getToken: async (id) => (await cookies()).get(courseCookieName(id))?.value,
    checkRateLimit: async (email) =>
      checkCourseSignupRateLimit(email, await headers()),
    recordSignup: recordCourseSignupSubmission,
    setCookie: async (id, token, grant) => {
      (await cookies()).set(courseCookieName(id), token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: COURSE_ACCESS_SECONDS,
        expires: new Date(grant.expiresAt * 1000),
      });
    },
    now: Date.now,
    logError: (details) =>
      console.error(
        "[course-signup] Signup failed before access could be confirmed",
        details,
      ),
  });
}

// A separate request verifies that the browser actually accepted Set-Cookie.
export async function confirmCourseAccess(courseId: string): Promise<boolean> {
  if (typeof courseId !== "string" || courseId.length > 128) return false;
  return (await readCourseAccess(courseId)) !== null;
}
