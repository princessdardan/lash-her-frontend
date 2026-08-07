import "server-only";

import type { EnabledCourseApiConfig } from "./config";
import {
  parsePublicCourseDetailResponse,
  parsePublicCourseListResponse,
  type PublicCourseDetail,
  type PublicCourseSummary,
} from "./contracts";
import {
  requestCourseApi,
  type CourseApiRequestContext,
  type CourseApiRequestRuntime,
} from "./request";

export interface PublicCourseClient {
  listCourses(
    context?: CourseApiRequestContext,
  ): Promise<PublicCourseSummary[]>;
  getCourseBySlug(
    slug: string,
    context?: CourseApiRequestContext,
  ): Promise<PublicCourseDetail>;
}

export function createPublicCourseClient(
  config: EnabledCourseApiConfig,
  runtime: CourseApiRequestRuntime = {},
): PublicCourseClient {
  return {
    async listCourses(context) {
      const response = await requestCourseApi({
        config,
        path: "/v1/courses",
        parse: parsePublicCourseListResponse,
        runtime,
        ...context,
      });
      return response.courses;
    },
    async getCourseBySlug(slug, context) {
      const response = await requestCourseApi({
        config,
        path: `/v1/courses/${encodeURIComponent(slug)}`,
        parse: parsePublicCourseDetailResponse,
        runtime,
        ...context,
      });
      return response.course;
    },
  };
}
