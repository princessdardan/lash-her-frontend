import "server-only";

export type CourseStatus = "draft" | "published" | "archived";
export type ProgressEvent = "lesson_started" | "lesson_completed";
export type EntitlementStatus = "active" | "revoked" | "expired";
export type GrantReason = "purchase" | "promotion" | "import";
export type RevokeReason = "refund" | "dispute" | "expiry";
export type ReconcileExpectedStatus = "active" | "revoked" | "missing";
export type ReconcileActualStatus = EntitlementStatus | "missing";
export type ReconcileMismatchType =
  | "missing_active_grant"
  | "unexpected_active_grant"
  | "status_mismatch"
  | "source_requires_review"
  | "missing_user"
  | "missing_course"
  | "duplicate_grant"
  | "admin_override"
  | "expired_grant"
  | "order_not_found";
export type ReconcileSuggestedAction = "grant" | "revoke" | "investigate";

export interface PublicCourseSummary {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  priceCents: number;
  currency: string;
}

export interface PublicLesson {
  id: string;
  slug: string;
  title: string;
  isPreview: true;
  position: number;
}

export interface PublicModule {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  position: number;
  lessons: PublicLesson[];
}

export interface PublicCourseDetail extends PublicCourseSummary {
  modules: PublicModule[];
}

export interface StudentLesson {
  id: string;
  moduleId: string;
  slug: string;
  title: string;
  content: string | null;
  isPreview: boolean;
  position: number;
}

export interface StudentModule {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  position: number;
  lessons: StudentLesson[];
}

export interface StudentCourseDetail extends PublicCourseSummary {
  modules: StudentModule[];
}

