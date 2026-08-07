export type AcademyCourseApiErrorCode =
  | "ACCESS_REVOKED"
  | "ARCHIVED_UNSUPPORTED"
  | "COURSE_API_UNAVAILABLE"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "PAYMENT_ACCESS_PROCESSING"
  | "VIDEO_PROCESSING";

export class AcademyCourseApiError extends Error {
  constructor(
    readonly code: AcademyCourseApiErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AcademyCourseApiError";
  }
}

export interface AcademyLessonSummary {
  id: string;
  title: string;
  completed: boolean;
}

export interface AcademyCourseDetail {
  id: string;
  title: string;
  description?: string | null;
  lessons: AcademyLessonSummary[];
}

export interface AcademyLessonDetail {
  courseId: string;
  id: string;
  title: string;
  writtenContent?: string | null;
}

export interface AcademyPlayback {
  expiresAt: string;
  playbackId: string;
  playbackToken: string;
}

export interface AcademyProgressInput {
  completed?: boolean;
  positionSeconds?: number;
}

export interface AcademyProgress {
  completed: boolean;
  positionSeconds: number;
}

export interface AcademyCourseApi {
  getCourse(input: {
    courseId: string;
    userId: string;
  }): Promise<AcademyCourseDetail>;
  getLesson(input: {
    courseId: string;
    lessonId: string;
    userId: string;
  }): Promise<AcademyLessonDetail>;
  getPlayback(input: {
    courseId: string;
    lessonId: string;
    userId: string;
  }): Promise<AcademyPlayback>;
  updateProgress(input: {
    courseId: string;
    lessonId: string;
    progress: AcademyProgressInput;
    userId: string;
  }): Promise<AcademyProgress>;
}
