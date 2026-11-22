import "server-only";

import { randomUUID } from "node:crypto";
import { mintApplicationToken } from "@/lib/api-integration/application-jwt";
import {
  type CandidateSuccess,
  validateCandidateRequest,
  validateCandidateResponse,
} from "@/lib/api-integration/candidate-validation";
import { getGatewayTransport } from "@/lib/api-integration/gateway-transport";
import {
  IntegrationServiceError,
  parseGatewayFailure,
  upstreamIntegrationError,
} from "@/lib/api-integration/service-errors";
import { reviewCourseSignature } from "../../../ops/gateway/staging-review-course.mjs";
import { reviewCourse, reviewSettings } from "./session";

type LessonPath = "/v1/student/lessons/{lessonId}";
type PlaybackPath = "/v1/student/lessons/{lessonId}/playback";
type ProgressPath = "/v1/student/progress";
type SavePath = "/v1/student/lessons/{lessonId}/progress";
type QuizPath = "/v1/student/lessons/{lessonId}/quiz";
type AttemptsPath = "/v1/student/lessons/{lessonId}/quiz/attempts";
type Operation =
  | LessonPath
  | PlaybackPath
  | ProgressPath
  | SavePath
  | QuizPath
  | AttemptsPath;
type CourseRead = "/v1/student/courses" | "/v1/student/courses/{courseId}";

async function reviewCourseRead<P extends CourseRead>(
  subject: string,
  contract: P,
): Promise<CandidateSuccess<"course", P, "get">> {
  if (reviewSettings()?.subject !== subject)
    throw new IntegrationServiceError("forbidden", 403);

  const response = await getGatewayTransport()({
    method: "GET",
    path: contract.replace("{courseId}", reviewCourse),
    applicationToken: mintApplicationToken({
      profile: "course-learner",
      customerId: subject,
    }),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const gatewayFailure = parseGatewayFailure(response, data);
    if (gatewayFailure) throw gatewayFailure.failure;
  }
  validateCandidateResponse("course", contract, "get", response.status, data);
  if (!response.ok) {
    const { error } = data as { error: { code: string } };
    throw upstreamIntegrationError(
      response.status,
      error.code,
      response.headers.get("x-request-id"),
      response.headers.get("retry-after"),
    );
  }
  return data as CandidateSuccess<"course", P, "get">;
}

export async function readReviewEnrollment(subject: string) {
  const { courses } = await reviewCourseRead(subject, "/v1/student/courses");
  return (
    courses.find(
      ({ id, status }) => id === reviewCourse && status === "published",
    ) ?? null
  );
}

export async function readReviewOutline(subject: string) {
  const { course } = await reviewCourseRead(
    subject,
    "/v1/student/courses/{courseId}",
  );
  if (course.id !== reviewCourse)
    throw new IntegrationServiceError("service_unavailable", 503);
  return {
    ...course,
    modules: course.modules
      .map((module) => ({
        ...module,
        lessons: module.lessons.filter(({ id }) =>
          Boolean(reviewCourseSettings(id)),
        ),
      }))
      .filter(({ lessons }) => lessons.length > 0),
  };
}

export function reviewCourseSettings(lessonId: string) {
  const config = reviewSettings();
  const key = process.env.STAGING_REVIEW_COURSE_KEY;
  const lessons = process.env.STAGING_REVIEW_COURSE_LESSONS?.split(",");
  if (
    !config ||
    !key ||
    !/^[0-9a-f]{64}$/u.test(key) ||
    lessons?.length !== 2 ||
    new Set(lessons).size !== 2 ||
    !lessons.includes(lessonId)
  )
    return null;
  return { ...config, key };
}

export async function reviewLessonRequest<
  P extends Operation,
  M extends "get" | "post",
>(
  config: NonNullable<ReturnType<typeof reviewCourseSettings>>,
  subject: string,
  lessonId: string,
  path: P,
  method: M,
  input?: unknown,
): Promise<CandidateSuccess<"course", P, M>> {
  if (subject !== config.subject)
    throw new IntegrationServiceError("forbidden", 403);
  const isProgressList = path === "/v1/student/progress";
  const query = isProgressList ? { lessonId } : undefined;
  const params = isProgressList ? undefined : { lessonId };
  validateCandidateRequest("course", path, method, {
    params,
    query,
    body: input,
  });
  const target = isProgressList
    ? `${path}?lessonId=${lessonId}`
    : path.replace("{lessonId}", lessonId);
  const verb = method === "get" ? "GET" : "POST";
  const body = input === undefined ? undefined : JSON.stringify(input);
  const token = mintApplicationToken({
    profile: "course-learner",
    customerId: subject,
  });
  const nonce = randomUUID();
  const expires = Math.min(config.end, Math.floor(Date.now() / 1000) + 30);
  const signature = reviewCourseSignature(config.key, {
    method: verb,
    target: "/course" + target,
    body: body ?? "",
    token,
    expires,
    nonce,
  });
  const response = await getGatewayTransport()({
    method: verb,
    path: target,
    body,
    applicationToken: token,
    stagingReviewCourseProof: `1.${expires}.${nonce}.${signature}`,
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const gatewayFailure = parseGatewayFailure(response, data);
    if (gatewayFailure) throw gatewayFailure.failure;
    validateCandidateResponse("course", path, method, response.status, data);
    const code = (data as { error: { code: string } }).error.code;
    throw upstreamIntegrationError(
      response.status,
      code,
      response.headers.get("x-request-id"),
      response.headers.get("retry-after"),
    );
  }
  validateCandidateResponse("course", path, method, response.status, data);
  return data as CandidateSuccess<"course", P, M>;
}
