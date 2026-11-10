import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { isAdminDeveloperModeEnabled } from "@/lib/admin/developer-mode-config";
import { resolveApplicationEnvironment } from "@/lib/env/application-environment.mjs";
import type { WriterAuthoringOperation, WriterFirstOwner, WriterIdentityEnrollment } from "./context";
import { P2_FIRST_OWNER_PATH, P2_FIRST_OWNER_SELECTOR_PREFIX } from "../../../ops/platform/p2-first-owner-identity.mjs";
import { parseAssessmentAttempt } from "../../../ops/gateway/assessment-attempt.mjs";
import { EXIT_SAVE_LESSON_STARTED, parseLessonExitSavePosition, parseLessonRestorePosition, parseLessonResumePosition,
  permitsLessonAckLossBody, permitsLessonStaleRevisionBody, RESTORE_LESSON_STARTED } from "../../../ops/gateway/lesson-resume-position.mjs";

export const INTERACTIVE_ORIGIN = "https://staging.lashher.com";
export const INTERACTIVE_COOKIE = "__Host-lash-p2q-window";
export const INTERACTIVE_HEADER = "x-lash-internal-interactive-admission";
export const INTERACTIVE_GATEWAY_PROOF_HEADER = "x-lash-certification-interactive";

const stages = ["identity", "authoring", "media", "learning", "learner-access", "lesson-entry", "lesson-denial", "lesson-assessment", "lesson-resume", "lesson-restore", "lesson-ack-loss", "lesson-exit-save", "lesson-visibility-save", "lesson-stale-revision", "stalled-playback-renewal", "paid-grant", "paid-revoke", "lifecycle"] as const;
type Stage = (typeof stages)[number];
const adminIdentitySelector = createHash("sha256").update(JSON.stringify(["identity", "admin"])).digest("hex");
const customerIdentityPrefix = "7032712d637573746f6d65722d763100";
const authoringActorPrefix = "7032712d617574686f72696e672d7631";
const authoringEditActorPrefix = "7032712d617574682d656469742d7631";
const authoringReorderActorPrefix = "7032712d617574682d736f72742d7631";
const authoringCreateCurriculumActorPrefix = "7032712d617574682d6e65772d763100";
const authoringPublishActorPrefix = "7032712d617574682d7075622d763100";
const authoringReviewPublicationActorPrefix = "7032712d617574682d7264792d763100";
const authoringSaveQuizActorPrefix = "7032712d617574682d7175697a2d7631";
const authoringArchivePaidActorPrefix = "7032712d617574682d6172632d763100";
const authoringRepublishPaidActorPrefix = "7032712d617574682d7265702d763100";
const authoringReviewPaidRestorationActorPrefix = "7032712d617574682d72626c2d763100";
type BrowserScope = { stage: Stage; identityActorKind?: "admin" | "customer"; identityEnrollment?: WriterIdentityEnrollment;
  firstOwner?: WriterFirstOwner;
  authoringOperation?: WriterAuthoringOperation; learnerAccess?: LearnerAccessSelection; mediaReservation?: LessonSelection;
  lessonEntry?: LessonSelection; lessonDenial?: LessonSelection; lessonAssessment?: LessonSelection;
  lessonResume?: LessonSelection; lessonRestore?: LessonSelection; lessonAckLoss?: LessonSelection; lessonExitSave?: LessonSelection;
  lessonVisibilitySave?: LessonSelection; lessonStaleRevision?: LessonSelection; stalledPlaybackRenewal?: LessonSelection };
export type LearningEnrollmentSelection = Readonly<{ actorId: string; idempotencyKey: string }>;
export type PaidGrantSelection = Readonly<{ actorId: string; idempotencyKey: string }>;
export type PaidRevokeSelection = Readonly<{ actorId: string; idempotencyKey: string }>;
export type LearnerAccessSelection = Readonly<{ actorId: string; lessonId: string }>;
export type LessonSelection = Readonly<{ actorId: string; courseId: string; lessonId: string }>;
type BrowserPermit = BrowserScope & { epoch: string; nonce: string; lifecycleSelectionSha256?: string; identityCustomerId?: string;
  authoringActorId?: string; learningEnrollment?: LearningEnrollmentSelection; paidGrant?: PaidGrantSelection; paidRevoke?: PaidRevokeSelection };
type Binding = { key: string; deploymentHost: string; source: string; target: string };
const gatewayOrigin = "https://api-staging.lashher.com";
const gatewayStages = new Set<Stage>(["authoring", "media", "learning", "learner-access", "lesson-entry", "lesson-denial", "lesson-assessment", "lesson-resume", "lesson-restore", "lesson-ack-loss", "lesson-exit-save", "lesson-visibility-save", "lesson-stale-revision", "stalled-playback-renewal", "paid-grant", "paid-revoke"]);
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const at = (pattern: string) => new RegExp(`^(?:${pattern})$`, "u");
const canonicalUuid = at(uuid);
const signedDigest = /^[a-f0-9]{64}$/u;
const lessonSelector = /^[a-f0-9]{96}$/u;
const initialLessonProgress = '{"event":"lesson_started","expectedProgressRevision":0}';
const epochPattern = /^[1-9][0-9]{0,17}$/u;
const maxLeaseSeconds = 600;
const maxRequestSeconds = 30;
const adminGoogleAction = new AsyncLocalStorage<true>();

