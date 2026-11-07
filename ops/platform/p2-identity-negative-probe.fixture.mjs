// Synthetic owned test data only; never imported by the deployed observer.
import { createHash } from "node:crypto";
import { PROFILES } from "./p2-identity-negative-probe.mjs";

export const hashFixture = value => createHash("sha256").update(value).digest("hex");
export function identityProbeFixture(mode = "course-http") {
  const names = Object.keys(PROFILES);
  return { version: 1, mode, environment: "staging", bindingSha256: "a".repeat(64),
    subjects: { learnerA: "11111111-1111-4111-8111-111111111111", learnerB: "22222222-2222-4222-8222-222222222222", admin: "33333333-3333-4333-8333-333333333333" },
    resources: { courseA: "44444444-4444-4444-8444-444444444444", courseB: "55555555-5555-4555-8555-555555555555",
      sharedCourse: "66666666-6666-4666-8666-666666666666", lesson: "77777777-7777-4777-8777-777777777777", completedAttempt: "88888888-8888-4888-8888-888888888888" },
    keys: Object.fromEntries(names.map((name, index) => [name, { current: "owned-current-" + String(index).repeat(48), previous: "owned-previous-" + String(index).repeat(48) }])),
    serviceKeys: ["owned-service-" + "s".repeat(48)], previousProfiles: names.sort(), httpCheck: null, runtimeEnvironment: null,
    gatewayConfigurationSha256: "b".repeat(64), gatewayCaSha256: "c".repeat(64) };
}
