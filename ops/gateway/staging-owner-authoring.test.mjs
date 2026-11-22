import assert from "node:assert/strict";
import test from "node:test";
import {
  createOwnerAuthoringSequence,
  ownerAuthoringSignature,
} from "./staging-owner-authoring.mjs";
import fixture from "./staging-owner-authoring-fixture.json" with { type: "json" };

const now = 1_795_300_000;
const scope = { key: "a".repeat(64), end: now + 60, admissionSha256: "c".repeat(64) };
const ids = Array.from({ length: 5 }, (_, i) => `12345678-1234-4234-8234-12345678900${i}`);
const [owner, courseId, moduleId, lessonId, foreignId] = ids;
const courses = "/course/v1/admin/courses";
const steps = [
  ["POST", courses, fixture.course, 201, { course: { ...fixture.course, id: courseId, revision: 1, modules: [] } }],
  ["POST", `${courses}/${courseId}/modules`, fixture.module, 201, { module: { ...fixture.module, id: moduleId, courseId } }],
  ["POST", `/course/v1/admin/modules/${moduleId}/lessons`, fixture.lesson, 201, { lesson: { ...fixture.lesson, id: lessonId, moduleId } }],
  ["PATCH", `/course/v1/admin/lessons/${lessonId}`, fixture.edit, 200, { lesson: { ...fixture.edit, id: lessonId, moduleId } }],
];
const bytes = (value) => Buffer.from(JSON.stringify(value));
function signed(method, target, input, sub = owner) {
  const token = `jwt.${bytes({ sub, iss: "lash-her-frontend", aud: "lash-her-course-api:admin",
    capabilities: ["course-editor"], exp: now + 45 }).toString("base64url")}.test`;
  const body = bytes(input), expires = now + 30, nonce = foreignId;
  return { method, target, body, authorization: "Bearer " + token, now, admissionSha256: scope.admissionSha256,
    proof: `1.${expires}.${nonce}.${ownerAuthoringSignature(scope.key, { method, target, body, token, expires, nonce })}` };
}

test("only the selected draft and its returned IDs can advance the four-step sequence", () => {
  const sequence = createOwnerAuthoringSequence(scope);
  for (const [method, path, body, status, receipt] of steps) {
    const request = signed(method, path, body);
    assert.equal(sequence.reserve({ ...request, proof: undefined }), false);
    assert.equal(sequence.reserve({ ...request, admissionSha256: "d".repeat(64) }), false);
    assert.equal(sequence.reserve({ ...request, now: scope.end }), false);
    assert.equal(sequence.reserve(signed(method, path, { ...body, status: "published" })), false);
    if (path !== courses) {
      assert.equal(sequence.reserve(signed(method, path.replace(/12345678-[^/]+/u, foreignId), body)), false);
      assert.equal(sequence.reserve(signed(method, path, body, foreignId)), false);
    }
    assert.equal(sequence.reserve(request), true);
    assert.equal(sequence.reserve(request), false);
    assert.equal(sequence.acknowledge(status, "application/json; charset=utf-8", bytes(receipt)), true);
    assert.equal(sequence.reserve(request), false);
  }
  assert.equal(sequence.reserve(signed("POST", courses, fixture.course)), false);
});

test("a mismatched acknowledgement freezes scoped admission", () => {
  const sequence = createOwnerAuthoringSequence(scope);
  const [method, path, body] = steps[0];
  const request = signed(method, path, body);
  assert.equal(sequence.reserve(request), true);
  assert.equal(sequence.acknowledge(201, "application/json", bytes({ course: { id: foreignId } })), false);
  assert.equal(sequence.reserve(request), false);
  assert.equal(sequence.reserve(signed(...steps[1].slice(0, 3))), false);
});