export function withinInteractiveAdminGoogleAction<T>(task: () => Promise<T>): Promise<T> {
  return adminGoogleAction.run(true, task);
}

const customerIdentityReads = at("/sign-in|/api/customer-auth/(?:csrf|providers|session)");
const staffAuth = {
  GET: at("/admin/(?:sign-in|not-authorized)|/api/auth/(?:csrf|providers|session|callback/google)"),
  POST: at("/admin/sign-in|/api/auth/(?:signin/google|signout)"),
};
const firstOwnerAuth = {
  GET: at(`/admin/sign-in|/api/auth/callback/google|${P2_FIRST_OWNER_PATH}`),
  POST: at("/admin/sign-in"),
};
const authoringEdit = {
  GET: at(`/(?:api/)?admin/courses/${uuid}`),
  PATCH: at(`/api/admin/courses/${uuid}`),
};
const authoringReorder = {
  GET: authoringEdit.GET,
  POST: at(`/api/admin/(?:courses/${uuid}/modules|modules/${uuid}/lessons)/reorder`),
};
const authoringCreateCurriculum = {
  GET: authoringEdit.GET,
  POST: at(`/api/admin/(?:courses/${uuid}/modules|modules/${uuid}/lessons)`),
};
const authoringReviewPublication = {
  GET: at(`/admin/courses/${uuid}|/api/admin/courses/${uuid}(?:/publication-readiness)?`),
};
const authoringPublish = { ...authoringReviewPublication, PATCH: authoringEdit.PATCH };
const authoringSaveQuiz = {
  GET: at(`/(?:api/)?admin/courses/${uuid}|/api/admin/lessons/${uuid}/quiz`),
  PUT: at(`/api/admin/lessons/${uuid}/quiz`),
};
const learning = {
  GET: at(`/academy/courses/${uuid}|/courses/[a-z0-9]+(?:-[a-z0-9]+)*`),
  POST: at(`/api/academy/courses/${uuid}/enrollments`),
};
const learnerAccessReads = at(`/academy/courses/${uuid}|/api/academy/(?:courses/${uuid}|progress)`);
const learnerAccessLessonRead = at(`/api/academy/lessons/(${uuid})(?:/playback|/quiz(?:/attempts)?)?`);
const paidGrant = {
  GET: at(`/admin/courses/${uuid}/manual-grants`),
  POST: at(`/api/admin/courses/${uuid}/manual-grants`),
};
const paidRevoke = {
  GET: at(`/admin/courses/${uuid}/manual-grants/revoke`),
  POST: at(`/api/admin/courses/${uuid}/manual-grants/revoke`),
};
const lifecycle = {
  GET: at(`/account|/admin/customer-accounts|/api/account(?:/exports/${uuid})?`),
  POST: at(`/api/account/(?:preferences|commands)|/api/admin/customer-accounts/${uuid}/commands`),
};

function matches(routes: Readonly<Partial<Record<string, RegExp>>>, method: string, path: string) {
  return Object.hasOwn(routes, method) && routes[method]?.test(path) === true;
}

function permitsCustomerAuth(method: string, path: string, provider?: WriterIdentityEnrollment["provider"]): boolean {
  if (method === "GET" && customerIdentityReads.test(path)) return true;
  if (method !== "GET" && method !== "POST") return false;
  const prefix = method === "GET" ? "/api/customer-auth/callback/" : "/api/customer-auth/signin/";
  return provider === undefined ? path === prefix + "google" || path === prefix + "resend" : path === prefix + provider;
}

