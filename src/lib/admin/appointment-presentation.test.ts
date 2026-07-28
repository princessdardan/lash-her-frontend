import assert from "node:assert/strict";
import test from "node:test";

import { toAdminAppointmentSnapshotPresentation } from "./appointment-presentation";

test("appointment snapshot presentation removes Square attribution identifiers recursively", () => {
  const result = toAdminAppointmentSnapshotPresentation({
    intake: {
      answers: [
        {
          square_team_member_id: "team-intake",
          value: "Keep this answer",
        },
      ],
    },
    offering: {
      displayTitle: "Classic full set",
      metadata: { teamMemberId: "team-offering" },
    },
    provider: {
      displayName: "Ava",
      providerKey: "ava",
      squareTeamMemberId: "team-provider",
    },
  });

  assert.deepEqual(result, {
    intake: {
      answers: [{ value: "Keep this answer" }],
    },
    offering: {
      displayTitle: "Classic full set",
      metadata: {},
    },
    provider: {
      displayName: "Ava",
      providerKey: "ava",
    },
  });
});

test("appointment snapshot presentation preserves similarly named public fields", () => {
  const result = toAdminAppointmentSnapshotPresentation({
    intake: null,
    offering: { teamMemberDisplayLabel: "Ava" },
    provider: {
      providerId: "provider-1",
      squareTeamMemberStatus: "active",
    },
  });

  assert.deepEqual(result, {
    intake: null,
    offering: { teamMemberDisplayLabel: "Ava" },
    provider: {
      providerId: "provider-1",
      squareTeamMemberStatus: "active",
    },
  });
});
