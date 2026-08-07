import "server-only";

import type { EnabledCourseApiConfig } from "./config";
import {
  parsePlaybackResponse,
  parseProgressListResponse,
  parseRecordProgressResponse,
  parseStudentCourseDetailResponse,
  parseStudentLessonResponse,
  type LessonProgress,
  type PlaybackAuthorization,
  type RecordProgressCommand,
  type StudentCourseDetail,
  type StudentLesson,
} from "./contracts";
import { createCourseUserToken, type JwtRuntime } from "./jwt";
import {
  requestCourseApi,
  type CourseApiRequestContext,
  type CourseApiRequestRuntime,
} from "./request";

export interface StudentProgressQuery {
  courseId?: string;
  lessonId?: string;
}

export interface StudentCourseClient {
  getCourse(
    courseId: string,
    context?: CourseApiRequestContext,
  ): Promise<StudentCourseDetail>;
  getLesson(
    lessonId: string,
    context?: CourseApiRequestContext,
  ): Promise<StudentLesson>;
  listProgress(
    query?: StudentProgressQuery,
    context?: CourseApiRequestContext,
  ): Promise<LessonProgress[]>;
  recordProgress(
    lessonId: string,
    command: RecordProgressCommand,
    context?: CourseApiRequestContext,
  ): Promise<LessonProgress>;
  getPlayback(
    lessonId: string,
    context?: CourseApiRequestContext,
  ): Promise<PlaybackAuthorization>;
}

export interface StudentCourseClientRuntime
  extends CourseApiRequestRuntime, JwtRuntime {}

export function createStudentCourseClient(
  config: EnabledCourseApiConfig,
  userId: string,
  runtime: StudentCourseClientRuntime = {},
): StudentCourseClient {
  const request = <T>(
    path: string,
    parse: (value: unknown) => T,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      context?: CourseApiRequestContext;
    } = {},
  ) => {
    const { context, ...requestOptions } = options;
    return requestCourseApi({
      config,
      path,
      parse,
      runtime,
      cache: "no-store",
      token: createCourseUserToken(config.userJwt, userId, runtime),
      ...requestOptions,
      ...context,
    });
  };

  return {
    async getCourse(courseId, context) {
      const response = await request(
        `/v1/student/courses/${encodeURIComponent(courseId)}`,
        parseStudentCourseDetailResponse,
        { context },
      );
      return response.course;
    },
    async getLesson(lessonId, context) {
      const response = await request(
        `/v1/student/lessons/${encodeURIComponent(lessonId)}`,
        parseStudentLessonResponse,
        { context },
      );
      return response.lesson;
    },
    async listProgress(query = {}, context) {
      const search = new URLSearchParams();
      if (query.courseId !== undefined) search.set("courseId", query.courseId);
      if (query.lessonId !== undefined) search.set("lessonId", query.lessonId);
      const suffix = search.size === 0 ? "" : `?${search.toString()}`;
      const response = await request(
        `/v1/student/progress${suffix}`,
        parseProgressListResponse,
        { context },
      );
      return response.progress;
    },
    async recordProgress(lessonId, command, context) {
      const response = await request(
        `/v1/student/lessons/${encodeURIComponent(lessonId)}/progress`,
        parseRecordProgressResponse,
        { method: "POST", body: command, context },
      );
      return response.progress;
    },
    getPlayback(lessonId, context) {
      return request(
        `/v1/student/lessons/${encodeURIComponent(lessonId)}/playback`,
        parsePlaybackResponse,
        { context },
      );
    },
  };
}
