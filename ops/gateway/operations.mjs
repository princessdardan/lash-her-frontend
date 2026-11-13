import { createServer } from "node:http";
import { matchRoute } from "./policy.mjs";

// These groups classify only the current browser journeys. The gateway and
// Course receiver must still enforce workload and application authentication.
const interactiveCourseGroups = {
  catalog: [
    "GET /v1/courses",
    "GET /v1/courses/{slug}",
  ],
  authoring: [
    "GET /v1/admin/courses",
    "POST /v1/admin/courses",
    "GET /v1/admin/courses/{courseId}",
    "PATCH /v1/admin/courses/{courseId}",
    "GET /v1/admin/courses/{courseId}/publication-readiness",
    "POST /v1/admin/courses/{courseId}/modules",
    "POST /v1/admin/courses/{courseId}/modules/reorder",
    "PATCH /v1/admin/modules/{moduleId}",
    "POST /v1/admin/modules/{moduleId}/lessons",
    "POST /v1/admin/modules/{moduleId}/lessons/reorder",
    "PATCH /v1/admin/lessons/{lessonId}",
    "GET /v1/admin/lessons/{lessonId}/quiz",
    "PUT /v1/admin/lessons/{lessonId}/quiz",
  ],
  media: [
    "GET /v1/admin/lessons/{lessonId}/video",
    "POST /v1/admin/lessons/{lessonId}/video-upload",
    "POST /v1/admin/lessons/{lessonId}/video/{videoAssetId}/refresh",
    "POST /v1/admin/lessons/{lessonId}/video/{videoAssetId}/captions",
    "DELETE /v1/admin/lessons/{lessonId}/video/{videoAssetId}/captions/{trackId}",
  ],
  learning: [
    "GET /v1/student/courses",
    "GET /v1/student/courses/{courseId}",
    "GET /v1/student/courses/{courseId}/lessons",
    "POST /v1/student/courses/{courseId}/enrollments",
    "POST /v1/student/courses/{courseId}/legacy-progress",
    "GET /v1/student/lessons/{lessonId}",
    "GET /v1/student/lessons/{lessonId}/playback",
    "POST /v1/student/lessons/{lessonId}/progress",
    "GET /v1/student/lessons/{lessonId}/quiz",
    "GET /v1/student/lessons/{lessonId}/quiz/attempts",
    "POST /v1/student/lessons/{lessonId}/quiz/attempts",
    "GET /v1/student/progress",
  ],
  "paid-grant": [
    "GET /v1/admin/entitlements/commands",
    "GET /v1/admin/entitlements/grants",
    "POST /v1/admin/entitlements/grants",
  ],
  "paid-revoke": ["POST /v1/admin/entitlements/revocations"],
};
const interactiveCourseOperations = new Map(Object.entries(interactiveCourseGroups)
  .flatMap(([group, operations]) => operations.map(operation => [operation, group])));
const interactiveCourseParameters = {
  "{slug}": /^(?=.{1,120}$)[a-z0-9]+(?:-[a-z0-9]+)*$/u,
  "{trackId}": /^[A-Za-z0-9_-]{1,255}$/u,
};
const courseUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const learnerAccessPath = /^\/course\/v1\/student\/(?:courses\/[^/]+|lessons\/[^/]+(?:\/(?:playback|quiz(?:\/attempts)?))?)$/u;
const learnerAccessProgress = /^\/course\/v1\/student\/progress\?(?:courseId|lessonId)=([a-f0-9-]+)$/u;
const selectedLessonProgress = /^\/course\/v1\/student\/progress\?lessonId=([a-f0-9-]+)$/u;
const lessonEntryProgress = /^\/course\/v1\/student\/lessons\/[^/]+\/progress$/u;
const lessonAssessmentAttempt = /^\/course\/v1\/student\/lessons\/[^/]+\/quiz\/attempts$/u;
const authoringCourseDetail = /^\/course\/v1\/admin\/courses\/[^/]+$/u;
const paidRevokeCommands = /^\/course\/v1\/admin\/entitlements\/commands\?idempotencyKey=owner-paid-revoke%3A([a-f0-9-]+)&limit=2$/u;
const paidRevokeGrants = /^\/course\/v1\/admin\/entitlements\/grants\?grantId=([a-f0-9-]+)&userId=([a-f0-9-]+)&courseId=([a-f0-9-]+)&limit=2$/u;