function permits({ stage, identityActorKind, identityEnrollment, firstOwner, authoringOperation, learnerAccess, mediaReservation, lessonEntry, lessonDenial, lessonAssessment,
  lessonResume, lessonRestore, lessonAckLoss, lessonExitSave, lessonVisibilitySave, lessonStaleRevision, stalledPlaybackRenewal }: BrowserScope, method: string, path: string): boolean {
  switch (stage) {
    case "identity":
      if (firstOwner) return matches(firstOwnerAuth, method, path);
      if (identityActorKind === "admin") return matches(staffAuth, method, path);
      return identityActorKind === "customer" && permitsCustomerAuth(method, path, identityEnrollment?.provider);
    case "authoring":
      if (authoringOperation === "save-quiz-revision") return matches(authoringSaveQuiz, method, path);
      if (authoringOperation === "publish-course" || authoringOperation === "republish-paid-course" || authoringOperation === "review-paid-restoration") {
        return matches(authoringPublish, method, path);
      }
      if (authoringOperation === "review-publication") return matches(authoringReviewPublication, method, path);
      if (authoringOperation === "create-curriculum") return matches(authoringCreateCurriculum, method, path);
      if (authoringOperation === "reorder-curriculum") return matches(authoringReorder, method, path);
      if (authoringOperation === "edit-draft" || authoringOperation === "archive-paid-course") return matches(authoringEdit, method, path);
      return authoringOperation === "create-draft" && ((method === "GET" && path === "/admin/courses") || (method === "POST" && path === "/api/admin/courses"));
    case "media": {
      if (!mediaReservation) return false;
      const lesson = `/api/admin/lessons/${mediaReservation.lessonId}`;
      if (method === "GET") return path === `/admin/courses/${mediaReservation.courseId}` || path === `${lesson}/video`;
      return method === "POST" && path === `${lesson}/video-upload`;
    }
    case "learning": return matches(learning, method, path);
    case "learner-access": return method === "GET" && learnerAccess !== undefined &&
      (learnerAccessReads.test(path) || learnerAccessLessonRead.exec(path)?.[1] === learnerAccess.lessonId);
    case "lesson-entry": {
      if (!lessonEntry) return false;
      const course = `/academy/courses/${lessonEntry.courseId}`;
      const lesson = `/api/academy/lessons/${lessonEntry.lessonId}`;
      return method === "GET" && [course, `${course}/lessons/${lessonEntry.lessonId}`, `${lesson}/playback`].includes(path) ||
        method === "POST" && path === `${lesson}/progress`;
    }
    case "lesson-denial": {
      if (!lessonDenial || method !== "GET") return false;
      const { courseId, lessonId } = lessonDenial;
      const api = `/api/academy/lessons/${lessonId}`;
      return [`/academy/courses/${courseId}/lessons/${lessonId}`, api, `${api}/playback`,
        `/api/academy/progress?lessonId=${lessonId}`, `${api}/quiz`, `${api}/quiz/attempts`].includes(path);
    }
    case "lesson-assessment": {
      if (!lessonAssessment) return false;
      const { courseId, lessonId } = lessonAssessment;
      const api = `/api/academy/lessons/${lessonId}`;
      if (method === "GET") return [
        `/academy/courses/${courseId}/lessons/${lessonId}`, `${api}/playback`,
        `/api/academy/progress?lessonId=${lessonId}`,
      ].includes(path);
      return method === "POST" && [`${api}/progress`, `${api}/quiz/attempts`].includes(path);
    }
    case "stalled-playback-renewal": {
      if (!stalledPlaybackRenewal || method !== "GET") return false;
      const { courseId, lessonId } = stalledPlaybackRenewal;
      return path === `/academy/courses/${courseId}/lessons/${lessonId}` || path === `/api/academy/lessons/${lessonId}/playback`;
    }
    case "lesson-resume":
    case "lesson-restore":
    case "lesson-ack-loss":
    case "lesson-exit-save":
    case "lesson-visibility-save":
    case "lesson-stale-revision": {
      const selected = stage === "lesson-stale-revision" ? lessonStaleRevision :
        stage === "lesson-visibility-save" ? lessonVisibilitySave : stage === "lesson-exit-save" ? lessonExitSave :
        stage === "lesson-ack-loss" ? lessonAckLoss : stage === "lesson-restore" ? lessonRestore : lessonResume;
      if (!selected) return false;
      const { courseId, lessonId } = selected;
      const api = `/api/academy/lessons/${lessonId}`;
      if (method === "GET") return path === `/academy/courses/${courseId}/lessons/${lessonId}` || path === `${api}/playback` ||
        stage === "lesson-exit-save" && path === `/academy/courses/${courseId}` ||
        (stage === "lesson-ack-loss" || stage === "lesson-stale-revision") && path === `/api/academy/progress?lessonId=${lessonId}`;
      return method === "POST" && path === `${api}/progress`;
    }
    case "paid-grant": return matches(paidGrant, method, path);
    case "paid-revoke": return matches(paidRevoke, method, path);
    case "lifecycle": return matches(lifecycle, method, path) || (method === "GET" && path === "/api/customer-auth/session");
  }
}

