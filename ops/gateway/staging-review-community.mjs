import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";

export const REVIEW_DISCUSSIONS_HEADER = "x-lash-staging-review-discussions";
const scopeFile = "/config/staging-review-discussions.json";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const REVIEW_DISCUSSIONS_BODY_LIMIT = 32768;
const thread = /^\/community\/v1\/discussions\/([0-9a-f-]{36})(\/comments|\/reaction)?$/u;
const contentPath = /^\/community\/v1\/content\/([0-9a-f-]{36})$/u;
const hex = /^[0-9a-f]{64}$/u;
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function reviewDiscussionsSignature(key, { method, target, body, token, expires, nonce }) {
  return createHmac("sha256", Buffer.from(key, "hex")).update(JSON.stringify([
    "staging-review-discussions-v1", method, target, digest(body), digest(token), expires, nonce,
  ])).digest("hex");
}

export function reviewDiscussionsScope(config) {
  if (config.stagingReviewDiscussionsFile === undefined) return undefined;
  if (config.appEnv !== "staging" || config.publicHost !== "api-staging.lashher.com" ||
      config.ownerId !== "team_2Hrn5eMZyZxfAWdmYvyKi9t3" || config.projectId !== "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" ||
      !config.admission || config.stagingReviewDiscussionsFile !== scopeFile) throw new Error("Invalid staging discussion scope");
  const fd = openSync(scopeFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let scope;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 2048 || info.uid !== 0 || info.mode & 0o027) throw new Error("Invalid scope mount");
    scope = JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
  if (typeof scope.subject !== "string" || !uuid.test(scope.subject) || typeof scope.key !== "string" || !hex.test(scope.key) ||
      !Number.isSafeInteger(scope.end) || scope.course !== "e9fc3a24-e440-5a63-badc-098caab9de56")
    throw new Error("Invalid staging discussion account binding");
  return scope;
}

export function checkReviewDiscussionsProof(scope, { method, target, body, authorization, proof, now }, used) {
  if (!scope || typeof proof !== "string" || typeof authorization !== "string" ||
      proof.length > 120 || authorization.length > 4096 || now >= scope.end) return false;
  const fields = proof.split(".");
  if (fields.length !== 4) return false;
  const [version, stamp, nonce, signature] = fields;
  const expires = Number(stamp);
  if (version !== "1" || !/^\d{10}$/u.test(stamp) || expires <= now ||
      expires > Math.min(now + 40, scope.end) || !uuid.test(nonce) || !hex.test(signature)) return false;
  const create = target === `/community/v1/spaces/${scope.course}/posts`;
  const match = target.match(thread);
  const content = target.match(contentPath);
  const discussionMethod = match?.[2] === "/reaction" ? "PUT" : match?.[2] === "/comments" ? "POST" : "GET";
  const profile = target === "/community/v1/profile" && (method === "GET" || method === "PUT");
  const allowed = profile || create && method === "POST" ||
    match && uuid.test(match[1]) && method === discussionMethod ||
    content && uuid.test(content[1]) && (method === "PATCH" || method === "DELETE");
  if (!allowed) return false;
  const token = authorization.slice(7);
  const parts = token.split(".");
  if (!authorization.startsWith("Bearer ") || parts.length !== 3) return false;
  try {
    // The Community API verifies this membership token and active entitlement.
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (claims.sub !== scope.subject || claims.iss !== "lash-her-frontend" ||
        claims.aud !== "lash-her-community-api:member" || !Number.isSafeInteger(claims.exp) || claims.exp <= now) return false;
  } catch { return false; }
  const expected = reviewDiscussionsSignature(scope.key, { method, target, body, token, expires, nonce });
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) return false;
  for (const [id, until] of used) if (until <= now) used.delete(id);
  if (used.has(nonce) || used.size >= 256) return false;
  used.set(nonce, expires);
  return true;
}
