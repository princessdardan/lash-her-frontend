import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";

export const REVIEW_MEDIA_HEADER = "x-lash-staging-review-media";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const asset = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const assetPath = new RegExp(`^/community/v1/media/${asset}(?:/(complete|view))?$`, "u");
const listPath = new RegExp(`^/community/v1/discussions/(${asset})/media$`, "u");
const hex = /^[0-9a-f]{64}$/u;
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function reviewMediaSignature(key, { method, target, body, token, expires, nonce }) {
  return createHmac("sha256", Buffer.from(key, "hex")).update(JSON.stringify([
    "staging-review-media-v1", method, target, digest(body), digest(token), expires, nonce,
  ])).digest("hex");
}

export function reviewMediaScope(config) {
  if (!config.stagingReviewMediaFile) return undefined;
  if (config.appEnv !== "staging" || config.publicHost !== "api-staging.lashher.com" ||
      config.projectId !== "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" || !config.admission ||
      config.stagingReviewMediaFile !== "/config/staging-review-media.json") throw new Error("Invalid staging media scope");
  const fd = openSync(config.stagingReviewMediaFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let scope;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 2048 || info.uid !== 0 || info.mode & 0o027) throw new Error();
    scope = JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
  if (!uuid.test(scope.subject) || !uuid.test(scope.post) || !hex.test(scope.key) || !Number.isSafeInteger(scope.end))
    throw new Error("Invalid staging media account binding");
  return { ...scope, ownedPosts: config.stagingReviewMediaOwnedPosts === true };
}

export function checkReviewMediaProof(scope, { method, target, body, authorization, proof, now }, used) {
  if (!scope || typeof proof !== "string" || typeof authorization !== "string" ||
      proof.length > 120 || authorization.length > 4096 || now >= scope.end) return false;
  const fields = proof.split(".");
  if (fields.length !== 4) return false;
  const [version, stamp, nonce, signature] = fields;
  const expires = Number(stamp);
  if (version !== "1" || !/^\d{10}$/u.test(stamp) || expires <= now ||
      expires > Math.min(now + 40, scope.end) || !uuid.test(nonce) || !hex.test(signature)) return false;
  // For additional posts, the staging frontend verifies course and ownership before signing.
  const list = target === `/community/v1/discussions/${scope.post}/media` ||
    scope.ownedPosts === true && listPath.test(target);
  const match = target.match(assetPath);
  if (list ? method !== "GET" && method !== "POST" :
      !match || method !== (match[1] === "complete" ? "POST" : match[1] === "view" ? "GET" : "DELETE")) return false;
  const token = authorization.slice(7);
  const parts = token.split(".");
  if (!authorization.startsWith("Bearer ") || parts.length !== 3) return false;
  try {
    // The Community API verifies this token's signature and resource authority.
    // The scoped proof binds the full token, including its signature, to this request.
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (claims.sub !== scope.subject || claims.iss !== "lash-her-frontend" ||
        claims.aud !== "lash-her-community-api:member" || !Number.isSafeInteger(claims.exp) || claims.exp <= now) return false;
  } catch { return false; }
  const expected = reviewMediaSignature(scope.key, { method, target, body, token, expires, nonce });
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) return false;
  for (const [id, until] of used) if (until <= now) used.delete(id);
  if (used.has(nonce) || used.size >= 256) return false;
  used.set(nonce, expires);
  return true;
}
