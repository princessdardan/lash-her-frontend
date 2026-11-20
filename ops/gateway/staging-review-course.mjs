import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";

export const REVIEW_COURSE_HEADER = "x-lash-staging-review-course";
const scopeFile = "/config/staging-review-course.json";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hex = /^[0-9a-f]{64}$/u;
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function reviewCourseSignature(key, { method, target, body, token, expires, nonce }) {
  return createHmac("sha256", Buffer.from(key, "hex")).update(JSON.stringify([
    "staging-review-course-v1", method, target, digest(body), digest(token), expires, nonce,
  ])).digest("hex");
}

export function reviewCourseScope(config) {
  if (config.stagingReviewCourseFile === undefined) return undefined;
  if (config.appEnv !== "staging" || config.publicHost !== "api-staging.lashher.com" ||
      config.ownerId !== "team_2Hrn5eMZyZxfAWdmYvyKi9t3" || config.projectId !== "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" ||
      !config.admission || config.stagingReviewCourseFile !== scopeFile) throw new Error("Invalid staging Course scope");
  const fd = openSync(scopeFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let scope;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 2048 || info.uid !== 0 || info.mode & 0o027) throw new Error("Invalid scope mount");
    scope = JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
  if (typeof scope.subject !== "string" || !uuid.test(scope.subject) || typeof scope.key !== "string" || !hex.test(scope.key) ||
      !Number.isSafeInteger(scope.end) || !Array.isArray(scope.lessons) || scope.lessons.length !== 2 ||
      new Set(scope.lessons).size !== 2 || !scope.lessons.every((id) => typeof id === "string" && uuid.test(id)))
    throw new Error("Invalid staging Course account binding");
  return scope;
}

export function checkReviewCourseProof(scope, { method, target, body, authorization, proof, now }, used) {
  if (!scope || typeof proof !== "string" || typeof authorization !== "string" ||
      proof.length > 120 || authorization.length > 4096 || now >= scope.end) return false;
  const fields = proof.split(".");
  if (fields.length !== 4) return false;
  const [version, stamp, nonce, signature] = fields;
  const expires = Number(stamp);
  if (version !== "1" || !/^\d{10}$/u.test(stamp) || expires <= now ||
      expires > Math.min(now + 40, scope.end) || !uuid.test(nonce) || !hex.test(signature)) return false;
  if (!scope.lessons.some((id) => {
    const lesson = `/course/v1/student/lessons/${id}`;
    return method === "GET" && [lesson, lesson + "/playback", `/course/v1/student/progress?lessonId=${id}`].includes(target) ||
      method === "POST" && target === lesson + "/progress";
  })) return false;
  const token = authorization.slice(7);
  const parts = token.split(".");
  if (!authorization.startsWith("Bearer ") || parts.length !== 3) return false;
  try {
    // The Course API checks the signed learner token and active entitlement.
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (claims.sub !== scope.subject || claims.iss !== "lash-her-frontend" ||
        claims.aud !== "lash-her-course-api:learner" || !Number.isSafeInteger(claims.exp) || claims.exp <= now) return false;
  } catch { return false; }
  const expected = reviewCourseSignature(scope.key, { method, target, body, token, expires, nonce });
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) return false;
  for (const [id, until] of used) if (until <= now) used.delete(id);
  if (used.has(nonce) || used.size >= 256) return false;
  used.set(nonce, expires);
  return true;
}
