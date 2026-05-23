import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const typesSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("training program Appointment Schedule types", () => {
  it("keeps public Google Appointment Schedule fields optional on TTrainingProgram", () => {
    assert.match(typesSource, /introCallAppointmentScheduleUrl\?: string;/);
    assert.match(typesSource, /introCallAppointmentScheduleEmbedMode\?: "link" \| "embed";/);
    assert.match(typesSource, /introCallSchedulingInstructions\?: string;/);
  });
});
