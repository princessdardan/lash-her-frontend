import type { CandidateSuccess } from "@/lib/api-integration/candidate-validation";

export type CatalogCourse = CandidateSuccess<"course", "/v1/courses", "get">["courses"][number];
export type PublicCourse = CandidateSuccess<"course", "/v1/courses/{slug}", "get">["course"];
export type LearnerCourse = CandidateSuccess<"course", "/v1/student/courses/{courseId}", "get">["course"];
export type AcademyCourse = CandidateSuccess<"course", "/v1/student/courses", "get">["courses"][number];
export type LearnerLesson = CandidateSuccess<"course", "/v1/student/lessons/{lessonId}", "get">["lesson"];
export type LessonProgress = CandidateSuccess<"course", "/v1/student/progress", "get">["progress"][number];
export type PlaybackAuthorization = CandidateSuccess<"course", "/v1/student/lessons/{lessonId}/playback", "get">;
export type LearnerQuiz = CandidateSuccess<"course", "/v1/student/lessons/{lessonId}/quiz", "get">["quiz"];
export type QuizAttempt = CandidateSuccess<"course", "/v1/student/lessons/{lessonId}/quiz/attempts", "get">["attempts"][number];
export type LessonQuizState = { kind: "none" } | { kind: "unavailable" } | { kind: "ready"; quiz: LearnerQuiz; attempts: QuizAttempt[] };
