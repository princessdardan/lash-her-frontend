import assert from "node:assert/strict";
import test from "node:test";

import { legacyPracticeProgress } from "./legacy-progress-transfer";

const grant = { courseId: "sanity-course", grantId: "legacy-grant", expiresAt: 2000 };
const now = 1000;

test("selects only bounded video and submitted practice answers from the matching grant", () => {
  const raw = JSON.stringify({
    version: 1, grantId: grant.grantId, expiresAt: grant.expiresAt,
    userId: "unused",
    modules: {
      m1: { videoId: "sanity-video", position: 12.8, submitted: true, answers: { q1: "a1" }, completed: false },
      m2: { videoId: "sanity-video", position: -1, submitted: false, answers: { q1: "a1" }, completed: true },
    },
  });
  assert.deepEqual(legacyPracticeProgress(raw, grant, now), {
    sourceId: "sanity-course",
    modules: [{ key: "m1", video: { id: "sanity-video", positionSeconds: 12 }, answers: [{ questionKey: "q1", optionKey: "a1" }] }],
  });
  assert.equal(legacyPracticeProgress(raw, { ...grant, grantId: "other" }, now), null);
  assert.equal(legacyPracticeProgress(raw, grant, grant.expiresAt * 1000), null);
  assert.equal(legacyPracticeProgress("{", grant, now), null);
  assert.equal(legacyPracticeProgress(null, grant, now), null);
});
