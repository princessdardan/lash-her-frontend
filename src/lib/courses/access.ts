import "server-only";
import { cookies } from "next/headers";
import { courseCookieName, verifyCourseAccessToken } from "./access-token";

export function getCourseAccessSecret(): string {
  const secret = process.env.COURSE_ACCESS_SIGNING_SECRET?.trim();
  if (!secret || secret.length < 32)
    throw new Error("Missing or invalid COURSE_ACCESS_SIGNING_SECRET");
  return secret;
}

export async function readCourseAccess(courseId: string) {
  const token = (await cookies()).get(courseCookieName(courseId))?.value;
  if (!token) return null;
  return verifyCourseAccessToken(token, courseId, getCourseAccessSecret());
}