function binding(env: Record<string, string | undefined>): Binding | null {
  if (env.FRONTEND_WRITER_ADMISSION_MODE !== "enforce" || env.APP_ENV !== "staging" ||
    env.VERCEL_ENV !== "production" || env.VERCEL_TARGET_ENV !== "production" || isAdminDeveloperModeEnabled(env)) return null;
  const key = env.CRON_SECRET, deploymentHost = env.VERCEL_URL, source = env.VERCEL_GIT_COMMIT_SHA;
  if (!key || !/^[!-~]{32,8192}$/u.test(key) || !deploymentHost ||
    !/^[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(deploymentHost) || !source || !/^[a-f0-9]{40}$/u.test(source)) return null;
  try {
    if (resolveApplicationEnvironment(env) !== "staging") return null;
    const target: unknown = JSON.parse(env.FRONTEND_WRITER_ADMISSION_TARGET_JSON ?? "").targetSha256;
    if (typeof target === "string" && signedDigest.test(target)) return { key, deploymentHost, source, target };
  } catch { return null; }
  return null;
}

function signature(authority: Binding, domain: "browser" | "request", value: string): string {
  return createHmac("sha256", authority.key)
    .update(`lash-her:p2q:interactive:${domain}:v1\n${authority.deploymentHost}\n${authority.source}\n${authority.target}\n${value}`)
    .digest("hex");
}

function authentic(actual: string | undefined, expected: string): boolean {
  return !!actual && signedDigest.test(actual) && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function decodeCompactUuid(hex: string): string | undefined {
  const id = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  return canonicalUuid.test(id) ? id : undefined;
}

function decodeSelectedUuid(selection: string, prefix: string): string | undefined {
  return selection.startsWith(prefix) ? decodeCompactUuid(selection.slice(prefix.length)) : undefined;
}

function decodeIdentityEnrollment(selection: string, nonce: string): WriterIdentityEnrollment | undefined {
  const prefix = selection.slice(0, 2);
  if (prefix !== "a1" && prefix !== "a2") return undefined;
  return { provider: prefix === "a1" ? "google" : "resend", nonce, emailDigest: selection.slice(2) };
}

function browserProof(authority: Binding, cookie: string, now: number): BrowserPermit | null {
  if (cookie.length > 263) return null;
  const fields = cookie.split(".");
  const [version, epoch, stage, started, expires, nonce, selection] = fields;
  const maxCookieLength = stage === "stalled-playback-renewal" ? 263 :
    stage === "lesson-visibility-save" ? 261 : stage === "lesson-stale-revision" ? 260 : 256;
  if (cookie.length > maxCookieLength) return null;
  const lessonStage = stage === "media" || stage === "lesson-entry" || stage === "lesson-denial" || stage === "lesson-assessment" ||
    stage === "lesson-resume" || stage === "lesson-restore" || stage === "lesson-ack-loss" || stage === "lesson-exit-save" ||
    stage === "lesson-visibility-save" || stage === "lesson-stale-revision" || stage === "stalled-playback-renewal";
  const hasSelection = lessonStage || stage === "lifecycle" || stage === "identity" || stage === "authoring" || stage === "learning" ||
    stage === "learner-access" || stage === "paid-grant" || stage === "paid-revoke";
  const selectorShape = lessonStage ? lessonSelector : signedDigest;
  if ((hasSelection ? version !== "v2" || fields.length !== 8 || !selectorShape.test(selection ?? "")
    : version !== "v1" || fields.length !== 7) ||
    !epochPattern.test(epoch ?? "") || !stages.includes(stage as Stage) ||
    !/^\d{10}$/u.test(started ?? "") || !/^\d{10}$/u.test(expires ?? "") || !/^[a-f0-9]{32}$/u.test(nonce ?? "") ||
    Number(started) > now || Number(expires) <= now || Number(expires) - Number(started) > maxLeaseSeconds ||
    !authentic(fields.at(-1), signature(authority, "browser", fields.slice(0, -1).join(".")))) return null;
  const permit = { epoch, stage: stage as Stage, nonce };
  if (lessonStage) {
    const actorId = decodeCompactUuid(selection.slice(0, 32));
    const courseId = decodeCompactUuid(selection.slice(32, 64));
    const lessonId = decodeCompactUuid(selection.slice(64));
    if (!actorId || !courseId || !lessonId) return null;
    const selected = { actorId, courseId, lessonId };
    if (stage === "media") return { ...permit, mediaReservation: selected, authoringActorId: actorId };
    if (stage === "lesson-entry") return { ...permit, lessonEntry: selected };
    if (stage === "lesson-denial") return { ...permit, lessonDenial: selected };
    if (stage === "lesson-assessment") return { ...permit, lessonAssessment: selected };
    if (stage === "lesson-restore") return { ...permit, lessonRestore: selected };
    if (stage === "lesson-ack-loss") return { ...permit, lessonAckLoss: selected };
    if (stage === "lesson-exit-save") return { ...permit, lessonExitSave: selected };
    if (stage === "lesson-visibility-save") return { ...permit, lessonVisibilitySave: selected };
    if (stage === "lesson-stale-revision") return { ...permit, lessonStaleRevision: selected };
    if (stage === "stalled-playback-renewal") return { ...permit, stalledPlaybackRenewal: selected };
    return { ...permit, lessonResume: selected };
  }
  if (stage === "learner-access") {
    const actorId = decodeCompactUuid(selection.slice(0, 32));
    const lessonId = decodeCompactUuid(selection.slice(32));
    return actorId && lessonId ? { ...permit, learnerAccess: { actorId, lessonId } } : null;
  }
  if (stage === "learning" || stage === "paid-grant" || stage === "paid-revoke") {
    const actorId = decodeCompactUuid(selection.slice(0, 32));
    const idempotencyKey = decodeCompactUuid(selection.slice(32));
    if (!actorId || !idempotencyKey) return null;
    const selected = { actorId, idempotencyKey };
    if (stage === "learning") return { ...permit, learningEnrollment: selected };
    return stage === "paid-grant" ? { ...permit, paidGrant: selected } : { ...permit, paidRevoke: selected };
  }
  if (stage === "identity") {
    if (selection === adminIdentitySelector) return { ...permit, identityActorKind: "admin" };
    if (selection.startsWith(P2_FIRST_OWNER_SELECTOR_PREFIX) && !/^0+$/u.test(nonce)) {
      return { ...permit, identityActorKind: "admin", firstOwner: { nonce, identityDigest: selection.slice(2), epoch, startedAt: Number(started) } };
    }
    const identityCustomerId = decodeSelectedUuid(selection, customerIdentityPrefix);
    if (identityCustomerId) return { ...permit, identityActorKind: "customer", identityCustomerId };
    const identityEnrollment = decodeIdentityEnrollment(selection, nonce);
    return identityEnrollment ? { ...permit, identityActorKind: "customer", identityEnrollment } : null;
  }
  if (stage === "authoring") {
    const authoringActorId = decodeSelectedUuid(selection, authoringActorPrefix);
    if (authoringActorId) return { ...permit, authoringActorId, authoringOperation: "create-draft" };
    const editActorId = decodeSelectedUuid(selection, authoringEditActorPrefix);
    if (editActorId) return { ...permit, authoringActorId: editActorId, authoringOperation: "edit-draft" };
    const reorderActorId = decodeSelectedUuid(selection, authoringReorderActorPrefix);
    if (reorderActorId) return { ...permit, authoringActorId: reorderActorId, authoringOperation: "reorder-curriculum" };
    const createCurriculumActorId = decodeSelectedUuid(selection, authoringCreateCurriculumActorPrefix);
    if (createCurriculumActorId) return { ...permit, authoringActorId: createCurriculumActorId, authoringOperation: "create-curriculum" };
    const publishActorId = decodeSelectedUuid(selection, authoringPublishActorPrefix);
    if (publishActorId) return { ...permit, authoringActorId: publishActorId, authoringOperation: "publish-course" };
    const reviewActorId = decodeSelectedUuid(selection, authoringReviewPublicationActorPrefix);
    if (reviewActorId) return { ...permit, authoringActorId: reviewActorId, authoringOperation: "review-publication" };
    const quizActorId = decodeSelectedUuid(selection, authoringSaveQuizActorPrefix);
    if (quizActorId) return { ...permit, authoringActorId: quizActorId, authoringOperation: "save-quiz-revision" };
    const archiveActorId = decodeSelectedUuid(selection, authoringArchivePaidActorPrefix);
    if (archiveActorId) return { ...permit, authoringActorId: archiveActorId, authoringOperation: "archive-paid-course" };
    const republishActorId = decodeSelectedUuid(selection, authoringRepublishPaidActorPrefix);
    if (republishActorId) return { ...permit, authoringActorId: republishActorId, authoringOperation: "republish-paid-course" };
    const reviewRestorationActorId = decodeSelectedUuid(selection, authoringReviewPaidRestorationActorPrefix);
    return reviewRestorationActorId ? { ...permit, authoringActorId: reviewRestorationActorId, authoringOperation: "review-paid-restoration" } : null;
  }
  return { ...permit, lifecycleSelectionSha256: stage === "lifecycle" ? selection : undefined };
}

// A browser cookie is accepted only on selected paths. Proxy issues a short
// internal proof of the route it actually selected and never forwards it as a
// response header.
export function attestInteractiveRequest(request: { origin: string; method: string; path: string; search?: string; cookie: string },
  env: Record<string, string | undefined> = process.env, now = Math.floor(Date.now() / 1000)): string | null {
  if (request.origin !== INTERACTIVE_ORIGIN || request.path.length > 512) return null;
  const authority = binding(env);
  const browser = authority && browserProof(authority, request.cookie, now);
  if (!authority || !browser ||
    (["media", "lesson-entry", "lesson-resume", "lesson-restore", "lesson-exit-save", "lesson-visibility-save",
      "stalled-playback-renewal"].includes(browser.stage) && request.search)) return null;
  // Next strips its internal Flight key before proxy runs. Retain the exact
  // remaining search string for the selected progress read.
  const target = ["lesson-denial", "lesson-assessment", "lesson-ack-loss", "lesson-stale-revision"].includes(browser.stage)
    ? request.path + (request.search ?? "") : request.path;
  if (!permits(browser, request.method, target)) return null;
  const route = Buffer.from(`${request.method} ${target}`).toString("base64url");
  const value = `${now}.${route}`;
  return `${value}.${signature(authority, "request", `${request.cookie}\n${value}`)}`;
}

export function interactiveRequestHeaders(request: NextRequest): Headers | undefined {
  const cookies = request.cookies.getAll(INTERACTIVE_COOKIE);
  if (cookies.length === 0 && !request.headers.has(INTERACTIVE_HEADER)) return undefined;
  const headers = new Headers(request.headers);
  headers.delete(INTERACTIVE_HEADER);
  const proof = cookies.length === 1 ? attestInteractiveRequest({
    origin: request.nextUrl.origin, method: request.method, path: request.nextUrl.pathname, search: request.nextUrl.search, cookie: cookies[0].value,
  }) : null;
  if (proof) headers.set(INTERACTIVE_HEADER, proof);
  return headers;
}

function verifiedInteractiveRequest(authority: Binding, proof: string, cookie: string, now: number) {
  if (proof.length > 780) return null;
  const browser = browserProof(authority, cookie, now);
  if (!browser) return null;
  const [issued, route, mac, extra] = proof.split(".");
  if (extra !== undefined || !/^\d{10}$/u.test(issued ?? "") || !/^[A-Za-z0-9_-]+$/u.test(route ?? "") ||
    Number(issued) > now || now - Number(issued) >= maxRequestSeconds ||
    !authentic(mac, signature(authority, "request", `${cookie}\n${issued}.${route}`))) return null;
  const [method, path, trailing] = Buffer.from(route, "base64url").toString().split(" ");
  if (trailing !== undefined || !method || !path || !permits(browser, method, path)) return null;
  if (method === "POST" && path === "/admin/sign-in" && !adminGoogleAction.getStore()) return null;
  // The verified route also bounds what the lesson can open in the
  // writer ledger and what that request can sign for the gateway.
  return { ...browser, method, path };
}

export function readInteractiveRequest(proof: string, cookie: string, env: Record<string, string | undefined> = process.env,
  now = Math.floor(Date.now() / 1000)): { epoch: string; producerSha256: string; source: string; target: string;
    lifecycleSelectionSha256?: string; identityCustomerId?: string; identityEnrollment?: WriterIdentityEnrollment; firstOwner?: WriterFirstOwner;
    authoringActorId?: string; authoringOperation?: WriterAuthoringOperation; learningEnrollment?: LearningEnrollmentSelection;
    paidGrant?: PaidGrantSelection; paidRevoke?: PaidRevokeSelection; learnerAccess?: LearnerAccessSelection;
    lessonEntry?: LessonSelection; lessonDenial?: LessonSelection;
    lessonAssessment?: LessonSelection; lessonAssessmentWrite?: boolean; lessonResume?: LessonSelection; lessonResumeWrite?: boolean;
    lessonRestore?: LessonSelection; lessonRestoreWrite?: boolean; lessonAckLoss?: LessonSelection; lessonAckLossWrite?: boolean;
    lessonExitSave?: LessonSelection; lessonExitSaveWrite?: boolean;
    lessonVisibilitySave?: LessonSelection; lessonVisibilitySaveWrite?: boolean;
    lessonStaleRevision?: LessonSelection; lessonStaleRevisionWrite?: boolean;
    stalledPlaybackRenewal?: LessonSelection } | null {
  const authority = binding(env);
  const browser = authority && verifiedInteractiveRequest(authority, proof, cookie, now);
  if (!authority || !browser) return null;
  const { source, target } = authority;
  const producerSha256 = createHash("sha256").update(`lash-her:p2q:interactive-producer:v1\n${source}\n${target}`).digest("hex");
  return { epoch: browser.epoch, producerSha256, source, target,
    ...(browser.lifecycleSelectionSha256 ? { lifecycleSelectionSha256: browser.lifecycleSelectionSha256 } : {}),
    ...(browser.identityCustomerId ? { identityCustomerId: browser.identityCustomerId } : {}),
    ...(browser.identityEnrollment ? { identityEnrollment: browser.identityEnrollment } : {}),
    ...(browser.firstOwner ? { firstOwner: browser.firstOwner } : {}),
    ...(browser.authoringActorId ? { authoringActorId: browser.authoringActorId, authoringOperation: browser.authoringOperation } : {}),
    ...(browser.learningEnrollment ? { learningEnrollment: browser.learningEnrollment } : {}),
    ...(browser.paidGrant ? { paidGrant: browser.paidGrant } : {}),
    ...(browser.paidRevoke ? { paidRevoke: browser.paidRevoke } : {}),
    ...(browser.learnerAccess ? { learnerAccess: browser.learnerAccess } : {}),
    ...(browser.lessonEntry ? { lessonEntry: browser.lessonEntry } : {}),
    ...(browser.lessonDenial ? { lessonDenial: browser.lessonDenial } : {}),
    ...(browser.lessonAssessment ? { lessonAssessment: browser.lessonAssessment, lessonAssessmentWrite: browser.method === "POST" } : {}),
    ...(browser.lessonResume ? { lessonResume: browser.lessonResume, lessonResumeWrite: browser.method === "POST" } : {}),
    ...(browser.lessonRestore ? { lessonRestore: browser.lessonRestore, lessonRestoreWrite: browser.method === "POST" } : {}),
    ...(browser.lessonAckLoss ? { lessonAckLoss: browser.lessonAckLoss, lessonAckLossWrite: browser.method === "POST" } : {}),
    ...(browser.lessonExitSave ? { lessonExitSave: browser.lessonExitSave, lessonExitSaveWrite: browser.method === "POST" } : {}),
    ...(browser.lessonVisibilitySave ? { lessonVisibilitySave: browser.lessonVisibilitySave, lessonVisibilitySaveWrite: browser.method === "POST" } : {}),
    ...(browser.lessonStaleRevision ? { lessonStaleRevision: browser.lessonStaleRevision, lessonStaleRevisionWrite: browser.method === "POST" } : {}),
    ...(browser.stalledPlaybackRenewal ? { stalledPlaybackRenewal: browser.stalledPlaybackRenewal } : {}) };
}

export async function readInteractiveBrowserRequest(): Promise<ReturnType<typeof readInteractiveRequest>> {
  if (process.env.APP_ENV !== "staging" || process.env.VERCEL_ENV !== "production") return null;
  try {
    const { cookies, headers } = await import("next/headers");
    const proof = (await headers()).get(INTERACTIVE_HEADER);
    if (!proof) return null;
    const permits = (await cookies()).getAll(INTERACTIVE_COOKIE);
    return permits.length === 1 ? readInteractiveRequest(proof, permits[0].value) : null;
  } catch { return null; }
}

// Write routes must refuse the valid read-only cookie even when the proxy
// correctly declined to issue an internal request proof for the write.
export function hasStalledPlaybackRenewalPermit(request: Request): boolean {
  const cookies = request.headers.get("cookie"), prefix = `${INTERACTIVE_COOKIE}=`;
  if (!cookies?.includes(prefix) || new URL(request.url).origin !== INTERACTIVE_ORIGIN) return false;
  const authority = binding(process.env);
  if (!authority) return false;
  const now = Math.floor(Date.now() / 1000);
  return cookies.split(";").some(part => {
    const field = part.trim();
    if (!field.startsWith(prefix)) return false;
    try { return browserProof(authority, decodeURIComponent(field.slice(prefix.length)), now)?.stalledPlaybackRenewal !== undefined; }
    catch { return false; }
  });
}

type ScopedCourseRequest = { method: string; target: string; body?: string; idempotencyKey?: string };

export function validMediaReservationBody(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    !("expectedCourseRevision" in body) || !("expectedCurrentVideoAssetId" in body) || Object.keys(body).length !== 2) return false;
  const { expectedCourseRevision: revision, expectedCurrentVideoAssetId: current } = body;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 1 && revision < 2_147_483_647 &&
    (current === null || typeof current === "string" && canonicalUuid.test(current));
}

function permitsMediaReservationCourseRequest(browser: NonNullable<ReturnType<typeof verifiedInteractiveRequest>>,
  request: ScopedCourseRequest): boolean {
  const selection = browser.mediaReservation;
  if (!selection || browser.method !== request.method || request.idempotencyKey !== undefined) return false;
  const { courseId, lessonId } = selection;
  const lesson = `/course/v1/admin/lessons/${lessonId}`;
  if (request.method === "GET" && request.body === undefined) {
    if (browser.path === `/admin/courses/${courseId}`) return request.target === `/course/v1/admin/courses/${courseId}`;
    return browser.path === `/api/admin/lessons/${lessonId}/video` && request.target === `${lesson}/video`;
  }
  return browser.path === `/api/admin/lessons/${lessonId}/video-upload` &&
    request.method === "POST" && request.target === `${lesson}/video-upload` &&
    typeof request.body === "string" && validMediaReservationBody(JSON.parse(request.body));
}

export function permitsLessonDenialCourseRequest({ courseId, lessonId }: LessonSelection, request: ScopedCourseRequest): boolean {
  const student = "/course/v1/student", lesson = `${student}/lessons/${lessonId}`;
  return request.method === "GET" && request.body === undefined && request.idempotencyKey === undefined && [
    `${student}/courses/${courseId}`, lesson, `${student}/progress?lessonId=${lessonId}`,
    `${lesson}/quiz`, `${lesson}/quiz/attempts`, `${lesson}/playback`,
  ].includes(request.target);
}

export function permitsLessonEntryCourseRequest(selection: LessonSelection, request: ScopedCourseRequest): boolean {
  const student = "/course/v1/student";
  const lesson = `${student}/lessons/${selection.lessonId}`;
  if (request.idempotencyKey !== undefined) return false;
  if (request.method === "POST") return request.target === `${lesson}/progress` && request.body === initialLessonProgress;
  return permitsLessonDenialCourseRequest(selection, request) || (
    request.method === "GET" && request.body === undefined && request.target === `${student}/progress?courseId=${selection.courseId}`
  );
}

export function permitsLessonAssessmentCourseRequest(selection: LessonSelection, request: ScopedCourseRequest): boolean {
  if (request.method === "GET") return permitsLessonDenialCourseRequest(selection, request);
  if (request.method !== "POST" || request.idempotencyKey !== undefined) return false;
  const lesson = `/course/v1/student/lessons/${selection.lessonId}`;
  return request.target === `${lesson}/progress` && request.body === initialLessonProgress ||
    request.target === `${lesson}/quiz/attempts` && typeof request.body === "string" && parseAssessmentAttempt(request.body) !== null;
}

export function permitsLessonResumeCourseRequest(selection: LessonSelection, request: ScopedCourseRequest): boolean {
  if (request.method === "GET") return permitsLessonDenialCourseRequest(selection, request);
  return request.method === "POST" && request.idempotencyKey === undefined &&
    request.target === `/course/v1/student/lessons/${selection.lessonId}/progress` && typeof request.body === "string" &&
    (request.body === initialLessonProgress || parseLessonResumePosition(request.body) !== null);
}

export function permitsLessonRestoreCourseRequest(selection: LessonSelection, request: ScopedCourseRequest): boolean {
  if (request.method === "GET") return permitsLessonDenialCourseRequest(selection, request);
  return request.method === "POST" && request.idempotencyKey === undefined &&
    request.target === `/course/v1/student/lessons/${selection.lessonId}/progress` && typeof request.body === "string" &&
    (request.body === RESTORE_LESSON_STARTED || parseLessonRestorePosition(request.body) !== null);
}

export function permitsLessonAckLossCourseRequest(selection: LessonSelection, request: ScopedCourseRequest): boolean {
  if (request.method === "GET") return permitsLessonDenialCourseRequest(selection, request);
  return request.method === "POST" && request.idempotencyKey === undefined &&
    request.target === `/course/v1/student/lessons/${selection.lessonId}/progress` && typeof request.body === "string" &&
    permitsLessonAckLossBody(request.body);
}

export function permitsLessonExitSaveCourseRequest(selection: LessonSelection, request: ScopedCourseRequest): boolean {
  if (request.method === "GET") return permitsLessonEntryCourseRequest(selection, request);
  return request.method === "POST" && request.idempotencyKey === undefined &&
    request.target === `/course/v1/student/lessons/${selection.lessonId}/progress` && typeof request.body === "string" &&
    (request.body === EXIT_SAVE_LESSON_STARTED || parseLessonExitSavePosition(request.body) !== null);
}

export function permitsLessonVisibilitySaveCourseRequest(selection: LessonSelection, request: ScopedCourseRequest): boolean {
  return request.method === "GET" ? permitsLessonDenialCourseRequest(selection, request) :
    permitsLessonExitSaveCourseRequest(selection, request);
}

export function permitsLessonStaleRevisionCourseRequest(selection: LessonSelection, request: ScopedCourseRequest): boolean {
  if (request.method === "GET") return permitsLessonDenialCourseRequest(selection, request);
  return request.method === "POST" && request.idempotencyKey === undefined &&
    request.target === `/course/v1/student/lessons/${selection.lessonId}/progress` && typeof request.body === "string" &&
    permitsLessonStaleRevisionBody(request.body);
}

function lessonSourcePermits(browser: NonNullable<ReturnType<typeof verifiedInteractiveRequest>>, selection: LessonSelection,
  request: ScopedCourseRequest): boolean {
  if (browser.method !== request.method) return false;
  const lesson = `/course/v1/student/lessons/${selection.lessonId}`;
  const courseProgress = `/course/v1/student/progress?courseId=${selection.courseId}`;
  if (browser.lessonExitSave && browser.path === `/academy/courses/${selection.courseId}`) {
    return request.method === "GET" &&
      [`/course/v1/student/courses/${selection.courseId}`, courseProgress].includes(request.target);
  }
  if (browser.path === `/academy/courses/${selection.courseId}/lessons/${selection.lessonId}`) {
    return request.method === "GET" && request.target !== `${lesson}/playback` && request.target !== courseProgress;
  }
  if (browser.path === `/api/academy/progress?lessonId=${selection.lessonId}`) {
    return request.target === `/course/v1/student/progress?lessonId=${selection.lessonId}`;
  }
  return request.target === browser.path.replace("/api/academy/", "/course/v1/student/");
}

export async function interactiveCourseGatewayProof(request: {
  url: URL; method: string; requestId: string; body?: string; applicationToken?: string; idempotencyKey?: string;
}): Promise<string | null> {
  const { url, method, requestId } = request;
  const target = url.pathname + url.search;
  const configuredOrigin = process.env.API_GATEWAY_STAGING_ORIGIN;
  if ((configuredOrigin !== gatewayOrigin && configuredOrigin !== gatewayOrigin + "/") ||
    url.origin !== gatewayOrigin || url.href !== gatewayOrigin + target || !url.pathname.startsWith("/course/v1/") ||
    !canonicalUuid.test(requestId)) return null;
  const authority = binding(process.env);
  if (!authority) return null;

  try {
    const { cookies, headers } = await import("next/headers");
    const proof = (await headers()).get(INTERACTIVE_HEADER);
    if (!proof) return null;
    const permits = (await cookies()).getAll(INTERACTIVE_COOKIE);
    const issued = Math.floor(Date.now() / 1000);
    const browser = permits.length === 1 && verifiedInteractiveRequest(authority, proof, permits[0].value, issued);
    if (!browser || !gatewayStages.has(browser.stage) ||
      (browser.stage === "media" && !permitsMediaReservationCourseRequest(browser, { ...request, target })) ||
      (browser.lessonEntry && !permitsLessonEntryCourseRequest(browser.lessonEntry, { ...request, target })) ||
      (browser.lessonDenial && !permitsLessonDenialCourseRequest(browser.lessonDenial, { ...request, target })) ||
      (browser.lessonAssessment && (!permitsLessonAssessmentCourseRequest(browser.lessonAssessment, { ...request, target }) ||
        !lessonSourcePermits(browser, browser.lessonAssessment, { ...request, target }))) ||
      (browser.lessonResume && (!permitsLessonResumeCourseRequest(browser.lessonResume, { ...request, target }) ||
        !lessonSourcePermits(browser, browser.lessonResume, { ...request, target }))) ||
      (browser.lessonRestore && (!permitsLessonRestoreCourseRequest(browser.lessonRestore, { ...request, target }) ||
        !lessonSourcePermits(browser, browser.lessonRestore, { ...request, target }))) ||
      (browser.lessonAckLoss && (!permitsLessonAckLossCourseRequest(browser.lessonAckLoss, { ...request, target }) ||
        !lessonSourcePermits(browser, browser.lessonAckLoss, { ...request, target }))) ||
      (browser.lessonExitSave && (!permitsLessonExitSaveCourseRequest(browser.lessonExitSave, { ...request, target }) ||
        !lessonSourcePermits(browser, browser.lessonExitSave, { ...request, target }))) ||
      (browser.lessonVisibilitySave && (!permitsLessonVisibilitySaveCourseRequest(browser.lessonVisibilitySave, { ...request, target }) ||
        !lessonSourcePermits(browser, browser.lessonVisibilitySave, { ...request, target }))) ||
      (browser.lessonStaleRevision && (!permitsLessonStaleRevisionCourseRequest(browser.lessonStaleRevision, { ...request, target }) ||
        !lessonSourcePermits(browser, browser.lessonStaleRevision, { ...request, target }))) ||
      (browser.stalledPlaybackRenewal && (!permitsLessonDenialCourseRequest(browser.stalledPlaybackRenewal, { ...request, target }) ||
        !lessonSourcePermits(browser, browser.stalledPlaybackRenewal, { ...request, target })))) return null;
    const { deploymentHost, source, target: frontendTarget } = authority;
    const { epoch, stage, nonce } = browser;
    // This window key stays local. Only the MAC over this exact outbound
    // request is sent to the gateway.
    const key = createHmac("sha256", authority.key)
      .update(`lash-her:p2q:interactive:gateway-key:v1\n${deploymentHost}\n${source}\n${frontendTarget}\n${epoch}\n${stage}\n${nonce}`)
      .digest();
    const hashes = [request.body, request.applicationToken, request.idempotencyKey]
      .map(value => createHash("sha256").update(value ?? "").digest("hex"));
    const mac = createHmac("sha256", key).update([
      "lash-her:p2q:interactive:gateway-request:v1", issued, requestId, method, target, ...hashes,
    ].join("\n")).digest("hex");
    return `v1.${issued}.${requestId}.${mac}`;
  } catch {
    // Commands outside browser request context still use the ordinary
    // transport and cannot supply an interactive proof.
    return null;
  }
}
