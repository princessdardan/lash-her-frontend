import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import fixture from "./staging-owner-authoring-fixture.json" with { type: "json" };

export const OWNER_AUTHORING_HEADER = "x-lash-staging-owner-authoring";
const scopeFile = "/config/staging-owner-authoring.json";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hex = /^[0-9a-f]{64}$/u;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const phases = [
  { method: "POST", route: "/v1/admin/courses", fixture: "course", result: "course", status: 201 },
  { method: "POST", route: "/v1/admin/courses/{courseId}/modules", fixture: "module", result: "module", status: 201 },
  { method: "POST", route: "/v1/admin/modules/{moduleId}/lessons", fixture: "lesson", result: "lesson", status: 201 },
  { method: "PATCH", route: "/v1/admin/lessons/{lessonId}", fixture: "edit", result: "lesson", status: 200 },
];

export function ownerAuthoringSignature(key, { method, target, body, token, expires, nonce }) {
  return createHmac("sha256", Buffer.from(key, "hex")).update(JSON.stringify([
    "staging-owner-authoring-v1", method, target, digest(body), digest(token), expires, nonce,
  ])).digest("hex");
}

export function ownerAuthoringPhase(method, route, body) {
  return phases.findIndex(phase =>
    phase.method === method && phase.route === route && isDeepStrictEqual(body, fixture[phase.fixture]));
}

export function readOwnerAuthoringScope(config) {
  if (config.stagingOwnerAuthoringFile === undefined) return undefined;
  if (config.appEnv !== "staging" || config.publicHost !== "api-staging.lashher.com" ||
      config.ownerId !== "team_2Hrn5eMZyZxfAWdmYvyKi9t3" || config.projectId !== "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" ||
      !config.admission || config.stagingOwnerAuthoringFile !== scopeFile) throw new Error("Invalid staging owner scope");
  const fd = openSync(scopeFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 1024 || info.uid !== 0 || info.mode & 0o027) throw new Error("Invalid scope mount");
    const scope = JSON.parse(readFileSync(fd, "utf8"));
    if (Object.keys(scope).sort().join(",") !== "admissionSha256,end,key" ||
        typeof scope.key !== "string" || !hex.test(scope.key) ||
        typeof scope.admissionSha256 !== "string" || !hex.test(scope.admissionSha256) ||
        !Number.isSafeInteger(scope.end) || scope.end > Math.floor(Date.now() / 1000) + 5400)
      throw new Error("Invalid staging owner scope");
    return scope;
  } finally { closeSync(fd); }
}

// Advance only on a matching receiver acknowledgement. An interrupted or
// uncertain write freezes the sequence, and a restart can only try the unique
// slug again. It cannot grant access to an existing course by ID.
export function createOwnerAuthoringSequence(scope) {
  let phaseIndex = 0;
  let pending = false;
  let subject;
  const ids = {};
  return {
    reserve({ method, target, body, authorization, proof, now, admissionSha256 }) {
      const phase = phases[phaseIndex];
      if (!scope || !phase || pending || admissionSha256 !== scope.admissionSha256 || now >= scope.end ||
          typeof proof !== "string" || proof.length > 120 || typeof authorization !== "string" ||
          !authorization.startsWith("Bearer ") || authorization.length > 4096) return false;
      const path = phase.route.replace(/\{(course|module|lesson)Id\}/u, (_match, resource) => ids[resource]);
      if (method !== phase.method || target !== "/course" + path) return false;
      const [version, stamp, nonce, signature, extra] = proof.split(".");
      const expires = Number(stamp);
      if (extra !== undefined || version !== "1" || !/^\d{10}$/u.test(stamp) || expires <= now ||
          expires > Math.min(now + 40, scope.end) || !uuid.test(nonce) || !hex.test(signature)) return false;
      const token = authorization.slice(7);
      const parts = token.split(".");
      if (parts.length !== 3) return false;
      let claims;
      try {
        // Course verifies the admin JWT. The proof binds its exact bytes to
        // the frontend's verified owner session and reviewed draft payload.
        claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        if (!isDeepStrictEqual(JSON.parse(body.toString("utf8")), fixture[phase.fixture]) ||
            !uuid.test(claims.sub) || (subject && claims.sub !== subject) ||
            claims.iss !== "lash-her-frontend" || claims.aud !== "lash-her-course-api:admin" ||
            !Array.isArray(claims.capabilities) || !claims.capabilities.includes("course-editor") || !Number.isSafeInteger(claims.exp) || claims.exp <= now) return false;
      } catch { return false; }
      const expected = ownerAuthoringSignature(scope.key, { method, target, body, token, expires, nonce });
      if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) return false;
      subject ??= claims.sub;
      pending = true;
      return true;
    },

    acknowledge(status, contentType, bytes) {
      const phase = phases[phaseIndex];
      if (!phase || !pending || status !== phase.status || contentType?.split(";", 1)[0] !== "application/json") return false;
      try {
        const row = JSON.parse(bytes.toString("utf8"))[phase.result];
        const input = fixture[phase.fixture];
        if (!uuid.test(row.id) || row.slug !== input.slug || row.title !== input.title) return false;
        if (phase.fixture === "course" && (row.status !== "draft" || row.revision !== 1 || row.modules?.length !== 0)) return false;
        if (phase.fixture === "module" && (row.courseId !== ids.course || row.position !== input.position)) return false;
        if (phase.result === "lesson" && (row.moduleId !== ids.module || row.isPreview !== false ||
            row.transcript !== input.transcript || row.position !== input.position ||
            (phase.fixture === "edit" && row.id !== ids.lesson))) return false;
        ids[phase.result] = row.id;
        phaseIndex++;
        pending = false;
        return true;
      } catch { return false; }
    },
  };
}