// Pass the raw, query-free gateway pathname. Admission remains a separate step.
// Paid-grant readback also uses the authoring course-detail GET.
export function interactiveCourseOperation(method, pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/course/") || pathname.includes("?")) return null;
  const route = matchRoute(method, pathname);
  if (!route) return null;
  const group = interactiveCourseOperations.get(`${method} ${route.path}`);
  if (!group || route.auth !== (group === "catalog" ? "workload" : "application") || route.admission === "recovery") return null;
  const parts = pathname.slice("/course".length).split("/");
  const valid = route.path.split("/").every((part, index) =>
    !part.startsWith("{") || (interactiveCourseParameters[part] ?? courseUuid).test(parts[index]));
  return valid ? group : null;
}

export function interactiveCourseStagePermits(stage, method, target) {
  if (typeof target !== "string") return false;
  const path = target.split("?", 1)[0];
  const group = interactiveCourseOperation(method, path);
  if (group === null) return false;
  if (stage === "paid-revoke") {
    if (method === "POST") return group === stage && path === target;
    if (method !== "GET") return false;
    if (group === "authoring") return path === target && authoringCourseDetail.test(path);
    const lookup = group === "paid-grant" && (paidRevokeCommands.exec(target) ?? paidRevokeGrants.exec(target));
    return !!lookup && lookup.slice(1).every(id => courseUuid.test(id));
  }
  if (stage === group && stage !== "catalog") return true;
  if (["lesson-entry", "lesson-resume", "lesson-restore", "lesson-ack-loss", "lesson-exit-save", "lesson-visibility-save", "lesson-stale-revision"].includes(stage) && group === "learning" && method === "POST") {
    return path === target && lessonEntryProgress.test(path);
  }
  if (stage === "lesson-assessment" && group === "learning" && method === "POST") {
    return path === target && (lessonEntryProgress.test(path) || lessonAssessmentAttempt.test(path));
  }
  if (method !== "GET") return false;
  if (stage === "media") return group === "authoring";
  if (stage === "learning") return group === "catalog";
  if (["lesson-denial", "lesson-assessment", "lesson-resume", "lesson-restore", "lesson-ack-loss", "lesson-visibility-save", "lesson-stale-revision",
    "stalled-playback-renewal"].includes(stage) && group === "learning") {
    const lessonId = selectedLessonProgress.exec(target)?.[1];
    return path === target && learnerAccessPath.test(path) || lessonId !== undefined && courseUuid.test(lessonId);
  }
  if (["learner-access", "lesson-entry", "lesson-exit-save"].includes(stage) && group === "learning") {
    const progressId = learnerAccessProgress.exec(target)?.[1];
    return path === target && learnerAccessPath.test(path) || progressId !== undefined && courseUuid.test(progressId);
  }
  if (stage === "paid-grant") {
    return group === "authoring" && authoringCourseDetail.test(path);
  }
  return false;
}

export function createOperationsServer(counters, gauges = {}, admissionState) {
  return createServer({ maxHeaderSize: 4096, requestTimeout: 2000 }, (req, res) => {
    res.setHeader("cache-control", "no-store");
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"ok"}');
    } else if (req.method === "GET" && req.url === "/admission" && admissionState) {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(admissionState()));
    } else if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end([
        ...Object.entries(counters).map(([name, value]) => `lash_gateway_${name}_total ${value}`),
        ...Object.entries(gauges).map(([name, value]) => `lash_gateway_${name} ${value}`),
      ].join("\n") + "\n");
    } else { res.writeHead(404); res.end(); }
  });
}
