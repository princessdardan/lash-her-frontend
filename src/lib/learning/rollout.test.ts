import assert from "node:assert/strict";
import test from "node:test";
import { learningRoutesEnabled } from "./rollout";
import { INTEGRATION_ROLLOUT_FLAGS } from "@/lib/api-integration/rollout-flags";

test("new learning routes require both explicit migration switch and independently enabled Course reads", t => {
  const names = ["INTEGRATION_LEARNING_ROUTES_ENABLED", "INTEGRATION_COURSE_READS_ENABLED"];
  const saved = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; }));
  for (const migration of [undefined, "false", "TRUE", " true", "true"]) for (const reads of [undefined, "false", "true"]) {
    process.env.INTEGRATION_LEARNING_ROUTES_ENABLED = migration; process.env.INTEGRATION_COURSE_READS_ENABLED = reads;
    assert.equal(learningRoutesEnabled(), migration === "true" && reads === "true");
  }
  assert.equal(Object.keys(INTEGRATION_ROLLOUT_FLAGS).length, 6, "presentation switch does not collapse the six independent controls");
});
