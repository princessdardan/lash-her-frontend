import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const loadersSource = readFileSync(new URL("./loaders.ts", import.meta.url), "utf8");

describe("training program loader Appointment Schedule projection", () => {
  it("projects public Google Appointment Schedule fields for training program pages", () => {
    assert.match(loadersSource, /introCallAppointmentScheduleUrl/);
    assert.match(loadersSource, /"introCallAppointmentScheduleEmbedMode": coalesce\(introCallAppointmentScheduleEmbedMode, "link"\)/);
    assert.match(loadersSource, /introCallSchedulingInstructions/);
  });

  it("does not project private scheduling token or payment state fields from Sanity", () => {
    assert.doesNotMatch(loadersSource, /schedulingTokenHash/);
    assert.doesNotMatch(loadersSource, /tokenExpiresAt/);
    assert.doesNotMatch(loadersSource, /tokenUsedAt/);
    assert.doesNotMatch(loadersSource, /checkoutEmail/);
  });
});