export interface LessonProgress {
  id: string;
  userId: string;
  lessonId: string;
  enrollmentId: string | null;
  maxPositionSeconds: number;
  completedAt: string | null;
  lastWatchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybackAuthorization {
  playbackToken: string;
  playbackId: string;
  expiresAt: string;
}

export interface RecordProgressCommand {
  event?: ProgressEvent;
  maxPositionSeconds?: number;
}

export interface GrantEntitlementCommand {
  readonly userId: string;
  readonly courseId: string;
  readonly orderId: string;
  readonly externalPaymentId?: string;
  readonly provider?: "helcim" | "square";
  readonly idempotencyKey: string;
  readonly grantReason: GrantReason;
  readonly grantedAt: string;
  readonly expiresAt?: string | null;
}

export interface RevokeEntitlementCommand {
  readonly userId: string;
  readonly courseId: string;
  readonly orderId: string;
  readonly revokeReason: RevokeReason;
  readonly idempotencyKey: string;
  readonly revokedAt: string;
}

export interface CheckEntitlementQuery {
  readonly userId: string;
  readonly courseId: string;
}

export interface ReconcileEntitlementGrant {
  readonly userId: string;
  readonly courseId: string;
  readonly orderId: string;
  readonly expectedStatus: ReconcileExpectedStatus;
}

export interface ReconcileEntitlementScope {
  readonly userId: string;
  readonly courseId: string;
}

export interface ReconcileEntitlementsCommand {
  readonly checkpoint?: string | null;
  readonly pageSize?: number;
  readonly snapshotComplete?: boolean;
  readonly scopes?: readonly ReconcileEntitlementScope[];
  readonly grants: readonly ReconcileEntitlementGrant[];
}

export interface EntitlementGrantResult {
  grantId: string;
  userId: string;
  courseId: string;
  status: EntitlementStatus;
  createdAt: string;
  idempotentReplay?: true;
}

export interface EntitlementRevokeResult {
  grantId: string;
  userId: string;
  courseId: string;
  status: EntitlementStatus;
  revokedAt: string;
  idempotentReplay?: true;
}

export interface EntitlementCheckResult {
  userId: string;
  courseId: string;
  hasAccess: boolean;
  grantId: string | null;
  expiresAt: string | null;
}

export interface ReconcileEntitlementMismatch {
  userId: string;
  courseId: string;
  orderId: string;
  expectedStatus: ReconcileExpectedStatus;
  actualStatus: ReconcileActualStatus;
  mismatchType: ReconcileMismatchType;
  suggestedAction: ReconcileSuggestedAction;
}

export interface ReconcileEntitlementsResult {
  checkpoint: string;
  mismatches: ReconcileEntitlementMismatch[];
}

export interface CourseApiErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

export class CourseApiContractError extends Error {
  constructor(path: string) {
    super(`Invalid Course API response at ${path}`);
    this.name = "CourseApiContractError";
  }
}

export function parsePublicCourseListResponse(value: unknown): {
  courses: PublicCourseSummary[];
} {
  const object = record(value, "$");
  return {
    courses: array(object.courses, "$.courses", parsePublicCourseSummary),
  };
}

export function parsePublicCourseDetailResponse(value: unknown): {
  course: PublicCourseDetail;
} {
  const object = record(value, "$");
  return { course: parsePublicCourseDetail(object.course, "$.course") };
}

export function parseStudentCourseDetailResponse(value: unknown): {
  course: StudentCourseDetail;
} {
  const object = record(value, "$");
  return { course: parseStudentCourseDetail(object.course, "$.course") };
}

export function parseStudentLessonResponse(value: unknown): {
  lesson: StudentLesson;
} {
  const object = record(value, "$");
  return { lesson: parseStudentLesson(object.lesson, "$.lesson") };
}

export function parseProgressListResponse(value: unknown): {
  progress: LessonProgress[];
} {
  const object = record(value, "$");
  return {
    progress: array(object.progress, "$.progress", parseLessonProgress),
  };
}

export function parseRecordProgressResponse(value: unknown): {
  progress: LessonProgress;
} {
  const object = record(value, "$");
  return { progress: parseLessonProgress(object.progress, "$.progress") };
}

export function parsePlaybackResponse(value: unknown): PlaybackAuthorization {
  const object = record(value, "$");
  return {
    playbackToken: string(object.playbackToken, "$.playbackToken"),
    playbackId: string(object.playbackId, "$.playbackId"),
    expiresAt: dateTime(object.expiresAt, "$.expiresAt"),
  };
}

export function parseEntitlementGrantResponse(
  value: unknown,
): EntitlementGrantResult {
  const object = record(value, "$");
  const result: EntitlementGrantResult = {
    grantId: uuid(object.grantId, "$.grantId"),
    userId: string(object.userId, "$.userId"),
    courseId: uuid(object.courseId, "$.courseId"),
    status: entitlementStatus(object.status, "$.status"),
    createdAt: dateTime(object.createdAt, "$.createdAt"),
  };
  if (object.idempotentReplay !== undefined) {
    if (object.idempotentReplay !== true) fail("$.idempotentReplay");
    result.idempotentReplay = true;
  }
  return result;
}

export function parseEntitlementRevokeResponse(
  value: unknown,
): EntitlementRevokeResult {
  const object = record(value, "$");
  const result: EntitlementRevokeResult = {
    grantId: uuid(object.grantId, "$.grantId"),
    userId: string(object.userId, "$.userId"),
    courseId: uuid(object.courseId, "$.courseId"),
    status: entitlementStatus(object.status, "$.status"),
    revokedAt: dateTime(object.revokedAt, "$.revokedAt"),
  };
  if (object.idempotentReplay !== undefined) {
    if (object.idempotentReplay !== true) fail("$.idempotentReplay");
    result.idempotentReplay = true;
  }
  return result;
}

export function parseEntitlementCheckResponse(
  value: unknown,
): EntitlementCheckResult {
  const object = record(value, "$");
  return {
    userId: string(object.userId, "$.userId"),
    courseId: uuid(object.courseId, "$.courseId"),
    hasAccess: boolean(object.hasAccess, "$.hasAccess"),
    grantId: nullable(object.grantId, "$.grantId", uuid),
    expiresAt: nullable(object.expiresAt, "$.expiresAt", dateTime),
  };
}

export function parseReconcileEntitlementsResponse(
  value: unknown,
): ReconcileEntitlementsResult {
  const object = record(value, "$");
  return {
    checkpoint: dateTime(object.checkpoint, "$.checkpoint"),
    mismatches: array(
      object.mismatches,
      "$.mismatches",
      parseReconcileMismatch,
    ),
  };
}

export function parseCourseApiErrorEnvelope(
  value: unknown,
): CourseApiErrorEnvelope | null {
  try {
    const object = record(value, "$");
    const error = record(object.error, "$.error");
    return {
      error: {
        code: boundedString(error.code, "$.error.code", 128),
        message: boundedString(error.message, "$.error.message", 1_000),
      },
    };
  } catch {
    return null;
  }
}

function parsePublicCourseSummary(
  value: unknown,
  path: string,
): PublicCourseSummary {
  const object = record(value, path);
  return {
    id: uuid(object.id, `${path}.id`),
    slug: string(object.slug, `${path}.slug`),
    title: string(object.title, `${path}.title`),
    description: nullable(object.description, `${path}.description`, string),
    priceCents: nonnegativeInteger(object.priceCents, `${path}.priceCents`),
    currency: currency(object.currency, `${path}.currency`),
  };
}

function parsePublicCourseDetail(
  value: unknown,
  path: string,
): PublicCourseDetail {
  const object = record(value, path);
  return {
    ...parsePublicCourseSummary(object, path),
    modules: array(object.modules, `${path}.modules`, parsePublicModule),
  };
}

function parsePublicModule(value: unknown, path: string): PublicModule {
  const object = record(value, path);
  return {
    id: uuid(object.id, `${path}.id`),
    slug: string(object.slug, `${path}.slug`),
    title: string(object.title, `${path}.title`),
    description: nullable(object.description, `${path}.description`, string),
    position: integer(object.position, `${path}.position`),
    lessons: array(object.lessons, `${path}.lessons`, parsePublicLesson),
  };
}

function parsePublicLesson(value: unknown, path: string): PublicLesson {
  const object = record(value, path);
  if (object.isPreview !== true) fail(`${path}.isPreview`);
  return {
    id: uuid(object.id, `${path}.id`),
    slug: string(object.slug, `${path}.slug`),
    title: string(object.title, `${path}.title`),
    isPreview: true,
    position: integer(object.position, `${path}.position`),
  };
}

function parseStudentCourseDetail(
  value: unknown,
  path: string,
): StudentCourseDetail {
  const object = record(value, path);
  return {
    ...parsePublicCourseSummary(object, path),
    modules: array(object.modules, `${path}.modules`, parseStudentModule),
  };
}

function parseStudentModule(value: unknown, path: string): StudentModule {
  const object = record(value, path);
  return {
    id: uuid(object.id, `${path}.id`),
    slug: string(object.slug, `${path}.slug`),
    title: string(object.title, `${path}.title`),
    description: nullable(object.description, `${path}.description`, string),
    position: integer(object.position, `${path}.position`),
    lessons: array(object.lessons, `${path}.lessons`, parseStudentLesson),
  };
}

function parseStudentLesson(value: unknown, path: string): StudentLesson {
  const object = record(value, path);
  return {
    id: uuid(object.id, `${path}.id`),
    moduleId: uuid(object.moduleId, `${path}.moduleId`),
    slug: string(object.slug, `${path}.slug`),
    title: string(object.title, `${path}.title`),
    content: nullable(object.content, `${path}.content`, string),
    isPreview: boolean(object.isPreview, `${path}.isPreview`),
    position: integer(object.position, `${path}.position`),
  };
}

function parseLessonProgress(value: unknown, path: string): LessonProgress {
  const object = record(value, path);
  return {
    id: uuid(object.id, `${path}.id`),
    userId: string(object.userId, `${path}.userId`),
    lessonId: uuid(object.lessonId, `${path}.lessonId`),
    enrollmentId: nullable(object.enrollmentId, `${path}.enrollmentId`, uuid),
    maxPositionSeconds: boundedInteger(
      object.maxPositionSeconds,
      `${path}.maxPositionSeconds`,
      0,
      2_147_483_647,
    ),
    completedAt: nullable(object.completedAt, `${path}.completedAt`, dateTime),
    lastWatchedAt: nullable(
      object.lastWatchedAt,
      `${path}.lastWatchedAt`,
      dateTime,
    ),
    createdAt: dateTime(object.createdAt, `${path}.createdAt`),
    updatedAt: dateTime(object.updatedAt, `${path}.updatedAt`),
  };
}

function parseReconcileMismatch(
  value: unknown,
  path: string,
): ReconcileEntitlementMismatch {
  const object = record(value, path);
  return {
    userId: string(object.userId, `${path}.userId`),
    courseId: uuid(object.courseId, `${path}.courseId`),
    orderId: string(object.orderId, `${path}.orderId`),
    expectedStatus: expectedStatus(
      object.expectedStatus,
      `${path}.expectedStatus`,
    ),
    actualStatus: actualStatus(object.actualStatus, `${path}.actualStatus`),
    mismatchType: mismatchType(object.mismatchType, `${path}.mismatchType`),
    suggestedAction: suggestedAction(
      object.suggestedAction,
      `${path}.suggestedAction`,
    ),
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path);
  return value;
}

function array<T>(
  value: unknown,
  path: string,
  parser: (entry: unknown, path: string) => T,
): T[] {
  if (!isUnknownArray(value)) fail(path);
  return value.map((entry, index) => parser(entry, `${path}[${index}]`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function nullable<T>(
  value: unknown,
  path: string,
  parser: (entry: unknown, path: string) => T,
): T | null {
  return value === null ? null : parser(value, path);
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path);
  return value;
}

function boundedString(value: unknown, path: string, maximum: number): string {
  const parsed = string(value, path);
  if (parsed.length === 0 || parsed.length > maximum) fail(path);
  return parsed;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path);
  return value;
}

function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(path);
  return value;
}

function nonnegativeInteger(value: unknown, path: string): number {
  return boundedInteger(value, path, 0, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = integer(value, path);
  if (parsed < minimum || parsed > maximum) fail(path);
  return parsed;
}

function uuid(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      parsed,
    )
  )
    fail(path);
  return parsed;
}

