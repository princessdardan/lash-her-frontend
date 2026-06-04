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

describe("getTrainingProgramBySlug trainingContact projection", () => {
  it("includes privacyPolicyText[]{ ..., _key } inside trainingContact", () => {
    const funcStart = loadersSource.indexOf("async function getTrainingProgramBySlug");
    assert.notStrictEqual(funcStart, -1, "getTrainingProgramBySlug function should exist");

    const nextFuncStart = loadersSource.indexOf("async function", funcStart + 1);
    const funcBody = nextFuncStart === -1
      ? loadersSource.slice(funcStart)
      : loadersSource.slice(funcStart, nextFuncStart);

    const trainingContactStart = funcBody.indexOf("trainingContact{");
    assert.notStrictEqual(trainingContactStart, -1, "trainingContact projection should exist in getTrainingProgramBySlug");

    const trainingContactEnd = funcBody.indexOf("},", trainingContactStart);
    assert.notStrictEqual(trainingContactEnd, -1, "trainingContact projection should have a closing brace");

    const trainingContactBlock = funcBody.slice(trainingContactStart, trainingContactEnd + 1);
    assert.match(trainingContactBlock, /privacyPolicyText\[\]\{ \.\.\., _key \}/);
  });
});
