import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  getServiceBookingModelMode,
  permitsLegacyBookingCreation,
  permitsOperationalBookingCreation,
} from "./model-mode";

test("booking model rollout defaults to dual compatibility", () => {
  assert.equal(getServiceBookingModelMode({}), "dual");
  assert.equal(permitsLegacyBookingCreation("dual"), true);
  assert.equal(permitsOperationalBookingCreation("dual"), true);
});

test("operational cutover disables only new legacy booking creation", () => {
  assert.equal(
    getServiceBookingModelMode({ SERVICE_BOOKING_MODEL_MODE: " operational " }),
    "operational",
  );
  assert.equal(permitsLegacyBookingCreation("operational"), false);
  assert.equal(permitsOperationalBookingCreation("operational"), true);
});

test("invalid booking model rollout values fail closed", () => {
  assert.throws(
    () =>
      getServiceBookingModelMode({ SERVICE_BOOKING_MODEL_MODE: "automatic" }),
    /must be legacy, dual, or operational/,
  );
});

test("booking model rollout is documented as a server-only environment value", () => {
  const exampleEnv = readFileSync(
    new URL("../../../../.env.local.example", import.meta.url),
    "utf8",
  );

  assert.match(exampleEnv, /^SERVICE_BOOKING_MODEL_MODE=dual$/m);
  assert.doesNotMatch(exampleEnv, /NEXT_PUBLIC_SERVICE_BOOKING_MODEL_MODE/);
});