function dateTime(value: unknown, path: string): string {
  const parsed = string(value, path);
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      parsed,
    );
  if (
    parts === null ||
    !validCalendarDate(Number(parts[1]), Number(parts[2]), Number(parts[3])) ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6]) > 59 ||
    (parts[8] !== undefined && Number(parts[8]) > 23) ||
    (parts[9] !== undefined && Number(parts[9]) > 59) ||
    Number.isNaN(Date.parse(parsed))
  ) {
    fail(path);
  }
  return parsed;
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function currency(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!/^[A-Z]{3}$/u.test(parsed)) fail(path);
  return parsed;
}

function entitlementStatus(value: unknown, path: string): EntitlementStatus {
  if (value !== "active" && value !== "revoked" && value !== "expired")
    fail(path);
  return value;
}

function expectedStatus(value: unknown, path: string): ReconcileExpectedStatus {
  if (value !== "active" && value !== "revoked" && value !== "missing")
    fail(path);
  return value;
}

function actualStatus(value: unknown, path: string): ReconcileActualStatus {
  if (
    value !== "active" &&
    value !== "revoked" &&
    value !== "expired" &&
    value !== "missing"
  )
    fail(path);
  return value;
}

function mismatchType(value: unknown, path: string): ReconcileMismatchType {
  if (
    value !== "missing_active_grant" &&
    value !== "unexpected_active_grant" &&
    value !== "status_mismatch" &&
    value !== "source_requires_review" &&
    value !== "missing_user" &&
    value !== "missing_course" &&
    value !== "duplicate_grant" &&
    value !== "admin_override" &&
    value !== "expired_grant" &&
    value !== "order_not_found"
  )
    fail(path);
  return value;
}

function suggestedAction(
  value: unknown,
  path: string,
): ReconcileSuggestedAction {
  if (value !== "grant" && value !== "revoke" && value !== "investigate")
    fail(path);
  return value;
}

function fail(path: string): never {
  throw new CourseApiContractError(path);
}
