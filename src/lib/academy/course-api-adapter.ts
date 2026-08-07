import { AcademyCourseApiError, type AcademyCourseApi } from "./course-api";
import {
  readCourseApiConfig,
  requireEnabledCourseApiConfig,
} from "@/lib/course-api/config";
import { CourseApiError } from "@/lib/course-api/errors";
import {
  createStudentCourseClient,
  type StudentCourseClient,
} from "@/lib/course-api/student-client";

export interface AcademyCourseApiAdapterDependencies {
  createClient: (userId: string) => StudentCourseClient;
}

// This is the only academy file coupled to the upstream course client.
export function getAcademyCourseApi(): AcademyCourseApi {
  return createAcademyCourseApi({ createClient: studentClient });
}

export function createAcademyCourseApi(
  dependencies: AcademyCourseApiAdapterDependencies,
): AcademyCourseApi {
  return {
    async getCourse({ courseId, userId }) {
      return mapErrors(async () => {
        const client = dependencies.createClient(userId);
        const [course, progress] = await Promise.all([
          client.getCourse(courseId),
          client.listProgress({ courseId }),
        ]);
        const progressByLesson = new Map(
          progress.map((entry) => [entry.lessonId, entry]),
        );

        return {
          id: course.id,
          title: course.title,
          description: course.description,
          lessons: course.modules.flatMap((module) =>
            module.lessons.map((lesson) => ({
              id: lesson.id,
              title: lesson.title,
              completed:
                (progressByLesson.get(lesson.id)?.completedAt ?? null) !== null,
            })),
          ),
        };
      });
    },
    async getLesson({ courseId, lessonId, userId }) {
      return mapErrors(async () => {
        const client = dependencies.createClient(userId);
        const expectedModuleId = await requireCourseLesson(
          client,
          courseId,
          lessonId,
        );
        const lesson = await client.getLesson(lessonId);
        if (lesson.id !== lessonId || lesson.moduleId !== expectedModuleId) {
          throw new AcademyCourseApiError("NOT_FOUND");
        }
        return {
          courseId,
          id: lesson.id,
          title: lesson.title,
          writtenContent: lesson.content,
        };
      });
    },
    async getPlayback({ courseId, lessonId, userId }) {
      return mapErrors(async () => {
        const client = dependencies.createClient(userId);
        await requireCourseLesson(client, courseId, lessonId);
        return client.getPlayback(lessonId);
      });
    },
    async updateProgress({ courseId, lessonId, progress, userId }) {
      return mapErrors(async () => {
        const client = dependencies.createClient(userId);
        await requireCourseLesson(client, courseId, lessonId);
        const updated = await client.recordProgress(lessonId, {
          event:
            progress.completed === true ? "lesson_completed" : "lesson_started",
          ...(progress.positionSeconds === undefined
            ? {}
            : { maxPositionSeconds: progress.positionSeconds }),
        });
        return {
          completed: updated.completedAt !== null,
          positionSeconds: updated.maxPositionSeconds,
        };
      });
    },
  };
}

async function requireCourseLesson(
  client: StudentCourseClient,
  courseId: string,
  lessonId: string,
): Promise<string> {
  const course = await client.getCourse(courseId);
  if (course.id !== courseId) throw new AcademyCourseApiError("NOT_FOUND");

  for (const courseModule of course.modules) {
    if (courseModule.lessons.some((lesson) => lesson.id === lessonId)) {
      return courseModule.id;
    }
  }
  throw new AcademyCourseApiError("NOT_FOUND");
}

function studentClient(userId: string) {
  try {
    const config = requireEnabledCourseApiConfig(readCourseApiConfig());
    return createStudentCourseClient(config, userId);
  } catch (error) {
    throw mapCourseApiError(error);
  }
}

async function mapErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapCourseApiError(error);
  }
}

function mapCourseApiError(error: unknown): AcademyCourseApiError {
  if (error instanceof AcademyCourseApiError) return error;
  if (!(error instanceof CourseApiError)) {
    return new AcademyCourseApiError("COURSE_API_UNAVAILABLE");
  }

  const upstreamCode = error.upstreamCode?.toLowerCase() ?? "";
  if (error.status === 403 || upstreamCode.includes("revoked")) {
    return new AcademyCourseApiError("ACCESS_REVOKED");
  }
  if (error.status === 404) return new AcademyCourseApiError("NOT_FOUND");
  if (error.status === 410 || upstreamCode.includes("archived")) {
    return new AcademyCourseApiError("ARCHIVED_UNSUPPORTED");
  }
  if (
    upstreamCode.includes("payment_pending") ||
    upstreamCode.includes("access_processing")
  ) {
    return new AcademyCourseApiError("PAYMENT_ACCESS_PROCESSING");
  }
  if (
    error.status === 409 ||
    upstreamCode.includes("video_processing") ||
    upstreamCode.includes("playback_processing")
  ) {
    return new AcademyCourseApiError("VIDEO_PROCESSING");
  }
  if (error.kind === "request") {
    return new AcademyCourseApiError("INVALID_REQUEST");
  }
  return new AcademyCourseApiError("COURSE_API_UNAVAILABLE");
}
