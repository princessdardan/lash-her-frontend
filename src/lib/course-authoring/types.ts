import type {
  CandidateBody,
  CandidateSuccess,
} from "@/lib/api-integration/candidate-validation";

export type AuthoringCourse = CandidateSuccess<
  "course",
  "/v1/admin/courses/{courseId}",
  "get"
>["course"];
export type AuthoringModule = AuthoringCourse["modules"][number];
export type AuthoringLesson = AuthoringModule["lessons"][number];
export type CourseCreateInput = CandidateBody<
  "course",
  "/v1/admin/courses",
  "post"
>;
export type CourseUpdateInput = CandidateBody<
  "course",
  "/v1/admin/courses/{courseId}",
  "patch"
>;
export type ContentDocument = NonNullable<AuthoringLesson["contentDocument"]>;
