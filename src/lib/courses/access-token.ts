import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { COURSE_ACCESS_SECONDS, type CourseAccessGrant } from "./contract";

export function courseCookieName(courseId: string): string {
  return `lh_course_${createHash("sha256").update(courseId).digest("hex").slice(0, 24)}`;
}

export function createCourseAccessToken(
  courseId: string,
  secret: string,
  now = Date.now(),
) {
  assertSecret(secret);
  const grant: CourseAccessGrant = {
    version: 1,
    courseId,
    grantId: randomUUID(),
    expiresAt: Math.floor(now / 1000) + COURSE_ACCESS_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return { grant, token: `${payload}.${sign(payload, secret)}` };
}

export function verifyCourseAccessToken(
  token: string | undefined,
  courseId: string,
  secret: string,
  now = Date.now(),
): CourseAccessGrant | null {
  assertSecret(secret);
  if (!token || token.length > 2048) return null;
  const parts = token.split(".");
  if (
    parts.length !== 2 ||
    !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  )
    return null;
  const [payload, signature] = parts;
  const expected = Buffer.from(sign(payload, secret));
  const received = Buffer.from(signature);
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  )
    return null;
  try {
    const grant = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as CourseAccessGrant;
    const currentSeconds = Math.floor(now / 1000);
    if (
      grant?.version !== 1 ||
      grant.courseId !== courseId ||
      typeof grant.grantId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(grant.grantId) ||
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt <= currentSeconds ||
      grant.expiresAt > currentSeconds + COURSE_ACCESS_SECONDS
    )
      return null;
    return grant;
  } catch {
    return null;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`course-access:v1:${payload}`)
    .digest("base64url");
}

function assertSecret(secret: string) {
  if (secret.length < 32)
    throw new Error(
      "COURSE_ACCESS_SIGNING_SECRET must contain at least 32 characters",
    );
}
