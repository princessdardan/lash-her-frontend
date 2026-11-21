import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { reviewDiscussionsSignature, isReviewDiscussionCursor as isId } from "./staging-review-community.mjs";

export const REVIEW_NOTIFICATIONS_HEADER = "x-lash-staging-review-notifications";
export const reviewReplyBody = "Synthetic reply for the staging notification check.";
const scopeFile = "/config/staging-review-notifications.json";
const hex = /^[a-f0-9]{64}$/u;
const inbox = "/community/v1/notifications";

export function validNotificationScope(value) {
  if (!value || ![value.post, value.recipient].every(isId) || value.post === value.recipient ||
      typeof value.key !== "string" || !hex.test(value.key) ||
      typeof value.admissionSha256 !== "string" || !hex.test(value.admissionSha256) ||
      !Number.isSafeInteger(value.end)) return false;
  const keys = Object.keys(value).sort().join(",");
  if (value.mode === "recipient")
    return keys === "admissionSha256,end,key,mode,post,recipient";
  return keys === "admissionSha256,end,key,post,recipient,replier,reply" &&
    [value.replier, value.reply].every(isId) &&
    new Set([value.post, value.recipient, value.replier, value.reply]).size === 4 &&
    value.end <= Math.floor(Date.now() / 1000) + 5400;
}

export function reviewNotificationsScope(config, discussion) {
  if (config.stagingReviewNotificationsFile === undefined) return undefined;
  if (!discussion || config.stagingReviewNotificationsFile !== scopeFile || !config.admission)
    throw new Error("Invalid staging notification scope");
  const fd = openSync(scopeFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 2048 || stat.uid !== 0 || stat.mode & 0o027)
      throw new Error("Invalid staging notification mount");
    const scope = JSON.parse(readFileSync(fd, "utf8"));
    if (!validNotificationScope(scope) || discussion.subject !== scope.recipient || discussion.key === scope.key ||
        scope.end > discussion.end) throw new Error("Invalid staging notification scope");
    return scope;
  } finally { closeSync(fd); }
}

export function createReviewNotifications(scope) {
  const nonces = new Map();
  let notificationId;
  return {
    authorize({ method, target, body, authorization, proof, now, admissionSha256 }) {
      if (!scope || now >= scope.end || scope.admissionSha256 !== admissionSha256 ||
          typeof proof !== "string" || proof.length > 120 || typeof authorization !== "string" ||
          authorization.length > 4096 || !authorization.startsWith("Bearer ")) return undefined;
      const [version, stamp, nonce, signature, extra] = proof.split(".");
      const expires = Number(stamp);
      if (extra !== undefined || version !== "1" || !/^\d{10}$/u.test(stamp ?? "") || expires <= now ||
          expires > Math.min(now + 40, scope.end) || !isId(nonce) || !hex.test(signature ?? "")) return undefined;
      const token = authorization.slice(7);
      const parts = token.split(".");
      if (parts.length !== 3) return undefined;
      let principal;
      try {
        const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        if (claims.iss !== "lash-her-frontend" || claims.aud !== "lash-her-community-api:member" ||
            !Number.isSafeInteger(claims.exp) || claims.exp <= now) return undefined;
        principal = claims.sub === scope.recipient ? "recipient" :
          scope.mode !== "recipient" && claims.sub === scope.replier ? "replier" : undefined;
        if (!principal) return undefined;
        const payload = body.toString("utf8");
        const allowed = method === "GET" && target === inbox && !payload ||
          principal === "replier" && method === "POST" &&
            target === `/community/v1/discussions/${scope.post}/comments` &&
            payload === JSON.stringify({ body: reviewReplyBody, replyId: scope.reply }) ||
          principal === "recipient" && method === "PUT" && notificationId &&
            target === `${inbox}/${notificationId}/read` && payload === '{"read":true}';
        if (!allowed) return undefined;
      } catch { return undefined; }
      const expected = reviewDiscussionsSignature(scope.key, { method, target, body, token, expires, nonce });
      if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) return undefined;
      for (const [id, until] of nonces) if (until <= now) nonces.delete(id);
      if (nonces.has(nonce) || nonces.size >= 256) return undefined;
      nonces.set(nonce, expires);
      return principal;
    },
    observe(principal, method, status, contentType, body) {
      if (principal !== "recipient" || method !== "GET" || status !== 200 || contentType?.split(";", 1)[0] !== "application/json") return;
      notificationId = undefined;
      try {
        const rows = JSON.parse(body.toString("utf8")).notifications.filter(row =>
          row.postId === scope.post && row.kind === "reply" && isId(row.id));
        if (rows.length === 1) notificationId = rows[0].id;
      } catch { /* No verified notification ID to admit. */ }
    },
  };
}
