import assert from "node:assert/strict";
import test from "node:test";
import { createReviewNotifications, recipientNotificationProofKey, reviewReplyBody, validNotificationScope } from "./staging-review-notifications.mjs";
import { reviewDiscussionsSignature } from "./staging-review-community.mjs";

const ids = Array.from({ length: 6 }, (_, i) => `12345678-1234-4234-8234-12345678900${i}`);
const [recipient, replier, post, reply, notice, outsider] = ids;
const now = Math.floor(Date.now() / 1000);
const scope = { recipient, replier, post, reply, key: "a".repeat(64), end: now + 60, admissionSha256: "b".repeat(64) };
const inbox = "/community/v1/notifications";
const thread = `/community/v1/discussions/${post}/comments`;
const read = `${inbox}/${notice}/read`;
let serial = 0;

function request(principal, method, target, data) {
  const body = Buffer.from(data === undefined ? "" : JSON.stringify(data));
  const token = `jwt.${Buffer.from(JSON.stringify({ sub: principal, iss: "lash-her-frontend",
    aud: "lash-her-community-api:member", exp: now + 60 })).toString("base64url")}.test`;
  const nonce = `12345678-1234-4234-8234-${String(++serial).padStart(12, "0")}`;
  const expires = now + 30;
  return { method, target, body, authorization: "Bearer " + token, now, admissionSha256: scope.admissionSha256,
    proof: `1.${expires}.${nonce}.${reviewDiscussionsSignature(scope.key, { method, target, body, token, expires, nonce })}` };
}

test("only the exact replier, post and body may generate a reply", () => {
  const stage = createReviewNotifications(scope);
  const data = { body: reviewReplyBody, replyId: reply };
  assert.equal(stage.authorize(request(recipient, "POST", thread, data)), undefined);
  assert.equal(stage.authorize(request(outsider, "POST", thread, data)), undefined);
  assert.equal(stage.authorize(request(replier, "POST", thread.replace(post, outsider), data)), undefined);
  assert.equal(stage.authorize(request(replier, "POST", thread, { ...data, replyId: outsider })), undefined);
  const once = request(replier, "POST", thread, data);
  assert.equal(stage.authorize({ ...once, admissionSha256: outsider }), undefined);
  assert.equal(stage.authorize({ ...once, now: scope.end }), undefined);
  assert.equal(stage.authorize(once), "replier");
  assert.equal(stage.authorize(once), undefined);
  assert.equal(stage.authorize(request(replier, "POST", thread, data)), "replier");
});

test("read changes require the recipient and the API-confirmed notification for this thread", () => {
  const stage = createReviewNotifications(scope);
  const readRequest = () => request(recipient, "PUT", read, { read: true });
  assert.equal(stage.authorize(readRequest()), undefined);
  stage.observe("replier", "GET", 200, "application/json", Buffer.from(JSON.stringify({
    notifications: [{ postId: post, id: notice, kind: "reply" }],
  })));
  assert.equal(stage.authorize(readRequest()), undefined);
  assert.equal(stage.authorize(request(recipient, "GET", inbox)), "recipient");
  stage.observe("recipient", "GET", 200, "application/json", Buffer.from(JSON.stringify({
    notifications: [{ postId: post, id: notice, kind: "reply" }, { postId: outsider, id: outsider, kind: "reply" }],
  })));
  assert.equal(stage.authorize(request(replier, "PUT", read, { read: true })), undefined);
  assert.equal(stage.authorize(request(recipient, "PUT", read.replace(notice, outsider), { read: true })), undefined);
  assert.equal(stage.authorize(request(recipient, "PUT", read, { read: false })), undefined);
  assert.equal(stage.authorize(readRequest()), "recipient");
});

test("a recipient-only release cannot authorize the expired replier or create a notification", () => {
  const scoped = {
    mode: "recipient", recipient, post, key: scope.key,
    admissionSha256: scope.admissionSha256, end: scope.end,
  };
  assert.equal(validNotificationScope(scoped), true);
  assert.equal(validNotificationScope({ ...scoped, replier, reply }), false);
  const stage = createReviewNotifications(scoped);
  const data = { body: reviewReplyBody, replyId: reply };
  assert.equal(stage.authorize(request(recipient, "POST", thread, data)), undefined);
  assert.equal(stage.authorize(request(replier, "POST", thread, data)), undefined);
  assert.equal(stage.authorize(request(replier, "GET", inbox)), undefined);
  assert.equal(stage.authorize(request(undefined, "GET", inbox)), undefined);
  assert.equal(stage.authorize(request(outsider, "GET", inbox)), undefined);
  assert.equal(stage.authorize({ ...request(recipient, "GET", inbox), now: scope.end }), undefined);
  assert.equal(stage.authorize({ ...request(recipient, "GET", inbox), admissionSha256: outsider }), undefined);
  assert.equal(stage.authorize(request(recipient, "GET", inbox)), "recipient");
  stage.observe("recipient", "GET", 200, "application/json", Buffer.from(JSON.stringify({
    notifications: [{ postId: post, id: notice, kind: "reply" }],
  })));
  assert.equal(stage.authorize(request(recipient, "PUT", read, { read: false })), undefined);
  assert.equal(stage.authorize(request(recipient, "PUT", read, { read: true })), "recipient");
});

test("existing discussion credentials derive a scoped notification key without a transported key", () => {
  const config = {
    mode: "recipient", recipient, post, end: scope.end, admissionSha256: scope.admissionSha256,
  };
  const key = recipientNotificationProofKey(config, scope.key);
  assert.equal(validNotificationScope({ ...config, key }), true);
  assert.notEqual(key, scope.key);
  assert.equal(recipientNotificationProofKey({ ...config }, scope.key), key);
  assert.notEqual(recipientNotificationProofKey({ ...config, post: outsider }, scope.key), key);
  assert.equal(recipientNotificationProofKey({ ...config, key: scope.key }, scope.key), undefined);
  assert.equal(recipientNotificationProofKey({ ...config, replier }, scope.key), undefined);
  assert.equal(recipientNotificationProofKey(config, "invalid"), undefined);
});
